"""Compile bound TimingPrograms into a SpinCore opcode stream.

Each TimingProgram carries its own (channel_index, invert) hardware
binding inline (alembic 0046 — the separate ``pulse_blaster_channels``
table was dropped). The compiler:

1. Filter to programs with ``channel_index IS NOT NULL`` (those are
   physically bound to a PB output line).
2. Merge every interval boundary across all bound programs into a sorted
   unique edge list.
3. For each ``[t_i, t_{i+1}]``: build the 24-bit output mask from
   per-program gate state at ``t_i`` (HIGH if any interval covers t_i,
   optionally inverted).
4. Emit a CONTINUE per ``[t_i, t_{i+1}]``, then a final STOP.

``kind`` ("TTL" / "Trigger") doesn't affect the opcode stream — the PB
hardware emits the same waveform either way; downstream consumers
(DDS sync inputs vs gate inputs) interpret rising edges themselves.

The compiler is pure: no DB session, no network. The router hydrates
programs from the DB and hands them in.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional


@dataclass
class _Interval:
    spin_core_start_ns: float
    spin_core_end_ns: float


@dataclass
class _Program:
    program_id: str
    kind: str  # "TTL" | "Trigger" (metadata only)
    channel_index: int
    invert: bool
    intervals: list[_Interval]


@dataclass
class PbInstruction:
    """One row of the SpinCore opcode stream.

    ``output_state`` is a 24-bit integer — bit N high means physical
    channel N is HIGH for the duration of ``length_ns``. ``opcode``
    follows SpinCore naming (CONTINUE / STOP / WAIT / LOOP / END_LOOP /
    BRANCH / LONG_DELAY).
    """

    index: int
    output_state: int
    opcode: str
    data: int
    length_ns: float
    label: Optional[str] = None


def _program_high_at(program: _Program, t_ns: float) -> bool:
    raw = any(
        iv.spin_core_start_ns <= t_ns < iv.spin_core_end_ns
        for iv in program.intervals
    )
    return (not raw) if program.invert else raw


def compile_to_opcodes(
    programs: Iterable[dict],
) -> list[PbInstruction]:
    """Turn bound TimingPrograms into a SpinCore opcode stream.

    Args:
      programs: iterable of dicts shaped
        ``{id, kind, channel_index, invert, intervals: [...]}``.
        Programs with ``channel_index is None`` are skipped (they're
        logical schedules without a hardware wire). Intervals accept
        either snake_case (``spin_core_start_ns``) or camelCase
        (``spinCoreStartNs``) keys.
    """

    progs: list[_Program] = []
    for p in programs:
        ch = p.get("channel_index")
        if ch is None:
            continue
        intervals_raw = p.get("intervals") or []
        progs.append(
            _Program(
                program_id=str(p.get("id", "")),
                kind=str(p.get("kind", "TTL")),
                channel_index=int(ch),
                invert=bool(p.get("invert", False)),
                intervals=[
                    _Interval(
                        spin_core_start_ns=float(
                            iv.get("spin_core_start_ns")
                            if iv.get("spin_core_start_ns") is not None
                            else iv.get("spinCoreStartNs", 0)
                        ),
                        spin_core_end_ns=float(
                            iv.get("spin_core_end_ns")
                            if iv.get("spin_core_end_ns") is not None
                            else iv.get("spinCoreEndNs", 0)
                        ),
                    )
                    for iv in intervals_raw
                ],
            )
        )

    edges: set[float] = {0.0}
    for prog in progs:
        for iv in prog.intervals:
            edges.add(iv.spin_core_start_ns)
            edges.add(iv.spin_core_end_ns)

    sorted_edges = sorted(edges)
    if len(sorted_edges) < 2:
        return [PbInstruction(0, 0, "STOP", 0, 0.0, label="empty")]

    out: list[PbInstruction] = []
    for i in range(len(sorted_edges) - 1):
        t_start = sorted_edges[i]
        t_end = sorted_edges[i + 1]
        length = t_end - t_start
        if length <= 0:
            continue
        mask = 0
        for prog in progs:
            if _program_high_at(prog, t_start):
                mask |= 1 << prog.channel_index
        out.append(
            PbInstruction(
                index=len(out),
                output_state=mask,
                opcode="CONTINUE",
                data=0,
                length_ns=length,
                label=f"t={t_start:.0f}..{t_end:.0f}ns",
            )
        )

    out.append(
        PbInstruction(
            index=len(out),
            output_state=0,
            opcode="STOP",
            data=0,
            length_ns=0.0,
            label="end",
        )
    )
    return out


def render_spinapi_python(instructions: Iterable[PbInstruction]) -> str:
    """Render the opcode stream as Python ``spinapi`` calls.

    Drop the output into a SpinCore script that has already initialised
    the board (``pb_select_board`` / ``pb_init`` / ``pb_core_clock`` /
    ``pb_start_programming(PULSE_PROGRAM)``).
    """

    lines: list[str] = [
        "# Auto-generated by qmem-digital-twin",
        "# Drop into a script that has called pb_init() / pb_start_programming(PULSE_PROGRAM)",
        "from spinapi import pb_inst_pbonly, ns, CONTINUE, STOP",
        "",
    ]
    for inst in instructions:
        if inst.opcode == "STOP":
            lines.append(
                f"pb_inst_pbonly(0x{inst.output_state:06X}, STOP, 0, {max(inst.length_ns, 100.0):.0f}*ns)  # {inst.label or ''}"
            )
        else:
            lines.append(
                f"pb_inst_pbonly(0x{inst.output_state:06X}, CONTINUE, 0, {inst.length_ns:.0f}*ns)  # {inst.label or ''}"
            )
    return "\n".join(lines) + "\n"
