"""Unit tests for the AOM default-anchor backfill migration helpers.

The alembic upgrade in `0021_aom_default_anchors` is mostly a SQL
walk; the interesting logic is in `_derive_anchor_geometry` and
`_build_default_port_anchors`, which translate `Component.properties`
into a sensible (intercept_in, intercept_out, apertureMm) triple.

These tests pin the property → geometry mapping for the three
property shapes the migration sees in the wild:
  * Full MT80-A1.5-IR shape (housing length + opticalAxisFromEndMm +
    activeApertureMm — the case we authored the migration for)
  * Generic AOM with only dimensionsMm + clearApertureMm — falls
    back to ports near the housing ends with the clear aperture.
  * Stubby Component.properties with no geometry hints — uses the
    50 mm / 1 mm safety floor so PHY Editor still has something
    sensible to render.
"""

from __future__ import annotations

import importlib.util
import pathlib

# The migration files aren't a Python package (alembic loads them by
# path), so import the helpers via importlib spec.
_MIGRATION_PATH = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0021_aom_default_anchors.py"
_spec = importlib.util.spec_from_file_location("alembic_0021", _MIGRATION_PATH)
assert _spec is not None and _spec.loader is not None
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)  # type: ignore[attr-defined]

_derive_anchor_geometry = _module._derive_anchor_geometry  # type: ignore[attr-defined]
_build_default_port_anchors = _module._build_default_port_anchors  # type: ignore[attr-defined]


def test_mt80_full_properties_match_outline_drawing():
    """MT80-A1.5-IR housing 59.5 mm × axis 18 mm in from each end →
    ports at body Y = ±11.75 mm; active aperture 1.5 mm → radius 0.75."""
    anchors = _build_default_port_anchors({
        "dimensionsMm": [59.5, 22.4, 17.3],
        "bodyLengthMm": 50.9,
        "opticalAxisHeightMm": 8,
        "opticalAxisFromEndMm": 18,
        "activeApertureMm": 1.5,
        "clearApertureMm": 3.9,
    })
    by_id = {a["id"]: a for a in anchors}
    assert set(by_id) == {"intercept_in", "intercept_out"}
    assert by_id["intercept_in"]["positionMmBodyLocal"] == {
        "x": 0.0, "y": -11.75, "z": 0.0,
    }
    assert by_id["intercept_out"]["positionMmBodyLocal"] == {
        "x": 0.0, "y": 11.75, "z": 0.0,
    }
    assert by_id["intercept_in"]["apertureMm"] == 0.75
    assert by_id["intercept_out"]["apertureMm"] == 0.75
    # Direction normals point OUT of the body along the optical axis
    # (Blender +Y for exit, -Y for entry).
    assert by_id["intercept_in"]["directionBodyLocal"] == {"x": 0.0, "y": 1.0, "z": 0.0}
    assert by_id["intercept_out"]["directionBodyLocal"] == {"x": 0.0, "y": -1.0, "z": 0.0}


def test_generic_aom_falls_back_to_clear_aperture():
    """Vendor without active-aperture metadata → use clearApertureMm/2 as
    the anchor aperture; port positions still derived from
    dimensionsMm + opticalAxisFromEndMm."""
    anchors = _build_default_port_anchors({
        "dimensionsMm": [60.0, 30.0, 20.0],
        "opticalAxisFromEndMm": 15,
        "clearApertureMm": 4.0,
    })
    by_id = {a["id"]: a for a in anchors}
    assert by_id["intercept_in"]["positionMmBodyLocal"]["y"] == -15.0
    assert by_id["intercept_out"]["positionMmBodyLocal"]["y"] == 15.0
    assert by_id["intercept_in"]["apertureMm"] == 2.0
    assert by_id["intercept_out"]["apertureMm"] == 2.0


def test_stub_properties_use_safety_floor():
    """No geometry hints → 50 mm fallback length, 1 mm fallback
    aperture; the two anchors must still be distinct so the migration
    doesn't collapse the midpoint pivot onto a single point."""
    anchors = _build_default_port_anchors({})
    by_id = {a["id"]: a for a in anchors}
    in_y = by_id["intercept_in"]["positionMmBodyLocal"]["y"]
    out_y = by_id["intercept_out"]["positionMmBodyLocal"]["y"]
    assert in_y == -out_y
    assert abs(out_y - in_y) > 1.0  # ports separated, midpoint well-defined
    assert by_id["intercept_in"]["apertureMm"] == 1.0


def test_short_body_safety_floor_kicks_in():
    """opticalAxisFromEndMm > housingLength/2 would produce a negative
    or near-zero body_y_offset — the migration's safety floor must
    expand it to length/4 so the two ports never collapse."""
    geom = _derive_anchor_geometry({
        "dimensionsMm": [40.0, 20.0, 15.0],
        "opticalAxisFromEndMm": 25,  # bigger than half — degenerate
        "activeApertureMm": 1.5,
    })
    # Half-length is 20; nominal would be 20-25 = -5 → safety floor
    # promotes to 40/4 = 10.
    assert geom["body_y_offset"] == 10.0


def test_active_aperture_takes_priority_over_clear_aperture():
    """When both `activeApertureMm` and `clearApertureMm` exist, the
    active aperture wins — that's the Bragg-mode useful aperture, not
    the through-hole."""
    anchors = _build_default_port_anchors({
        "dimensionsMm": [50.0, 20.0, 15.0],
        "opticalAxisFromEndMm": 10,
        "activeApertureMm": 1.5,
        "clearApertureMm": 4.0,
    })
    assert anchors[0]["apertureMm"] == 0.75  # 1.5 / 2 = active radius
