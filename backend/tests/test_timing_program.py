"""Tests for the simplified TimingProgram evaluator (`app.timing_program`).

After alembic 0045 the evaluator returns 1.0 inside any interval and 0.0
outside — no more value-bearing waveforms (const / linear_ramp / arbitrary
are gone; gate_off is implicit).
"""
from __future__ import annotations

import pytest

from app.timing_program import (
    IntervalView,
    evaluate_intervals_at,
    sample_intervals,
)


def iv(start: float, end: float) -> IntervalView:
    return IntervalView(spin_core_start_ns=start, spin_core_end_ns=end)


# ---- single-interval semantics --------------------------------------------


def test_inside_interval_returns_one():
    res = evaluate_intervals_at([iv(0, 100)], 50)
    assert res.value == 1.0
    assert res.interval_index == 0


def test_outside_interval_returns_zero():
    res = evaluate_intervals_at([iv(10, 20)], 5)
    assert res.value == 0.0
    assert res.interval_index is None


def test_left_edge_inclusive_right_edge_exclusive():
    intervals = [iv(10, 20)]
    assert evaluate_intervals_at(intervals, 10).value == 1.0
    assert evaluate_intervals_at(intervals, 19.999).value == 1.0
    assert evaluate_intervals_at(intervals, 20).value == 0.0


def test_idle_outside_any_interval():
    res = evaluate_intervals_at([iv(10, 20)], 5)
    assert res.value == 0.0
    assert res.interval_index is None


# ---- multi-interval semantics ---------------------------------------------


def test_correct_index_returned():
    intervals = [iv(0, 10), iv(20, 30), iv(40, 50)]
    assert evaluate_intervals_at(intervals, 5).interval_index == 0
    assert evaluate_intervals_at(intervals, 25).interval_index == 1
    assert evaluate_intervals_at(intervals, 45).interval_index == 2
    # gaps between intervals are LOW
    assert evaluate_intervals_at(intervals, 15).value == 0.0
    assert evaluate_intervals_at(intervals, 35).value == 0.0


def test_unsorted_input_is_normalised():
    intervals = [iv(40, 50), iv(0, 10), iv(20, 30)]
    # interval_index is in *sorted* order, so 25 lands on the (20,30) entry
    # which is index 1 after sorting.
    assert evaluate_intervals_at(intervals, 25).interval_index == 1


# ---- input shape flexibility ----------------------------------------------


def test_dict_input_snake_case():
    intervals = [{"spin_core_start_ns": 0, "spin_core_end_ns": 100}]
    assert evaluate_intervals_at(intervals, 50).value == 1.0


def test_dict_input_camel_case():
    intervals = [{"spinCoreStartNs": 0, "spinCoreEndNs": 100}]
    assert evaluate_intervals_at(intervals, 50).value == 1.0


# ---- vectorised sample_intervals -----------------------------------------


def test_sample_intervals_returns_one_result_per_t():
    intervals = [iv(0, 10), iv(20, 30)]
    results = sample_intervals(intervals, [0, 5, 10, 15, 25, 35])
    values = [r.value for r in results]
    assert values == [1.0, 1.0, 0.0, 0.0, 1.0, 0.0]


def test_sample_intervals_indexes_match_evaluator():
    intervals = [iv(0, 10), iv(20, 30)]
    for t in [0, 5, 15, 25]:
        single = evaluate_intervals_at(intervals, t)
        batch = sample_intervals(intervals, [t])[0]
        assert single.value == batch.value
        assert single.interval_index == batch.interval_index


def test_empty_intervals_always_low():
    results = sample_intervals([], [0, 100, 1000])
    assert all(r.value == 0.0 and r.interval_index is None for r in results)
