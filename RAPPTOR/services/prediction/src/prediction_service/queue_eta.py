"""Small Redis-backed queue wait estimator using observed worker throughput."""

from __future__ import annotations

import json
import math
import statistics
import time

from rq.job import Job
from rq.registry import StartedJobRegistry


SAMPLE_WINDOW_SECONDS = 120.0
MIN_SAMPLE_SECONDS = 5.0
MAX_PROGRESS_AGE_SECONDS = 30.0
PROFILE_MAX_AGE_SECONDS = 600.0
PROFILE_LIMIT = 8


def record_progress(
    meta: dict, stage: str, windows: int | None = None, *,
    percent: float | None = None, now: float | None = None,
) -> None:
    """Update bounded ETA telemetry in job metadata; the caller persists meta."""
    now = time.time() if now is None else float(now)
    eta = dict(meta.get("queue_eta") or {})
    eta.setdefault("started_at", now)
    previous_stage = eta.get("last_stage")
    previous_windows = eta.get("last_windows")
    previous_percent = eta.get("last_percent")
    advanced = (
        previous_stage != stage
        or (isinstance(windows, int) and (not isinstance(previous_windows, int) or windows > previous_windows))
        or (
            isinstance(percent, (int, float))
            and (not isinstance(previous_percent, (int, float)) or percent > previous_percent)
        )
    )
    if advanced:
        eta["last_progress_at"] = now
    eta["last_stage"] = stage
    if isinstance(windows, int):
        eta["last_windows"] = windows
    if isinstance(percent, (int, float)):
        eta["last_percent"] = float(percent)
    if stage in {"inference", "scanning"}:
        eta.setdefault("inference_started_at", now)
    if stage == "writing_outputs":
        eta.setdefault("inference_finished_at", now)
    if stage == "complete":
        eta["completed_at"] = now

    if isinstance(windows, int) and windows >= 0:
        samples = [
            item for item in eta.get("samples", [])
            if isinstance(item, list) and len(item) == 2 and now - float(item[0]) <= SAMPLE_WINDOW_SECONDS
        ]
        if not samples or int(samples[-1][1]) != windows:
            samples.append([now, windows])
        eta["samples"] = samples[-128:]
    meta["queue_eta"] = eta


def process_heartbeat_key(job_id: str) -> str:
    return f"rapptor:job:{job_id}:process-heartbeat"


def _recent_rate(meta: dict, now: float) -> float | None:
    samples = [
        (float(item[0]), int(item[1]))
        for item in (meta.get("queue_eta") or {}).get("samples", [])
        if isinstance(item, list) and len(item) == 2 and now - float(item[0]) <= SAMPLE_WINDOW_SECONDS
    ]
    if len(samples) < 2:
        return None
    first, last = samples[0], samples[-1]
    elapsed = last[0] - first[0]
    completed = last[1] - first[1]
    if elapsed < MIN_SAMPLE_SECONDS or completed <= 0:
        return None
    return completed / elapsed


def _profile_key(queue_name: str) -> str:
    return f"rapptor:queue-eta:{queue_name}:profiles"


def save_completed_profile(job: Job, *, now: float | None = None) -> None:
    """Persist a bounded timing profile. ETA telemetry must never fail a job."""
    now = time.time() if now is None else float(now)
    meta = job.meta
    eta = meta.get("queue_eta") or {}
    total = meta.get("eta_total_windows")
    try:
        inference_finished = float(eta["inference_finished_at"])
    except (KeyError, TypeError, ValueError):
        return
    rate = _recent_rate(meta, inference_finished)
    try:
        started = float(eta["started_at"])
        inference_started = float(eta["inference_started_at"])
        completed = float(eta["completed_at"])
    except (KeyError, TypeError, ValueError):
        return
    if not isinstance(total, int) or total <= 0 or rate is None:
        return
    profile = {
        "recorded_at": now,
        "windows_per_second": rate,
        "preparation_seconds": max(0.0, inference_started - started),
        "output_seconds": max(0.0, completed - inference_finished),
    }
    try:
        key = _profile_key(job.origin)
        pipeline = job.connection.pipeline()
        pipeline.lpush(key, json.dumps(profile, separators=(",", ":")))
        pipeline.ltrim(key, 0, PROFILE_LIMIT - 1)
        pipeline.expire(key, int(PROFILE_MAX_AGE_SECONDS))
        pipeline.execute()
    except Exception:
        pass


def load_profiles(connection, queue_name: str, *, now: float | None = None) -> list[dict]:
    now = time.time() if now is None else float(now)
    profiles = []
    try:
        values = connection.lrange(_profile_key(queue_name), 0, PROFILE_LIMIT - 1)
    except Exception:
        return profiles
    for value in values:
        try:
            profile = json.loads(value.decode() if isinstance(value, bytes) else value)
            if now - float(profile["recorded_at"]) <= PROFILE_MAX_AGE_SECONDS:
                profiles.append(profile)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            continue
    return profiles


