from datetime import datetime, timezone

from prediction_service.metrics import cpu_history, cpu_percent, read_cpu_times, record_cpu_sample


class FakeSortedSet:
    def __init__(self):
        self.rows = {}

    def zadd(self, _key, values):
        self.rows.update(values)

    def zremrangebyscore(self, _key, minimum, maximum):
        self.rows = {member: score for member, score in self.rows.items() if not float(minimum) <= score <= float(maximum)}

    def zrangebyscore(self, _key, minimum, maximum):
        exclusive = isinstance(maximum, str) and maximum.startswith("(")
        upper = float(maximum[1:] if exclusive else maximum)
        def included(score):
            return float(minimum) <= score < upper if exclusive else float(minimum) <= score <= upper

        return [
            member for member, score in sorted(self.rows.items(), key=lambda item: item[1])
            if included(score)
        ]


def test_cpu_sampling_and_half_hour_history(tmp_path):
    proc_stat = tmp_path / "stat"
    proc_stat.write_text("cpu  100 20 30 400 10 5 0 0 0 0\n", encoding="ascii")
    assert read_cpu_times(proc_stat) == (565, 410)
    assert cpu_percent((100, 80), (200, 130)) == 50.0

    connection = FakeSortedSet()
    now = datetime(2026, 9, 8, 6, 10, tzinfo=timezone.utc).timestamp()
    history_start = datetime(2026, 9, 8, 0, 0, tzinfo=timezone.utc).timestamp()
    record_cpu_sample(connection, history_start + 10, 20.0)
    record_cpu_sample(connection, history_start + 20, 40.0)
    record_cpu_sample(connection, history_start + 1810, 70.0)

    points = cpu_history(connection, now)
    assert len(points) == 12
    assert points[0] == {
        "started_at": "2026-09-08T00:00:00+00:00",
        "average_cpu_percent": 30.0,
        "peak_cpu_percent": 40.0,
        "samples": 2,
    }
    assert points[1]["average_cpu_percent"] == 70.0
    assert points[2]["samples"] == 0
