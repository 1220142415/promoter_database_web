from __future__ import annotations

import asyncio
import json
import time
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path

from .config import SETTINGS


CPU_SAMPLES_KEY = "rapptor:metrics:cpu"
SAMPLE_SECONDS = 5
HISTORY_SECONDS = 6 * 60 * 60
RETENTION_SECONDS = HISTORY_SECONDS + 30 * 60
BUCKET_SECONDS = 30 * 60


def read_cpu_times(path: Path = Path("/proc/stat")) -> tuple[int, int]:
    values = [int(value) for value in path.read_text(encoding="ascii").splitlines()[0].split()[1:]]
    total = sum(values)
    idle = values[3] + (values[4] if len(values) > 4 else 0)
    return total, idle


def cpu_percent(previous: tuple[int, int], current: tuple[int, int]) -> float:
    total = current[0] - previous[0]
    idle = current[1] - previous[1]
    if total <= 0:
        return 0.0
    return round(max(0.0, min(100.0, 100.0 * (total - idle) / total)), 1)


def record_cpu_sample(connection, sampled_at: float, percent: float) -> None:
    member = json.dumps({"sampled_at": sampled_at, "cpu_percent": percent}, separators=(",", ":"))
    connection.zadd(CPU_SAMPLES_KEY, {member: sampled_at})
    connection.zremrangebyscore(CPU_SAMPLES_KEY, 0, sampled_at - RETENTION_SECONDS)


async def sample_cpu_loop() -> None:
    from redis import Redis
    from redis.exceptions import RedisError

    previous = read_cpu_times()
    connection = Redis.from_url(SETTINGS.redis_url, decode_responses=False)
    while True:
        await asyncio.sleep(SAMPLE_SECONDS)
        current = read_cpu_times()
        sampled_at = time.time()
        try:
            record_cpu_sample(connection, sampled_at, cpu_percent(previous, current))
        except RedisError:
            pass
        previous = current


def latest_cpu_sample(connection) -> dict | None:
    rows = connection.zrevrange(CPU_SAMPLES_KEY, 0, 0)
    if not rows:
        return None
    try:
        return json.loads(rows[0])
    except (TypeError, json.JSONDecodeError):
        return None


def cpu_history(connection, now: float | None = None) -> list[dict]:
    end = int((now if now is not None else time.time()) // BUCKET_SECONDS) * BUCKET_SECONDS
    start = end - HISTORY_SECONDS
    buckets: list[list[float]] = [[] for _ in range(HISTORY_SECONDS // BUCKET_SECONDS)]
    for raw in connection.zrangebyscore(CPU_SAMPLES_KEY, start, f"({end}"):
        try:
            sample = json.loads(raw)
            index = int((float(sample["sampled_at"]) - start) // BUCKET_SECONDS)
            if 0 <= index < len(buckets):
                buckets[index].append(float(sample["cpu_percent"]))
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            continue
    return [
        {
            "started_at": datetime.fromtimestamp(start + index * BUCKET_SECONDS, timezone.utc).isoformat(),
            "average_cpu_percent": round(sum(values) / len(values), 1) if values else None,
            "peak_cpu_percent": round(max(values), 1) if values else None,
            "samples": len(values),
        }
        for index, values in enumerate(buckets)
    ]


async def stop_sampler(task: asyncio.Task) -> None:
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task
