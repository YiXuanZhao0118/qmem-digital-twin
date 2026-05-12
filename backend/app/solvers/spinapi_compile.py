"""Phase PB.4 — compile PulseBlasterChannel bindings + per-Component
TimingPrograms into a SpinCore PulseBlaster opcode stream.

The output is a flat list of `PbInstruction` objects that mirror the
shape of `pb_inst_pbonly(flags, opcode, data, length)` calls in spinapi
(see SpinCore's spinapi C library / Python ctypes wrapper). Caller
code can feed the list into spinapi for real hardware execution, or
render it as a text dump for review.

Algorithm
---------
1. Collect all enabled PB channels with a `target_component_id`.
2. For each such channel, find every SceneObject of that component
   that owns a TimingProgram, take the FIRST program's blocks (a
   component with N instances normally shares one program). Apply
   the channel's `invert` flag.
3. Merge every block boundary (t_start_ns, t_end_ns) across all
   channels into a sorted, unique list of edge times.
4. For each interval [t_i, t_{i+1}]:
     a. For each channel, evaluate gate state at t_i.
     b. OR the gated bits into a 24-bit TTL output mask.
     c. Emit a CONTINUE instruction with that mask + length.
5. Append a STOP instruction at the end.

The compiler is pure: no DB session, no network calls. The router
hydrates channels + programs from the DB and hands them in.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional


@dataclass
class _Block:
    t_start_ns: float
    t_end_ns: float
    waveform_kind: str
    params: dict


@dataclass
class _Program:
    object_id: str
    blocks: list[_Block]


@dataclass
class _Channel:
    channel_index: int
    label: str
    target_component_id: Optional[str]
    invert: bool
    enabled: bool


@dataclass
class PbInstruction:
    """One row of the SpinCore opcode stream.

    `output_state` is a 24-bit integer — bit N high means physical
    channel N is HIGH at the start of `length_ns`. `opcode` follows
    SpinCore naming: CONTINUE / STOP / LOOP / END_LOOP / BRANCH /
    LONG_DELAY / WAIT. `data` is the opcode-dependent field (loop
    count, branch target, etc.); CONTINUE/STOP both ignore it.
    """

    index: int
    output_state: int
    opcode: str
    data: int
    length_ns: float
    label: Optional[str] = None


def _gate_at(block: _Block, t_ns: float) -> bool | None:
    kind = block.waveform_kind
    if kind == "gate_on":
        return True
    if kind == "gate_off":
        return False
    if kind == "const":
        p = block.params or {}
        if isinstance(p.get("gateOn"), bool):
            return p["gateOn"]
        if isinstance(p.get("amplitude"), (int, float)):
            return p["amplitude"] != 0
        return True
    if kind == "linear_ramp":
        return True
    if kind == "arbitrary":
        p = block.params or {}
        return bool(p.get("gateOn", True))
    return None


def _evaluate_program(program: _Program, t_ns: float) -> bool | None:
    """Find the block covering t_ns and return its gate state. Outside
    any block, the device is OFF — channels don't latch past a block's
    end, matching how SpinCore programs are normally authored (each
    interval gets an explicit drive)."""
    if not program.blocks:
        return None
    for b in program.blocks:
        if b.t_start_ns <= t_ns < b.t_end_ns:
            return _gate_at(b, t_ns)
    return False


def _channel_state_at(
    channel: _Channel,
    program: Optional[_Program],
    t_ns: float,
) -> bool:
    if not channel.enabled:
        return False
    if channel.target_component_id is None or program is None:
        return False
    raw = _evaluate_program(program, t_ns)
    if raw is None:
        return False
    return (not raw) if channel.invert else raw


def compile_to_opcodes(
    *,
    channels: Iterable[dict],
    programs_by_component: dict[str, dict],
) -> list[PbInstruction]:
    """Turn channel bindings + component-keyed programs into a stream.

    `channels` shape (each item):
      {channel_index, label, target_component_id, invert, enabled}
    `programs_by_component` shape:
      { component_id: {object_id, blocks: [{t_start_ns, t_end_ns, waveform_kind, params}, ...]}}
    """

    chans: list[_Channel] = []
    for c in channels:
        chans.append(
            _Channel(
                channel_index=int(c["channel_index"]),
                label=str(c.get("label") or ""),
                target_component_id=c.get("target_component_id"),
                invert=bool(c.get("invert", False)),
                enabled=bool(c.get("enabled", True)),
            )
        )

    progs: dict[str, _Program] = {}
    for comp_id, p in programs_by_component.items():
        progs[comp_id] = _Program(
            object_id=str(p.get("object_id", "")),
            blocks=[
                _Block(
                    t_start_ns=float(b["t_start_ns"]),
                    t_end_ns=float(b["t_end_ns"]),
                    waveform_kind=str(b["waveform_kind"]),
                    params=dict(b.get("params") or {}),
                )
                for b in (p.get("blocks") or [])
            ],
        )

    edges: set[float] = {0.0}
    for ch in chans:
        if not ch.enabled or ch.target_component_id is None:
            continue
        prog = progs.get(ch.target_component_id)
        if prog is None:
            continue
        for b in prog.blocks:
            edges.add(b.t_start_ns)
            edges.add(b.t_end_ns)

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
        for ch in chans:
            prog = (
                progs.get(ch.target_component_id)
                if ch.target_component_id
                else None
            )
            if _channel_state_at(ch, prog, t_start):
                mask |= 1 << ch.channel_index
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
    """Render the opcode stream as Python spinapi calls. Suitable for
    drop-in into a SpinCore Python script that has already initialized
    the board (pb_select_board / pb_init / pb_core_clock / pb_start_
    programming(PULSE_PROGRAM))."""

    lines: list[str] = [
        "# Auto-generated by qmem-digital-twin Phase PB.4",
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
