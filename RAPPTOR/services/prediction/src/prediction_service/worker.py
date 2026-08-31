from __future__ import annotations

import os
import socket
import threading
import time

from rq import Queue
from rq.worker import SimpleWorker

from .callbacks import flush_pending_job_events
from .config import SETTINGS
from .cleanup import purge_expired_jobs
from .queueing import get_redis_connection
from .runtime import preload_runtime


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


def main() -> None:
    connection = get_redis_connection()
    connection.ping()
    runtime = preload_runtime()
    hostname = socket.gethostname()
    key = f"rapptor:worker:{hostname}:{os.getpid()}:ready"
    stop = threading.Event()
    thread = threading.Thread(target=_heartbeat, args=(connection, key, stop), daemon=True)
    thread.start()
    cleanup_thread = threading.Thread(target=_cleanup, args=(stop,), daemon=True)
    cleanup_thread.start()
    callback_thread = threading.Thread(target=_callbacks, args=(stop,), daemon=True)
    callback_thread.start()
    print({"status": "worker_ready", **runtime.metadata()}, flush=True)
    try:
        worker = SimpleWorker([Queue(SETTINGS.queue_name, connection=connection)], connection=connection)
        worker.work(with_scheduler=False)
    finally:
        stop.set()
        thread.join(timeout=2)
        cleanup_thread.join(timeout=2)
        callback_thread.join(timeout=2)
        try:
            connection.delete(key)
        except Exception:
            pass


if __name__ == "__main__":
    main()
