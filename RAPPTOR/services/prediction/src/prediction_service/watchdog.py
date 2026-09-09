"""Stop jobs only when their child dies or useful work stops advancing."""

from __future__ import annotations

import time

from rq import Queue
from rq.command import send_stop_job_command
from rq.job import Job
from rq.registry import StartedJobRegistry

from .config import SETTINGS
from .queue_eta import process_heartbeat_key


def health_failure(meta: dict, *, process_alive: bool, now: float, heartbeat_ttl: int, stall_timeout: int):
    eta = meta.get("queue_eta") or {}
    try:
        started_at = float(eta["started_at"])
        last_progress_at = float(eta["last_progress_at"])
    except (KeyError, TypeError, ValueError):
        return None
    if not process_alive and now - started_at > heartbeat_ttl:
        return "JOB_PROCESS_HEARTBEAT_LOST", "Prediction process heartbeat was lost."
    if now - last_progress_at > stall_timeout:
        return "JOB_PROGRESS_STALLED", f"Prediction made no progress for {stall_timeout} seconds."
    return None


def remove_legacy_timeouts(queue: Queue) -> int:
    """Disable the former wall-clock timeout on jobs that have not started."""
    changed = 0
    for job in queue.get_jobs():
        if job.timeout != -1:
            job.timeout = -1
            job.save()
            changed += 1
    return changed


def watch_jobs(connection, queue_name: str, stop, *, exit_on_failure=False, exit_func=None) -> None:
    interval = min(10, SETTINGS.worker_heartbeat_interval)
    while not stop.is_set():
        now = time.time()
        try:
            job_ids = StartedJobRegistry(name=queue_name, connection=connection).get_job_ids()
            jobs = [job for job in Job.fetch_many(job_ids, connection=connection) if job is not None]
        except Exception:
            jobs = []
        for job in jobs:
            if (job.meta.get("queue_eta") or {}).get("watchdog_stop_requested_at"):
                continue
            try:
                failure = health_failure(
                    job.meta,
                    process_alive=bool(connection.exists(process_heartbeat_key(job.id))),
                    now=now,
                    heartbeat_ttl=SETTINGS.worker_heartbeat_ttl,
                    stall_timeout=SETTINGS.job_stall_timeout_seconds,
                )
            except Exception:
                continue
            if failure is None:
                continue
            code, message = failure
            try:
                eta = dict(job.meta.get("queue_eta") or {})
                eta["watchdog_stop_requested_at"] = now
                job.meta["queue_eta"] = eta
                from .jobs import mark_job_failed_externally
                mark_job_failed_externally(job, code, message)
                if exit_on_failure:
                    exit_func(70)
                else:
                    send_stop_job_command(connection, job.id)
            except Exception:
                continue
        stop.wait(interval)
