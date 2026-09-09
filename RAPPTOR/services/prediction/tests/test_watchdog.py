import fakeredis
from rq import Queue

from prediction_service.jobs import _failed_progress
from prediction_service.watchdog import health_failure, remove_legacy_timeouts
from prediction_service import jobs, watchdog


def test_live_process_with_recent_progress_is_healthy():
    meta = {"queue_eta": {"started_at": 100.0, "last_progress_at": 150.0}}
    assert health_failure(
        meta, process_alive=True, now=160.0, heartbeat_ttl=30, stall_timeout=60,
    ) is None


def test_process_heartbeat_loss_is_distinct_from_progress_stall():
    meta = {"queue_eta": {"started_at": 100.0, "last_progress_at": 150.0}}
    assert health_failure(
        meta, process_alive=False, now=160.0, heartbeat_ttl=30, stall_timeout=60,
    ) == ("JOB_PROCESS_HEARTBEAT_LOST", "Prediction process heartbeat was lost.")


def test_live_but_stalled_process_is_rejected():
    meta = {"queue_eta": {"started_at": 100.0, "last_progress_at": 120.0}}
    assert health_failure(
        meta, process_alive=True, now=181.0, heartbeat_ttl=30, stall_timeout=60,
    ) == ("JOB_PROGRESS_STALLED", "Prediction made no progress for 60 seconds.")


def test_worker_startup_removes_old_queued_wall_clock_timeouts():
    connection = fakeredis.FakeRedis()
    queue = Queue("prediction:test", connection=connection, is_async=True)
    old = queue.enqueue(len, "ACGT", job_timeout=3600)
    current = queue.enqueue(len, "ACGT", job_timeout=-1)

    assert remove_legacy_timeouts(queue) == 1
    old.refresh()
    current.refresh()
    assert old.timeout == current.timeout == -1


def test_failure_keeps_last_valid_progress_below_completion():
    progress = _failed_progress({"stage": "scanning", "percent": 42.5, "windows": 100})
    assert progress["stage"] == "failed"
    assert progress["percent"] == 42.5
    assert progress["last_valid_progress"] == {
        "stage": "scanning", "percent": 42.5, "windows": 100,
    }
    assert _failed_progress({"stage": "complete", "percent": 100.0})["percent"] == 99.9


def test_persistent_worker_watchdog_records_failure_then_exits_container(monkeypatch):
    job = type("Job", (), {"id": "a" * 32, "meta": {}})()
    stopped = type("Stop", (), {"is_set": lambda self: False, "wait": lambda self, _: setattr(self, "is_set", lambda: True)})()
    exits = []
    failures = []
    monkeypatch.setattr(watchdog, "StartedJobRegistry", lambda **kwargs: type("Registry", (), {"get_job_ids": lambda self: [job.id]})())
    monkeypatch.setattr(watchdog.Job, "fetch_many", lambda ids, connection: [job])
    monkeypatch.setattr(watchdog, "health_failure", lambda *args, **kwargs: ("JOB_PROGRESS_STALLED", "stalled"))
    monkeypatch.setattr(jobs, "mark_job_failed_externally", lambda current, code, message: failures.append((current.id, code, message)))
    connection = type("Connection", (), {"exists": lambda self, key: True})()

    watchdog.watch_jobs(
        connection, "prediction:predict", stopped,
        exit_on_failure=True, exit_func=exits.append,
    )

    assert failures == [(job.id, "JOB_PROGRESS_STALLED", "stalled")]
    assert exits == [70]
