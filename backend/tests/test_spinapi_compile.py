"""Phase PB.4 — unit tests for the SpinCore opcode compiler.

These cover the pure compile_to_opcodes() function. The HTTP route is
covered by the broader integration tests when the DB has fixtures.
"""

from __future__ import annotations

from app.solvers.spinapi_compile import compile_to_opcodes, render_spinapi_python


def test_empty_inputs_returns_stop_only() -> None:
    insts = compile_to_opcodes(channels=[], programs_by_component={})
    assert len(insts) == 1
    assert insts[0].opcode == "STOP"


def test_single_gate_on_then_off_emits_two_continues() -> None:
    insts = compile_to_opcodes(
        channels=[
            {
                "channel_index": 5,
                "label": "AOM",
                "target_component_id": "aom-comp",
                "invert": False,
                "enabled": True,
            },
        ],
        programs_by_component={
            "aom-comp": {
                "object_id": "obj-1",
                "blocks": [
                    {
                        "t_start_ns": 0.0,
                        "t_end_ns": 1000.0,
                        "waveform_kind": "gate_on",
                        "params": {},
                    },
                    {
                        "t_start_ns": 1000.0,
                        "t_end_ns": 2000.0,
                        "waveform_kind": "gate_off",
                        "params": {},
                    },
                ],
            }
        },
    )
    # 2 CONTINUE + 1 STOP
    assert len(insts) == 3
    assert insts[0].opcode == "CONTINUE"
    # ch5 high during the on block
    assert insts[0].output_state == (1 << 5)
    assert insts[0].length_ns == 1000.0
    assert insts[1].output_state == 0
    assert insts[1].length_ns == 1000.0
    assert insts[2].opcode == "STOP"


def test_inverted_channel_flips_state() -> None:
    insts = compile_to_opcodes(
        channels=[
            {
                "channel_index": 6,
                "label": "EOM (active-low)",
                "target_component_id": "eom-comp",
                "invert": True,
                "enabled": True,
            },
        ],
        programs_by_component={
            "eom-comp": {
                "object_id": "obj-1",
                "blocks": [
                    {
                        "t_start_ns": 0.0,
                        "t_end_ns": 500.0,
                        "waveform_kind": "gate_on",
                        "params": {},
                    },
                ],
            }
        },
    )
    # gate_on raw -> True, inverted -> False -> bit 6 LOW.
    assert insts[0].output_state == 0
    assert insts[0].length_ns == 500.0


def test_two_channels_or_into_mask() -> None:
    insts = compile_to_opcodes(
        channels=[
            {
                "channel_index": 0,
                "label": "ch0",
                "target_component_id": "comp-a",
                "invert": False,
                "enabled": True,
            },
            {
                "channel_index": 7,
                "label": "ch7",
                "target_component_id": "comp-b",
                "invert": False,
                "enabled": True,
            },
        ],
        programs_by_component={
            "comp-a": {
                "object_id": "oa",
                "blocks": [
                    {
                        "t_start_ns": 0.0,
                        "t_end_ns": 1000.0,
                        "waveform_kind": "gate_on",
                        "params": {},
                    }
                ],
            },
            "comp-b": {
                "object_id": "ob",
                "blocks": [
                    {
                        "t_start_ns": 500.0,
                        "t_end_ns": 1500.0,
                        "waveform_kind": "gate_on",
                        "params": {},
                    }
                ],
            },
        },
    )
    # Edges: 0, 500, 1000, 1500 -> 3 CONTINUE intervals + STOP.
    assert len(insts) == 4
    # [0..500): only ch0
    assert insts[0].output_state == (1 << 0)
    # [500..1000): ch0 + ch7
    assert insts[1].output_state == (1 << 0) | (1 << 7)
    # [1000..1500): only ch7
    assert insts[2].output_state == (1 << 7)


def test_disabled_channel_emits_zero_even_with_program() -> None:
    insts = compile_to_opcodes(
        channels=[
            {
                "channel_index": 3,
                "label": "ch3",
                "target_component_id": "comp",
                "invert": False,
                "enabled": False,
            }
        ],
        programs_by_component={
            "comp": {
                "object_id": "o",
                "blocks": [
                    {
                        "t_start_ns": 0.0,
                        "t_end_ns": 1000.0,
                        "waveform_kind": "gate_on",
                        "params": {},
                    }
                ],
            }
        },
    )
    assert insts[0].output_state == 0


def test_python_renderer_produces_valid_calls() -> None:
    insts = compile_to_opcodes(
        channels=[
            {
                "channel_index": 5,
                "label": "AOM",
                "target_component_id": "comp",
                "invert": False,
                "enabled": True,
            }
        ],
        programs_by_component={
            "comp": {
                "object_id": "o",
                "blocks": [
                    {
                        "t_start_ns": 0.0,
                        "t_end_ns": 1000.0,
                        "waveform_kind": "gate_on",
                        "params": {},
                    }
                ],
            }
        },
    )
    src = render_spinapi_python(insts)
    assert "from spinapi" in src
    assert "pb_inst_pbonly(0x000020, CONTINUE, 0, 1000*ns)" in src
    assert "STOP" in src
