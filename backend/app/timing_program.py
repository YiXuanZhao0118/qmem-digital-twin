"""Pure-function evaluator for component timing programs.

A `TimingProgram` is a list of `TimingBlock`s describing what a component
does over `[t_start_ns, t_end_ns)`. This module turns that data into the
*active value at instant t*: the scalar (or pair) that the optical / RF
solver should use for the component when computing its state at simulation
time `t`.

Behaviour
---------

- For each block, the evaluator returns (value, kind, label) when the block
  is active. Outside any block we return the **idle state**:
  `(idle_value, "idle")` where `idle_value` defaults to 0.0 (off) but can be
  overridden per-component by the caller.
- The evaluator is closed-form: there's no integration. `linear_ramp` is
  linearly interpolated, `arbitrary` does linear interpolation between
  consecutive samples (with sample 0 starting at `t_start_ns`).
- Block boundaries: `t_start_ns ≤ t < t_end_ns` is the active interval. If
  two blocks overlap (which schema validation should prevent but we don't
  re-check here), the *first one in sort order* wins.

This module is the bridge between the timing-editor data model and the
existing optical solver. Phase 1c of physics-time refactor (transient
runs) calls into this for every component every simulation step.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Sequence


@dataclass(frozen=True)
class TimingBlockView:
    """Read-only view over a TimingBlock that the evaluator can consume.

    Decoupled from the SQLAlchemy model so tests can build one with plain
    dicts/dataclasses.
    """
    label: str | None
    t_start_ns: float
    t_end_ns: float
    waveform_kind: str  # "const" | "linear_ramp" | "arbitrary" | "gate_on" | "gate_off"
    params: dict[str, Any]


@dataclass(frozen=True)
class EvaluationResult:
    """What the program is doing at a given instant."""
    value: float
    """Continuous numerical output. Semantics depend on the kind:
       - emitter (laser / TA): scale factor [0, 1] for power_mw, or absolute
         power_mw if the block specifies an absolute value > 1.
       - aom / eom: efficiency / depth in [0, 1].
       - gate_on  → 1.0
       - gate_off → 0.0
       - idle / no block active → caller-provided idle_value (default 0.0).
    """
    kind: str
    """One of: const, linear_ramp, arbitrary, gate_on, gate_off, idle."""
    label: str | None
    """Block label if active; None for idle / unlabeled."""
    block_index: int | None
    """Index in the `sorted_blocks` list, or None if idle."""


def _normalise_blocks(blocks: Iterable[Any]) -> list[TimingBlockView]:
    out: list[TimingBlockView] = []
    for b in blocks:
        if isinstance(b, TimingBlockView):
            out.append(b)
            continue
        # ORM object or dict-like
        label = getattr(b, "label", None) if not isinstance(b, dict) else b.get("label")
        t_start = float(
            getattr(b, "t_start_ns", None)
            if not isinstance(b, dict)
            else b.get("t_start_ns", b.get("tStartNs", 0))
        )
        t_end = float(
            getattr(b, "t_end_ns", None)
            if not isinstance(b, dict)
            else b.get("t_end_ns", b.get("tEndNs", 0))
        )
        kind = (
            getattr(b, "waveform_kind", None)
            if not isinstance(b, dict)
            else b.get("waveform_kind", b.get("waveformKind", "const"))
        )
        params = (
            getattr(b, "params", None)
            if not isinstance(b, dict)
            else b.get("params", {})
        )
        out.append(
            TimingBlockView(
                label=label,
                t_start_ns=t_start,
                t_end_ns=t_end,
                waveform_kind=str(kind),
                params=dict(params or {}),
            )
        )
    out.sort(key=lambda block: block.t_start_ns)
    return out


def evaluate_block(block: TimingBlockView, t_ns: float) -> float:
    """Compute the block's instantaneous value at `t_ns`.

    Caller must check `block.t_start_ns ≤ t_ns < block.t_end_ns` first;
    this routine does not validate the bounds.
    """
    kind = block.waveform_kind
    if kind == "gate_on":
        return 1.0
    if kind == "gate_off":
        return 0.0
    if kind == "const":
        value = block.params.get("value", 0.0)
        return float(value)
    if kind == "linear_ramp":
        start = float(block.params.get("start", 0.0))
        end = float(block.params.get("end", 0.0))
        span = max(block.t_end_ns - block.t_start_ns, 1e-12)
        u = (t_ns - block.t_start_ns) / span
        # Clamp into [0, 1] in case caller violated the precondition slightly.
        u = max(0.0, min(1.0, u))
        return start + (end - start) * u
    if kind == "arbitrary":
        samples = block.params.get("samples", []) or []
        if not samples:
            return 0.0
        dt_ns = float(block.params.get("dt_ns", 0.0))
        if dt_ns <= 0:
            return float(samples[0])
        # Sample 0 starts at the block's t_start_ns; sample i at t_start + i*dt
        offset = t_ns - block.t_start_ns
        idx_f = offset / dt_ns
        if idx_f <= 0:
            return float(samples[0])
        last_index = len(samples) - 1
        if idx_f >= last_index:
            return float(samples[last_index])
        i_lo = int(idx_f)
        i_hi = i_lo + 1
        frac = idx_f - i_lo
        return float(samples[i_lo]) * (1.0 - frac) + float(samples[i_hi]) * frac
    # Unknown waveform → fall through as idle
    return 0.0


def evaluate_program_at(
    blocks: Sequence[Any],
    t_ns: float,
    idle_value: float = 0.0,
) -> EvaluationResult:
    """Evaluate the program at a single instant.

    `blocks` is any iterable of TimingBlock-like objects (ORM rows, dicts,
    or `TimingBlockView`). They are sorted by `t_start_ns` internally.
    """
    sorted_blocks = _normalise_blocks(blocks)
    for index, block in enumerate(sorted_blocks):
        if block.t_start_ns <= t_ns < block.t_end_ns:
            value = evaluate_block(block, t_ns)
            return EvaluationResult(
                value=value,
                kind=block.waveform_kind,
                label=block.label,
                block_index=index,
            )
    return EvaluationResult(value=idle_value, kind="idle", label=None, block_index=None)


def sample_program(
    blocks: Sequence[Any],
    t_grid_ns: Sequence[float],
    idle_value: float = 0.0,
) -> list[EvaluationResult]:
    """Vectorised version: evaluate at each point on the time grid."""
    sorted_blocks = _normalise_blocks(blocks)
    results: list[EvaluationResult] = []
    for t in t_grid_ns:
        active_idx: int | None = None
        for index, block in enumerate(sorted_blocks):
            if block.t_start_ns <= t < block.t_end_ns:
                active_idx = index
                break
        if active_idx is None:
            results.append(EvaluationResult(value=idle_value, kind="idle", label=None, block_index=None))
            continue
        block = sorted_blocks[active_idx]
        results.append(
            EvaluationResult(
                value=evaluate_block(block, t),
                kind=block.waveform_kind,
                label=block.label,
                block_index=active_idx,
            )
        )
    return results
