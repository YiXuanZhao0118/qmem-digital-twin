"""Unit tests for the SpinCore opcode compiler.

After alembic 0046 the compiler takes a single ``programs`` list where each
program carries its own ``channel_index`` + ``invert`` inline (the separate
pulse_blaster_channels table is gone). Programs with ``channel_index = None``
are skipped (unbound).
"""

from __future__ import annotations

from app.solvers.spinapi_compile import compile_to_opcodes, render_spinapi_python


def test_empty_inputs_returns_stop_only() -> None:
    insts = compile_to_opcodes(programs=[])
    assert len(insts) == 1
    assert insts[0].opcode == "STOP"


def test_unbound_program_is_skipped() -> None:
    insts = compile_to_opcodes(
        programs=[
            {
                "id": "p1",
                "kind": "TTL",
                "channel_index": None,  # logical only, no wire
                "invert": False,
                "intervals": [{"spinCoreStartNs": 0.0, "spinCoreEndNs": 1000.0}],
            }
        ]
    )
    # No bound programs ⇒ STOP only.
    assert len(insts) == 1
    assert insts[0].opcode == "STOP"


def test_single_high_interval_emits_continue_then_low_then_stop() -> None:
    insts = compile_to_opcodes(
        programs=[
            {
                "id": "p1",
                "kind": "TTL",
                "channel_index": 5,
                "invert": False,
                "intervals": [
                    {"spinCoreStartNs": 0.0, "spinCoreEndNs": 1000.0},
                    # Gap [1000..2000) — implicit LOW between intervals
                    {"spinCoreStartNs": 2000.0, "spinCoreEndNs": 3000.0},
                ],
            }
        ]
    )
    # Edges: 0, 1000, 2000, 3000 -> 3 CONTINUE intervals + STOP.
    assert len(insts) == 4
    assert insts[0].opcode == "CONTINUE"
    assert insts[0].output_state == (1 << 5)
    assert insts[0].length_ns == 1000.0
    assert insts[1].output_state == 0
    assert insts[1].length_ns == 1000.0
    assert insts[2].output_state == (1 << 5)
    assert insts[2].length_ns == 1000.0
    assert insts[3].opcode == "STOP"


def test_inverted_program_flips_state() -> None:
    insts = compile_to_opcodes(
        programs=[
            {
                "id": "p1",
                "kind": "TTL",
                "channel_index": 6,
                "invert": True,
                "intervals": [{"spinCoreStartNs": 0.0, "spinCoreEndNs": 500.0}],
            }
        ]
    )
    # raw HIGH during interval, inverted -> bit 6 LOW.
    assert insts[0].output_state == 0
    assert insts[0].length_ns == 500.0


def test_two_programs_or_into_mask() -> None:
    insts = compile_to_opcodes(
        programs=[
            {
                "id": "p1",
                "kind": "TTL",
                "channel_index": 0,
                "invert": False,
                "intervals": [{"spinCoreStartNs": 0.0, "spinCoreEndNs": 1000.0}],
            },
            {
                "id": "p2",
                "kind": "TTL",
                "channel_index": 7,
                "invert": False,
                "intervals": [{"spinCoreStartNs": 500.0, "spinCoreEndNs": 1500.0}],
            },
        ]
    )
    # Edges: 0, 500, 1000, 1500 -> 3 CONTINUE intervals + STOP.
    assert len(insts) == 4
    # [0..500): only ch0
    assert insts[0].output_state == (1 << 0)
    # [500..1000): ch0 + ch7
    assert insts[1].output_state == (1 << 0) | (1 << 7)
    # [1000..1500): only ch7
    assert insts[2].output_state == (1 << 7)


def test_trigger_kind_compiles_same_as_ttl() -> None:
    """``kind`` is metadata only — the PB opcode stream is identical."""
    common = {
        "channel_index": 5,
        "invert": False,
        "intervals": [{"spinCoreStartNs": 0.0, "spinCoreEndNs": 1000.0}],
    }
    ttl_insts = compile_to_opcodes(programs=[{"id": "p", "kind": "TTL", **common}])
    trig_insts = compile_to_opcodes(programs=[{"id": "p", "kind": "Trigger", **common}])
    assert [
        (i.opcode, i.output_state, i.length_ns) for i in ttl_insts
    ] == [(i.opcode, i.output_state, i.length_ns) for i in trig_insts]


def test_python_renderer_produces_valid_calls() -> None:
    insts = compile_to_opcodes(
        programs=[
            {
                "id": "p",
                "kind": "TTL",
                "channel_index": 5,
                "invert": False,
                "intervals": [{"spinCoreStartNs": 0.0, "spinCoreEndNs": 1000.0}],
            }
        ]
    )
    src = render_spinapi_python(insts)
    assert "from spinapi" in src
    assert "pb_inst_pbonly(0x000020, CONTINUE, 0, 1000*ns)" in src


def test_snake_case_interval_keys_also_accepted() -> None:
    insts = compile_to_opcodes(
        programs=[
            {
                "id": "p",
                "kind": "TTL",
                "channel_index": 0,
                "invert": False,
                "intervals": [{"spin_core_start_ns": 0.0, "spin_core_end_ns": 500.0}],
            }
        ]
    )
    assert insts[0].output_state == (1 << 0)
    assert insts[0].length_ns == 500.0
