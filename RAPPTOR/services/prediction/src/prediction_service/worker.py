from __future__ import annotations

import os
import socket
import threading
import time

from rq import Queue
from rq.worker import SimpleWorker, SpawnWorker

from .callbacks import flush_pending_job_events
from .config import SETTINGS
from .cleanup import purge_expired_jobs
from .queueing import get_redis_connection
from .runtime import preload_runtime
from .watchdog import remove_legacy_timeouts, watch_jobs


def _heartbeat(connection, key: str, stop: threading.Event) -> None:
    while not stop.is_set():
        payload = f"ready|{SETTINGS.model_version}|{SETTINGS.device}|{int(time.time())}"
        try:
            connection.set(key, payload, ex=SETTINGS.worker_heartbeat_ttl)
        except Exception:
            pass
        stop.wait(SETTINGS.worker_heartbeat_interval)


def _cleanup(stop: threading.Event) -> None:
    if not SETTINGS.file_retention_seconds:
        return
    while not stop.is_set():
        purge_expired_jobs(SETTINGS.data_root)
        stop.wait(min(3600, max(60, SETTINGS.file_retention_seconds // 4)))


def _callbacks(stop: threading.Event) -> None:
    while not stop.is_set():
        try:
            flush_pending_job_events(SETTINGS.data_root)
        except Exception:
            pass
        stop.wait(60)


def worker_class_for_queue(queue_name: str):
    persistent_predict = (
        queue_name == SETTINGS.predict_queue_name
        and SETTINGS.predict_queue_name != SETTINGS.scan_queue_name
    )
    return (SimpleWorker if persistent_predict else SpawnWorker), persistent_predict


def main() -> None:
    connection = get_redis_connection()
    connection.ping()
    model_started = time.monotonic()
    runtime = preload_runtime()
    model_load_ms = round((time.monotonic() - model_started) * 1000, 1)
    hostname = socket.gethostname()
    key = f"rapptor:worker:{SETTINGS.queue_name}:{hostname}:{os.getpid()}:ready"
    stop = threading.Event()
    queue = Queue(SETTINGS.queue_name, connection=connection, default_timeout=-1)
    updated_timeouts = remove_legacy_timeouts(queue)
    worker_class, persistent_predict = worker_class_for_queue(SETTINGS.queue_name)
    threads = [
        threading.Thread(target=_heartbeat, args=(connection, key, stop), daemon=True),
        threading.Thread(
            target=watch_jobs,
            args=(connection, SETTINGS.queue_name, stop),
            kwargs={"exit_on_failure": persistent_predict, "exit_func": os._exit},
            daemon=True,
        ),
    ]
    if SETTINGS.worker_maintenance:
        threads.extend([
            threading.Thread(target=_cleanup, args=(stop,), daemon=True),
            threading.Thread(target=_callbacks, args=(stop,), daemon=True),
        ])
    for thread in threads:
        thread.start()
    print({
        "status": "worker_ready",
        "worker_type": "persistent_predict" if persistent_predict else "spawn",
        "model_load_ms": model_load_ms,
        "legacy_timeouts_removed": updated_timeouts,
        **runtime.metadata(),
    }, flush=True)
    try:
        # Predict stays in this preloaded process; scans retain fresh child isolation.
        worker = worker_class([queue], connection=connection)
        worker.work(with_scheduler=False)
    finally:
        stop.set()
        for thread in threads:
            thread.join(timeout=2)
        try:
            connection.delete(key)
        except Exception:
            pass


if __name__ == "__main__":
    main()
