"""Unit tests for the SpinCore opcode compiler.

After alembic 0051 the compiler takes a single ``programs`` list and maps
list-index → PB output bit (positional channel ordering). The legacy
``kind``, ``channel_index``, and ``invert`` fields are gone; every
program is just ``{id, intervals[]}`` and the caller controls channel
order by sorting the list.
"""

from __future__ import annotations

from app.solvers.spinapi_compile import compile_to_opcodes, render_spinapi_python


def test_empty_inputs_returns_stop_only() -> None:
    insts = compile_to_opcodes(programs=[])
    assert len(insts) == 1
    assert insts[0].opcode == "STOP"


def test_program_with_no_intervals_emits_stop_only() -> None:
    insts = compile_to_opcodes(
        programs=[{"id": "p1", "intervals": []}]
    )
    # No edges anywhere ⇒ STOP only (the program contributes no boundary).
    assert len(insts) == 1
    assert insts[0].opcode == "STOP"


def test_single_high_interval_emits_continue_then_low_then_stop() -> None:
    insts = compile_to_opcodes(
        programs=[
            {
                "id": "p1",
                "intervals": [
                    {"spinCoreStartNs": 0.0, "spinCoreEndNs": 1000.0},
                    # Gap [1000..2000) — implicit LOW between intervals
                    {"spinCoreStartNs": 2000.0, "spinCoreEndNs": 3000.0},
                ],
            }
        ]
    )
    # Single program → bit 0. Edges: 0, 1000, 2000, 3000 → 3 CONTINUE + STOP.
    assert len(insts) == 4
    assert insts[0].opcode == "CONTINUE"
    assert insts[0].output_state == (1 << 0)
    assert insts[0].length_ns == 1000.0
    assert insts[1].output_state == 0
    assert insts[1].length_ns == 1000.0
    assert insts[2].output_state == (1 << 0)
    assert insts[2].length_ns == 1000.0
    assert insts[3].opcode == "STOP"


def test_two_programs_or_into_mask() -> None:
    insts = compile_to_opcodes(
        programs=[
            {
                "id": "p1",
                "intervals": [{"spinCoreStartNs": 0.0, "spinCoreEndNs": 1000.0}],
            },
            {
                "id": "p2",
                "intervals": [{"spinCoreStartNs": 500.0, "spinCoreEndNs": 1500.0}],
            },
        ]
    )
    # Positional channel mapping: p1 → bit 0, p2 → bit 1.
    # Edges: 0, 500, 1000, 1500 → 3 CONTINUE + STOP.
    assert len(insts) == 4
    # [0..500): only bit 0
    assert insts[0].output_state == (1 << 0)
    # [500..1000): bit 0 + bit 1
    assert insts[1].output_state == (1 << 0) | (1 << 1)
    # [1000..1500): only bit 1
    assert insts[2].output_state == (1 << 1)


def test_channel_ordering_is_positional() -> None:
    """Channel mapping is purely positional. Swapping list order swaps
    which PB bit each program lands on."""
    a = compile_to_opcodes(
        programs=[
            {"id": "a", "intervals": [{"spinCoreStartNs": 0.0, "spinCoreEndNs": 100.0}]},
            {"id": "b", "intervals": []},
        ]
    )
    b = compile_to_opcodes(
        programs=[
            {"id": "b", "intervals": []},
            {"id": "a", "intervals": [{"spinCoreStartNs": 0.0, "spinCoreEndNs": 100.0}]},
        ]
    )
    assert a[0].output_state == (1 << 0)
    assert b[0].output_state == (1 << 1)


def test_python_renderer_produces_valid_calls() -> None:
    insts = compile_to_opcodes(
        programs=[
            {
                "id": "p",
                "intervals": [{"spinCoreStartNs": 0.0, "spinCoreEndNs": 1000.0}],
            }
        ]
    )
    src = render_spinapi_python(insts)
    assert "from spinapi" in src
    # Single program at position 0 → bit 0 set in output_state.
    assert "pb_inst_pbonly(0x000001, CONTINUE, 0, 1000*ns)" in src


def test_snake_case_interval_keys_also_accepted() -> None:
    insts = compile_to_opcodes(
        programs=[
            {
                "id": "p",
                "intervals": [{"spin_core_start_ns": 0.0, "spin_core_end_ns": 500.0}],
            }
        ]
    )
    assert insts[0].output_state == (1 << 0)
    assert insts[0].length_ns == 500.0
