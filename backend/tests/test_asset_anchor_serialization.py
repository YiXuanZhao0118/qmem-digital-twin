"""Regression: assets created/updated via the API must store anchors with
camelCase aliases, or the anchor ray-tracer's scene loader silently drops
them and the beam passes straight through (no anchor hit).

The bug: ``create_asset`` / ``update_asset`` dumped the payload with
``model_dump()`` (no ``by_alias``), so the typed ``anchors`` nested models
serialised to snake_case (``axis_x_body_local`` …). The loader
``anchor_asset_to_snapshot`` reads the raw JSON column and requires the
camelCase ``axisXBodyLocal`` key. ``_anchors_camel`` fixes the serialisation.
"""
from types import SimpleNamespace

from app.optical.db_scene_loader import anchor_asset_to_snapshot
from app.routers.assets import _anchors_camel
from app.schemas import Asset3DCreate

_PAYLOAD = {
    "name": "Test Plano-Convex",
    "assetType": "stl",
    "filePath": "files/stl/x.stl",
    "kindId": "lens_plano_convex",
    "defaultParams": {"focalLengthMm": 100},
    "anchors": [
        {
            "id": "intercept_in",
            "positionMmBodyLocal": {"x": 0, "y": 0, "z": -1.8},
            "axisXBodyLocal": {"x": 0, "y": 0, "z": 1},
            "axisYBodyLocal": {"x": 0, "y": 1, "z": 0},
            "axisZBodyLocal": {"x": -1, "y": 0, "z": 0},
            "apertureMm": 6.4,
            "apertureShape": "circle",
        }
    ],
}


def _fake_asset(anchors):
    return SimpleNamespace(
        kind_id="lens_plano_convex", anchors=anchors, catalog_id="test",
        name="Test", default_params={"focalLengthMm": 100},
    )


def test_plain_model_dump_anchors_are_not_traceable():
    """Guards the failure mode: a snake_case anchor blob is rejected by the
    loader (this is what the unfixed endpoint produced)."""
    payload = Asset3DCreate(**_PAYLOAD)
    snake = payload.model_dump()["anchors"]
    assert "axisXBodyLocal" not in snake[0]
    assert anchor_asset_to_snapshot(_fake_asset(snake)) is None


def test_anchors_camel_are_traceable():
    """The endpoint serialiser emits camelCase aliases the loader accepts."""
    payload = Asset3DCreate(**_PAYLOAD)
    camel = _anchors_camel(payload.anchors)
    assert "axisXBodyLocal" in camel[0]
    assert "positionMmBodyLocal" in camel[0]
    snap = anchor_asset_to_snapshot(_fake_asset(camel))
    assert snap is not None
    assert snap.anchors[0].id == "intercept_in"
