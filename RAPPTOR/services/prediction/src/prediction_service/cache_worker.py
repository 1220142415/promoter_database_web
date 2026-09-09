from rq import Queue
from rq.worker import SpawnWorker

from .config import SETTINGS
from .queueing import get_redis_connection


def main() -> None:
    connection = get_redis_connection()
    connection.ping()
    queue = Queue(
        SETTINGS.reference_cache_queue_name,
        connection=connection,
        default_timeout=SETTINGS.job_stall_timeout_seconds,
    )
    SpawnWorker([queue], connection=connection).work(with_scheduler=False)


if __name__ == "__main__":
    main()
