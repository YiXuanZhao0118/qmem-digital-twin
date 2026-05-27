import pytest

from app.optical.db_scene_loader import _apply_body_frame_to_anchor


def test_body_frame_origin_offsets_anchor_position_without_translating_axes():
    anchor = {
        "id": "intercept_out",
        "positionMmBodyLocal": {"x": 1, "y": 2, "z": 3},
        "axisXBodyLocal": {"x": 1, "y": 0, "z": 0},
        "axisYBodyLocal": {"x": 0, "y": 1, "z": 0},
        "axisZBodyLocal": {"x": 0, "y": 0, "z": 1},
    }

    out = _apply_body_frame_to_anchor(
        anchor,
        None,
        {"x": 10, "y": 20, "z": 30},
    )

    assert out["positionMmBodyLocal"] == {"x": 11.0, "y": 22.0, "z": 33.0}
    assert out["axisXBodyLocal"] == {"x": 1.0, "y": 0.0, "z": 0.0}


def test_body_frame_rotation_applies_before_origin_offset():
    s = 2 ** -0.5
    anchor = {
        "id": "intercept_out",
        "positionMmBodyLocal": {"x": 5, "y": 0, "z": 2},
        "axisXBodyLocal": {"x": 1, "y": 0, "z": 0},
        "axisYBodyLocal": {"x": 0, "y": 1, "z": 0},
        "axisZBodyLocal": {"x": 0, "y": 0, "z": 1},
    }

    out = _apply_body_frame_to_anchor(
        anchor,
        {"x": 0, "y": 0, "z": s, "w": s},
        {"x": 10, "y": 20, "z": 30},
    )

    assert out["positionMmBodyLocal"]["x"] == pytest.approx(10)
    assert out["positionMmBodyLocal"]["y"] == pytest.approx(25)
    assert out["positionMmBodyLocal"]["z"] == pytest.approx(32)
    assert out["axisXBodyLocal"]["x"] == pytest.approx(0)
    assert out["axisXBodyLocal"]["y"] == pytest.approx(1)
