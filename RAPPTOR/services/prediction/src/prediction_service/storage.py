from __future__ import annotations

import json
import os
from pathlib import Path


class JobStorage:
    def __init__(self, data_root: Path):
        self.data_root = Path(data_root).resolve()
        self.jobs_root = self.data_root / "jobs"
        self.jobs_root.mkdir(parents=True, exist_ok=True)

    def job_dir(self, job_id: str) -> Path:
        if not job_id or any(c not in "0123456789abcdef" for c in job_id) or len(job_id) != 32:
            raise ValueError("invalid job id")
        path = (self.jobs_root / job_id).resolve()
        if path.parent != self.jobs_root:
            raise ValueError("unsafe job path")
        return path

    def create(self, job_id: str) -> Path:
        path = self.job_dir(job_id)
        path.mkdir(mode=0o700, parents=False, exist_ok=False)
        return path

    def write_json(self, job_id: str, name: str, payload: dict) -> Path:
        if "/" in name or "\\" in name or not name.endswith(".json"):
            raise ValueError("unsafe json filename")
        path = self.job_dir(job_id) / name
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
        return path

    def read_json(self, job_id: str, name: str) -> dict:
        path = self.job_dir(job_id) / name
        return json.loads(path.read_text(encoding="utf-8"))

    def write_text(self, job_id: str, name: str, text: str) -> Path:
        if "/" in name or "\\" in name:
            raise ValueError("unsafe text filename")
        path = self.job_dir(job_id) / name
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
        return path
