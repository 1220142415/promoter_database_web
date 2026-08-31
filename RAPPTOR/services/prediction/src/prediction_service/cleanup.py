from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

from .storage import JobStorage


def purge_expired_jobs(data_root: Path, now: datetime | None = None) -> list[str]:
    """Delete terminal job directories whose declared artifact expiry passed."""
    storage = JobStorage(data_root)
    current = now or datetime.now(timezone.utc)
    removed: list[str] = []
    for path in storage.jobs_root.iterdir():
        if not path.is_dir() or len(path.name) != 32:
            continue
        try:
            job_dir = storage.job_dir(path.name)
            if not (job_dir / "summary.json").is_file() and not (job_dir / "worker-error.log").is_file():
                continue
            if any(job_dir.glob(".callback-*.json")):
                continue
            submission = json.loads((job_dir / "submission.json").read_text(encoding="utf-8"))
            expires_at = submission.get("artifacts_expires_at")
            if not isinstance(expires_at, str):
                continue
            expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
            if expiry.tzinfo is None:
                continue
            if expiry <= current:
                shutil.rmtree(job_dir)
                removed.append(path.name)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    return removed
