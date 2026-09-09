from types import SimpleNamespace

from rq.worker import SimpleWorker, SpawnWorker

from prediction_service import runtime, worker


def test_predict_worker_is_persistent_but_scan_worker_still_spawns(monkeypatch):
    monkeypatch.setattr(worker, "SETTINGS", SimpleNamespace(
        predict_queue_name="prediction:predict", scan_queue_name="prediction:genome_scan",
    ))
    assert worker.worker_class_for_queue("prediction:predict") == (SimpleWorker, True)
    assert worker.worker_class_for_queue("prediction:genome_scan") == (SpawnWorker, False)


def test_model_runtime_singleton_loads_once(monkeypatch):
    instances = []
    monkeypatch.setattr(runtime, "_RUNTIME", None)
    monkeypatch.setattr(runtime, "ModelRuntime", lambda *args: instances.append(object()) or instances[-1])

    first = runtime.get_runtime()
    second = runtime.get_runtime()

    assert first is second
    assert len(instances) == 1
