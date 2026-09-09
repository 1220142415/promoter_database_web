"""Opt-in worker regression: use an isolated Redis, never the production queue."""
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid


def cgr_tensor_operation():
    """This operation deadlocks after fork when model preload started CPU threads."""
    import os
    import torch
    from prediction_service.runtime import get_runtime

    value = torch.log1p(torch.ones((1, 128, 128)))
    return {
        "shape": list(value.shape),
        "finite": bool(torch.isfinite(value).all()),
        "pid": os.getpid(),
        "runtime_id": id(get_runtime()),
    }


@unittest.skipUnless(os.getenv("RAPPTOR_TEST_REDIS_URL") and importlib.util.find_spec("torch"), "Requires PyTorch, model assets, and an isolated RAPPTOR_TEST_REDIS_URL")
class WorkerProcessTests(unittest.TestCase):
    def test_preloaded_worker_executes_cpu_tensor_job(self):
        from redis import Redis
        from rq import Queue, Worker

        connection = Redis.from_url(os.environ["RAPPTOR_TEST_REDIS_URL"])
        connection.ping()
        queue_name = "worker-process-test-" + uuid.uuid4().hex
        queue = Queue(queue_name, connection=connection)
        with tempfile.TemporaryDirectory() as directory:
            env = {
                **os.environ,
                "RAPPTOR_REDIS_URL": os.environ["RAPPTOR_TEST_REDIS_URL"],
                "RAPPTOR_QUEUE": queue_name,
                "RAPPTOR_PREDICT_QUEUE": queue_name,
                "RAPPTOR_SCAN_QUEUE": queue_name + "-scan",
                "RAPPTOR_DEVICE": "cpu",
                "RAPPTOR_DATA_ROOT": directory,
                "RAPPTOR_FILE_RETENTION_SECONDS": "0",
                "RAPPTOR_JOB_CALLBACK_URL": "",
                "RAPPTOR_JOB_CALLBACK_SECRET": "",
                "OMP_NUM_THREADS": "28",
                "MKL_NUM_THREADS": "28",
                "OPENBLAS_NUM_THREADS": "28",
                "PYTHONPATH": str(Path(__file__).parent) + os.pathsep + os.environ.get("PYTHONPATH", ""),
            }
            with (Path(directory) / "worker.log").open("w+") as log:
                process = subprocess.Popen([sys.executable, "-m", "prediction_service.worker"], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                jobs = []
                try:
                    deadline = time.monotonic() + 30
                    while time.monotonic() < deadline:
                        self.assertIsNone(process.poll(), "Worker exited before becoming ready")
                        if any(queue_name in worker.queue_names() for worker in Worker.all(connection=connection)):
                            break
                        time.sleep(0.1)
                    else:
                        self.fail("Worker did not become ready after loading its model")
                    for _ in range(2):
                        job = queue.enqueue(cgr_tensor_operation, job_timeout=15, result_ttl=60)
                        jobs.append(job)
                        deadline = time.monotonic() + 20
                        while time.monotonic() < deadline:
                            status = str(job.get_status(refresh=True)).lower()
                            if status.endswith(("finished", "failed", "stopped")):
                                break
                            time.sleep(0.1)
                        self.assertTrue(str(job.get_status(refresh=True)).lower().endswith("finished"), "CPU tensor job did not finish; check fork/thread-pool deadlock")
                    results = [job.return_value() for job in jobs]
                    self.assertTrue(all(result["shape"] == [1, 128, 128] and result["finite"] for result in results))
                    self.assertEqual(results[0]["pid"], results[1]["pid"])
                    self.assertEqual(results[0]["runtime_id"], results[1]["runtime_id"])
                finally:
                    # Terminate only the isolated worker after its job finishes.
                    process.terminate()
                    try:
                        process.wait(timeout=30)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=5)
                    for job in jobs:
                        job.delete()
                    queue.delete()


if __name__ == "__main__":
    unittest.main(verbosity=2)
