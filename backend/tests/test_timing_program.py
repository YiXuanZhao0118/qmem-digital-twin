"""Tests for the TimingProgram evaluator (`app.timing_program`).

Covers all 5 waveform kinds (const, linear_ramp, arbitrary, gate_on, gate_off)
plus boundary conditions: idle outside any block, exactly-on-edge sampling,
overlapping blocks (first wins), arbitrary sample interpolation.
"""
from __future__ import annotations

import pytest

from app.timing_program import (
    TimingBlockView,
    evaluate_block,
    evaluate_program_at,
    sample_program,
)


def block(
    *,
    t_start: float,
    t_end: float,
    kind: str,
    params: dict | None = None,
    label: str | None = None,
) -> TimingBlockView:
    return TimingBlockView(
        label=label,
        t_start_ns=t_start,
        t_end_ns=t_end,
        waveform_kind=kind,
        params=params or {},
    )


# ---- single waveform kinds -------------------------------------------------


def test_const_returns_value_inside_block():
    b = block(t_start=0, t_end=100, kind="const", params={"value": 0.7})
    assert evaluate_block(b, 50) == pytest.approx(0.7)


def test_gate_on_returns_one():
    b = block(t_start=0, t_end=100, kind="gate_on")
    assert evaluate_block(b, 50) == 1.0


def test_gate_off_returns_zero():
    b = block(t_start=0, t_end=100, kind="gate_off")
    assert evaluate_block(b, 50) == 0.0


def test_linear_ramp_interpolates_endpoints():
    b = block(t_start=0, t_end=100, kind="linear_ramp", params={"start": 0.0, "end": 1.0})
    assert evaluate_block(b, 0) == pytest.approx(0.0)
    assert evaluate_block(b, 50) == pytest.approx(0.5)
    # Just before the end, should approach 1.0
    assert evaluate_block(b, 99.999) == pytest.approx(0.99999, rel=1e-4)


def test_linear_ramp_descends_when_start_greater_than_end():
    b = block(t_start=100, t_end=200, kind="linear_ramp", params={"start": 1.0, "end": 0.0})
    assert evaluate_block(b, 100) == pytest.approx(1.0)
    assert evaluate_block(b, 150) == pytest.approx(0.5)


def test_arbitrary_sample_at_first_sample():
    b = block(
        t_start=0,
        t_end=100,
        kind="arbitrary",
        params={"samples": [0.1, 0.2, 0.3, 0.4, 0.5], "dt_ns": 25},
    )
    assert evaluate_block(b, 0) == pytest.approx(0.1)


def test_arbitrary_linear_interp_between_samples():
    b = block(
        t_start=0,
        t_end=100,
        kind="arbitrary",
        params={"samples": [0.0, 1.0], "dt_ns": 100},
    )
    # Halfway between sample 0 (0.0) and sample 1 (1.0)
    assert evaluate_block(b, 50) == pytest.approx(0.5)


def test_arbitrary_pad_after_last_sample():
    b = block(
        t_start=0,
        t_end=100,
        kind="arbitrary",
        params={"samples": [0.0, 1.0, 2.0], "dt_ns": 25},
    )
    # Beyond last sample, should pin to last sample value (2.0)
    assert evaluate_block(b, 99) == pytest.approx(2.0)


# ---- evaluate_program_at: idle, edges, overlap ----------------------------


def test_idle_outside_any_block():
    blocks = [block(t_start=10, t_end=20, kind="gate_on")]
    res = evaluate_program_at(blocks, 5)
    assert res.kind == "idle"
    assert res.value == 0.0
    assert res.block_index is None


def test_idle_value_can_be_overridden():
    blocks = []
    res = evaluate_program_at(blocks, 0, idle_value=42.0)
    assert res.value == 42.0


def test_block_active_at_left_edge_inactive_at_right_edge():
    blocks = [block(t_start=10, t_end=20, kind="gate_on")]
    assert evaluate_program_at(blocks, 10).value == 1.0
    assert evaluate_program_at(blocks, 19.999).value == 1.0
    # Right edge t_end is exclusive
    assert evaluate_program_at(blocks, 20).kind == "idle"


def test_overlapping_blocks_first_wins():
    blocks = [
        block(t_start=0, t_end=100, kind="const", params={"value": 0.4}, label="A"),
        block(t_start=50, t_end=150, kind="const", params={"value": 0.9}, label="B"),
    ]
    res = evaluate_program_at(blocks, 75)
    assert res.value == pytest.approx(0.4)
    assert res.label == "A"


def test_dict_blocks_accepted_as_input():
    """Allows the evaluator to be fed straight from FastAPI request dicts."""
    blocks = [
        {"t_start_ns": 0, "t_end_ns": 100, "waveform_kind": "const", "params": {"value": 0.5}, "label": "x"},
    ]
    res = evaluate_program_at(blocks, 50)
    assert res.value == pytest.approx(0.5)
    assert res.label == "x"


def test_camelcase_dict_blocks_also_accepted():
    blocks = [
        {"tStartNs": 0, "tEndNs": 100, "waveformKind": "gate_on", "params": {}, "label": None},
    ]
    res = evaluate_program_at(blocks, 50)
    assert res.value == 1.0


# ---- sample_program (vectorised) ------------------------------------------


def test_sample_program_returns_one_result_per_sample():
    blocks = [
        block(t_start=0, t_end=10, kind="gate_on"),
        block(t_start=10, t_end=20, kind="gate_off"),
    ]
    results = sample_program(blocks, [0, 5, 10, 15, 25])
    assert len(results) == 5
    assert results[0].value == 1.0  # in first block
    assert results[1].value == 1.0  # still in first block
    assert results[2].value == 0.0  # in second block
    assert results[3].value == 0.0  # still in second block
    assert results[4].kind == "idle"  # past all blocks


def test_sample_program_resolves_ramp_per_step():
    blocks = [
        block(t_start=0, t_end=100, kind="linear_ramp", params={"start": 0.0, "end": 1.0}),
    ]
    results = sample_program(blocks, [0, 25, 50, 75])
    values = [r.value for r in results]
    assert values == pytest.approx([0.0, 0.25, 0.5, 0.75])
