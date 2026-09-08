from types import SimpleNamespace

import fakeredis

from prediction_service.queue_eta import (
    calculate_wait_seconds,
    load_profiles,
    record_progress,
    save_completed_profile,
)


NOW = 1_000.0
PROFILES = [{
    "recorded_at": NOW,
    "windows_per_second": 100.0,
    "preparation_seconds": 10.0,
    "output_seconds": 5.0,
}]


def job(job_id, total_windows, *, progress=None, samples=None):
    meta = {"eta_total_windows": total_windows}
    if progress is not None:
        meta["progress"] = progress
    if samples is not None:
        meta["queue_eta"] = {
            "started_at": NOW - 70,
            "inference_started_at": NOW - 60,
            "samples": samples,
        }
    return SimpleNamespace(id=job_id, meta=meta)


def waiting(target, queued, running=(), *, workers=1, profiles=PROFILES):
    return calculate_wait_seconds(
        status="queued",
        target_id=target.id,
        queued_jobs=list(queued),
        running_jobs=list(running),
        worker_count=workers,
        profiles=profiles,
        now=NOW,
    )


def test_single_worker_includes_running_job_remaining_time_with_no_queued_jobs_ahead():
    target = job("target", 100)
    running = job(
        "running", 10_000,
        progress={"stage": "scanning", "windows": 6_000},
        samples=[[NOW - 60, 0], [NOW, 6_000]],
    )
    assert waiting(target, [target], [running]) == 45


def test_multiple_workers_assign_ahead_jobs_to_first_available_slot():
    target = job("target", 100)
    ahead = job("ahead", 2_000)
    running = job(
        "running", 10_000,
        progress={"stage": "scanning", "windows": 6_000},
        samples=[[NOW - 60, 0], [NOW, 6_000]],
    )
    assert waiting(target, [ahead, target], [running], workers=2) == 35


def test_different_queued_workloads_use_window_counts_not_job_count():
    target = job("target", 100)
    small = job("small", 1_000)
    large = job("large", 3_000)
    assert waiting(target, [small, large, target]) == 70


def test_insufficient_samples_return_null():
    target = job("target", 100)
    running = job(
        "running", 10_000,
        progress={"stage": "scanning", "windows": 1_000},
        samples=[[NOW, 1_000]],
    )
    assert waiting(target, [target], [running], profiles=[]) is None


def test_stalled_progress_returns_null_even_with_a_profile():
    target = job("target", 100)
    running = job(
        "running", 10_000,
        progress={"stage": "scanning", "windows": 1_000},
        samples=[[NOW - 60, 0], [NOW - 31, 1_000]],
    )
    assert waiting(target, [target], [running]) is None


def test_offline_worker_returns_null():
    target = job("target", 100)
    assert waiting(target, [target], workers=0) is None


def test_idle_worker_can_start_immediately_without_historical_samples():
    target = job("target", 100)
    assert waiting(target, [target], profiles=[]) == 0


def test_wait_becomes_zero_when_target_transitions_to_running():
    target = job("target", 100)
    assert calculate_wait_seconds(
        status="running",
        target_id=target.id,
        queued_jobs=[],
        running_jobs=[target],
        worker_count=1,
        profiles=[],
        now=NOW,
    ) == 0


def test_completed_timing_profile_round_trips_through_redis():
    connection = fakeredis.FakeRedis()
    meta = {"eta_total_windows": 1_000}
    record_progress(meta, "starting", now=100.0)
    record_progress(meta, "scanning", 0, now=110.0)
    record_progress(meta, "scanning", 1_000, now=120.0)
    record_progress(meta, "writing_outputs", 1_000, now=120.0)
    record_progress(meta, "complete", now=125.0)
    completed = SimpleNamespace(origin="prediction:test", connection=connection, meta=meta)

    save_completed_profile(completed, now=125.0)

    assert load_profiles(connection, "prediction:test", now=125.0) == [{
        "recorded_at": 125.0,
        "windows_per_second": 100.0,
        "preparation_seconds": 10.0,
        "output_seconds": 5.0,
    }]


def test_process_heartbeat_does_not_count_as_useful_progress():
    meta = {}
    record_progress(meta, "scanning", 100, percent=20.0, now=100.0)
    record_progress(meta, "scanning", 100, percent=20.0, now=110.0)
    assert meta["queue_eta"]["last_progress_at"] == 100.0
    record_progress(meta, "scanning", 101, percent=20.1, now=111.0)
    assert meta["queue_eta"]["last_progress_at"] == 111.0