def _profile_stats(profiles: list[dict]) -> tuple[float, float, float] | None:
    try:
        rates = [float(item["windows_per_second"]) for item in profiles]
        preparation = [float(item["preparation_seconds"]) for item in profiles]
        output = [float(item["output_seconds"]) for item in profiles]
    except (KeyError, TypeError, ValueError):
        return None
    if not rates or min(rates) <= 0 or min(preparation) < 0 or min(output) < 0:
        return None
    return statistics.median(rates), statistics.median(preparation), statistics.median(output)


def _queued_duration(meta: dict, stats: tuple[float, float, float]) -> float | None:
    total = meta.get("eta_total_windows")
    if not isinstance(total, int) or total < 0:
        return None
    rate, preparation, output = stats
    return preparation + total / rate + output


def _running_remaining(meta: dict, stats: tuple[float, float, float], now: float) -> float | None:
    total = meta.get("eta_total_windows")
    if not isinstance(total, int) or total < 0:
        return None
    progress = meta.get("progress") or {}
    stage = progress.get("stage")
    eta = meta.get("queue_eta") or {}
    rate, preparation, output = stats

    if stage in {"complete", "failed"}:
        return 0.0
    if stage == "writing_outputs":
        try:
            elapsed = now - float(eta["inference_finished_at"])
        except (KeyError, TypeError, ValueError):
            return None
        return max(0.0, output - elapsed)
    if stage in {"inference", "scanning"}:
        samples = eta.get("samples") or []
        if samples:
            try:
                if now - float(samples[-1][0]) > MAX_PROGRESS_AGE_SECONDS:
                    return None
            except (TypeError, ValueError, IndexError):
                return None
        observed_rate = _recent_rate(meta, now) or rate
        windows = progress.get("windows", 0)
        if not isinstance(windows, int) or windows < 0:
            return None
        return max(0, total - windows) / observed_rate + output

    try:
        elapsed = now - float(eta["started_at"])
    except (KeyError, TypeError, ValueError):
        return None
    return max(0.0, preparation - elapsed) + total / rate + output


def calculate_wait_seconds(
    *,
    status: str,
    target_id: str,
    queued_jobs: list[Job],
    running_jobs: list[Job],
    worker_count: int,
    profiles: list[dict],
    now: float,
) -> int | None:
    """Simulate FIFO tasks across observed worker slots without exposing job data."""
    if status in {"running", "succeeded", "failed"}:
        return 0
    if status != "queued" or worker_count <= 0 or len(running_jobs) > worker_count:
        return None
    try:
        target_index = next(index for index, job in enumerate(queued_jobs) if job.id == target_id)
    except StopIteration:
        return None
    ahead_jobs = queued_jobs[:target_index]
    if not ahead_jobs and not running_jobs:
        return 0

    stats = _profile_stats(profiles)
    if stats is None:
        return None
    slots = []
    for job in running_jobs:
        remaining = _running_remaining(job.meta, stats, now)
        if remaining is None:
            return None
        slots.append(remaining)
    slots.extend([0.0] * (worker_count - len(slots)))
    for job in ahead_jobs:
        duration = _queued_duration(job.meta, stats)
        if duration is None:
            return None
        index = min(range(len(slots)), key=slots.__getitem__)
        slots[index] += duration
    return max(0, math.ceil(min(slots)))


def estimate_wait_seconds(connection, job: Job, status: str, queued_ids: list[str], *, now: float | None = None) -> int | None:
    """Redis/RQ adapter used by the authenticated job-status endpoint."""
    now = time.time() if now is None else float(now)
    if status in {"running", "succeeded", "failed"}:
        return 0
    worker_count = len(connection.keys(f"rapptor:worker:{job.origin}:*:ready"))
    if worker_count <= 0:
        return None
    try:
        running_ids = StartedJobRegistry(name=job.origin, connection=connection).get_job_ids()
        queued_jobs = [item for item in Job.fetch_many(queued_ids, connection=connection) if item is not None]
        running_jobs = [item for item in Job.fetch_many(running_ids, connection=connection) if item is not None]
    except Exception:
        return None
    return calculate_wait_seconds(
        status=status,
        target_id=job.id,
        queued_jobs=queued_jobs,
        running_jobs=running_jobs,
        worker_count=worker_count,
        profiles=load_profiles(connection, job.origin, now=now),
        now=now,
    )


def estimate_remaining_seconds(connection, job: Job, status: str, *, now: float | None = None) -> int | None:
    """Estimate this running job's remaining work without exposing queue details."""
    if status == "succeeded":
        return 0
    if status != "running":
        return None
    if not connection.keys(f"rapptor:worker:{job.origin}:*:ready"):
        return None
    now = time.time() if now is None else float(now)
    stats = _profile_stats(load_profiles(connection, job.origin, now=now))
    if stats is None:
        return None
    remaining = _running_remaining(job.meta, stats, now)
    return None if remaining is None else max(0, math.ceil(remaining))
