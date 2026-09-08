from __future__ import annotations

from redis import Redis
from rq import Queue

from .config import SETTINGS


def get_redis_connection() -> Redis:
    return Redis.from_url(SETTINGS.redis_url, decode_responses=False)


def get_queue(connection: Redis | None = None, mode: str | None = None) -> Queue:
    connection = connection or get_redis_connection()
    queue_name = {
        None: SETTINGS.queue_name,
        "predict": SETTINGS.predict_queue_name,
        "genome_scan": SETTINGS.scan_queue_name,
    }.get(mode)
    if queue_name is None:
        raise ValueError(f"unsupported prediction mode: {mode}")
    return Queue(queue_name, connection=connection, default_timeout=SETTINGS.job_timeout_seconds)
