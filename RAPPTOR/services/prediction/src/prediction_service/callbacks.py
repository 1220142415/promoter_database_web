from __future__ import annotations

import json
from pathlib import Path

import httpx

from .config import SETTINGS
from .storage import JobStorage


EVENT_STATUSES = ("queued", "running", "succeeded", "failed")


def _event_path(job_id: str, status: str) -> Path:
    if status not in EVENT_STATUSES:
        raise ValueError("unsupported callback status")
    return JobStorage(SETTINGS.data_root).job_dir(job_id) / f".callback-{status}.json"


def persist_job_event(payload: dict) -> bool:
    """Durably stage a D1 callback before attempting network delivery."""
    if not SETTINGS.job_callback_url or not SETTINGS.job_callback_secret:
        return False
    try:
        JobStorage(SETTINGS.data_root).write_json(
            payload["jobId"],
            f".callback-{payload['status']}.json",
            payload,
        )
        return True
    except (KeyError, OSError, TypeError, ValueError):
        return False


def _post_event(payload: dict) -> bool:
    try:
        response = httpx.post(
            SETTINGS.job_callback_url,
            json=payload,
            headers={"Authorization": f"Bearer {SETTINGS.job_callback_secret}"},
            timeout=10,
        )
        return response.is_success and response.json().get("accepted") is True
    except (httpx.HTTPError, ValueError):
        return False


def flush_job_events(job_id: str) -> bool:
    """Deliver staged events in lifecycle order; leave failures for retry."""
    delivered_all = True
    for status in EVENT_STATUSES:
        path = _event_path(job_id, status)
        if not path.is_file():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        if not _post_event(payload):
            return False
        try:
            path.unlink(missing_ok=True)
        except OSError:
            return False
    return delivered_all


def flush_pending_job_events(data_root: Path) -> int:
    delivered = 0
    jobs_root = JobStorage(data_root).jobs_root
    for path in jobs_root.iterdir():
        if path.is_dir() and any(path.glob(".callback-*.json")) and flush_job_events(path.name):
            delivered += 1
    return delivered


def report_job_event(payload: dict) -> bool:
    """Persist then deliver metadata; queue execution never depends on D1 latency."""
    if not persist_job_event(payload):
        return False
    return flush_job_events(payload["jobId"])


async def deliver_job_event_async(payload: dict) -> bool:
    """Try one async delivery of an event that is already staged on disk."""
    path = _event_path(payload["jobId"], payload["status"])
    if not path.is_file():
        return True
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                SETTINGS.job_callback_url,
                json=payload,
                headers={"Authorization": f"Bearer {SETTINGS.job_callback_secret}"},
            )
        accepted = response.is_success and response.json().get("accepted") is True
        if accepted:
            path.unlink(missing_ok=True)
        return accepted
    except (httpx.HTTPError, OSError, ValueError):
        return False
