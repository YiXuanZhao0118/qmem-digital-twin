"""Pure-function evaluator for TimingProgram intervals (alembic 0045).

A TimingProgram is an ordered list of ``[spin_core_start_ns, spin_core_end_ns)``
intervals; output is HIGH inside any interval and LOW outside. The same data
shape is interpreted two ways downstream via the program's ``kind``:

- ``"TTL"``:     output is HIGH inside intervals, LOW between (gate semantics).
- ``"Trigger"``: a rising edge fires at each interval's start; the interval
                 width is the pulse width PB hardware emits to make the edge
                 observable. From the evaluator's point of view both look the
                 same — kind only matters to the consumer logic.

This module replaces the pre-0045 multi-waveform evaluator. ``const`` /
``linear_ramp`` / ``arbitrary`` blocks no longer exist; if a use case
needs amplitude shaping it lives on the source itself (rfSources[].signal.waveform).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Sequence


@dataclass(frozen=True)
class IntervalView:
    """Read-only view over one (start, end) pair the evaluator can consume.

    Decoupled from SQLAlchemy / Pydantic so tests can hand-roll views.
    """

    spin_core_start_ns: float
    spin_core_end_ns: float


@dataclass(frozen=True)
class EvaluationResult:
    """What the program is doing at a given instant."""

    value: float
    """1.0 inside an active interval, 0.0 otherwise."""
    interval_index: int | None
    """Index in the sorted intervals list, or None when LOW."""


def _normalise(intervals: Iterable[Any]) -> list[IntervalView]:
    """Coerce ORM rows / dicts / IntervalView mixed input into sorted views."""
    out: list[IntervalView] = []
    for iv in intervals:
        if isinstance(iv, IntervalView):
            out.append(iv)
            continue
        if isinstance(iv, dict):
            start = float(
                iv.get("spin_core_start_ns")
                if iv.get("spin_core_start_ns") is not None
                else iv.get("spinCoreStartNs", 0)
            )
            end = float(
                iv.get("spin_core_end_ns")
                if iv.get("spin_core_end_ns") is not None
                else iv.get("spinCoreEndNs", 0)
            )
        else:
            start = float(getattr(iv, "spin_core_start_ns", 0))
            end = float(getattr(iv, "spin_core_end_ns", 0))
        out.append(IntervalView(spin_core_start_ns=start, spin_core_end_ns=end))
    out.sort(key=lambda i: i.spin_core_start_ns)
    return out


def evaluate_intervals_at(
    intervals: Sequence[Any], t_ns: float
) -> EvaluationResult:
    """Evaluate program output at a single instant.

    ``[start, end)`` is the active interval (right edge exclusive). Overlap
    is forbidden by the schema validator; if it ever sneaks through, the
    first interval in start-time order wins.
    """
    sorted_ivs = _normalise(intervals)
    for index, iv in enumerate(sorted_ivs):
        if iv.spin_core_start_ns <= t_ns < iv.spin_core_end_ns:
            return EvaluationResult(value=1.0, interval_index=index)
    return EvaluationResult(value=0.0, interval_index=None)


def sample_intervals(
    intervals: Sequence[Any], t_grid_ns: Sequence[float]
) -> list[EvaluationResult]:
    """Vectorised: evaluate at each point of a time grid."""
    sorted_ivs = _normalise(intervals)
    results: list[EvaluationResult] = []
    for t in t_grid_ns:
        active: int | None = None
        for index, iv in enumerate(sorted_ivs):
            if iv.spin_core_start_ns <= t < iv.spin_core_end_ns:
                active = index
                break
        if active is None:
            results.append(EvaluationResult(value=0.0, interval_index=None))
        else:
            results.append(EvaluationResult(value=1.0, interval_index=active))
    return results
