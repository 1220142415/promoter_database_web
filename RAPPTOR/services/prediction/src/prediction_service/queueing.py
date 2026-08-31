from __future__ import annotations

from redis import Redis
from rq import Queue

from .config import SETTINGS


def get_redis_connection() -> Redis:
    return Redis.from_url(SETTINGS.redis_url, decode_responses=False)


def get_queue(connection: Redis | None = None) -> Queue:
    connection = connection or get_redis_connection()
    return Queue(SETTINGS.queue_name, connection=connection, default_timeout=SETTINGS.job_timeout_seconds)
