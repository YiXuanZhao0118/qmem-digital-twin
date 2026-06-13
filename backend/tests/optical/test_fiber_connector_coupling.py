"""Connector-component fiber coupling through the v3 anchor tracer.

A fiber is now a Component composed of two `fiber_connector` assets
(passthrough). Its optical ports live only on the fiber PhysicsElement's
`kindParams.endA/endB`, so `db_scene_loader._synth_fiber_slot` synthesizes a
kind="fiber" slot (intercept_in/out) for the tracer. Without it the beam
passes straight through with no Marcuse coupling.

These tests cover:
  1. `_synth_fiber_slot` builds intercept_in/out at the optical tip
     (= junction posMm + outward·FIBER_FERRULE_TIP_MM, outward=−unit(tension)).
  2. The tracer COUPLES a centered ray (power × η, η>0) and emits from the
     far tip; an off-centre ray beyond the aperture passes through uncoupled.
"""

import asyncio
import types

import pytest

from app.optical import anchor_ops  # noqa: F401  (register fiber op)
from app.optical.anchor_tracer import (
    AnchorTraceOptions, V3Anchor, V3AnchorBindingSlot, V3AnchorScene,
    V3AssetAnchorSnapshot, trace_ray_anchor_scene,
)
from app.optical.beam_ray import Vec3, make_beam_ray
from app.optical.db_scene_loader import (
    FIBER_FERRULE_TIP_MM, _connector_tip_and_aperture, _synth_fiber_slot,
)
from app.optical.pose import V3Transform


def test_connector_tip_and_aperture_from_connect_in():
    """The optical-face offset + hit aperture come from the connector asset's
    connect_in (relative to connect_out) — the single asset-side definition."""
    connector = types.SimpleNamespace(anchors=[
        {"id": "connect_out", "positionMmBodyLocal": {"x": 0.0, "y": 0.0, "z": 0.0}},
        {"id": "connect_in", "positionMmBodyLocal": {"x": 20.0, "y": 0.0, "z": 0.0},
         "apertureMm": 2.0},
    ])
    tip, ap = _connector_tip_and_aperture(connector, 36.28, 0.125)
    assert tip == pytest.approx(20.0)   # from connect_in offset, NOT the 36.28 fallback
    assert ap == pytest.approx(2.0)     # from connect_in.apertureMm


def test_connector_tip_and_aperture_falls_back_without_connector():
    tip, ap = _connector_tip_and_aperture(None, 36.28, 0.125)
    assert tip == pytest.approx(36.28)
    assert ap == pytest.approx(0.125)


def test_synth_fiber_slot_builds_intercept_anchors():
    # endA junction at origin, wire extends +X (outward = −X);
    # endB junction at +300X, wire extends −X (outward = +X).
    so = types.SimpleNamespace(id="fiber0", properties=None)
    pe = types.SimpleNamespace(
        element_kind="fiber",
        kind_params={
            "endA": {"posMm": [0.0, 0.0, 0.0], "tensionHandleMm": [10.0, 0.0, 0.0],
                     "modeFieldDiameterUm": 5.3, "numericalAperture": 0.13,
                     "glassIndexAtDesignLambda": 1.45},
            "endB": {"posMm": [300.0, 0.0, 0.0], "tensionHandleMm": [-10.0, 0.0, 0.0]},
            "attenuationCurve": [{"wavelengthNm": 780.0, "dbPerKm": 5.0}],
        },
    )
    # binding_rows empty → connector lookup short-circuits → fallback aperture.
    slot = asyncio.run(_synth_fiber_slot(
        session=None, so=so, pe=pe, binding_rows=[],
        override_by_binding_id={}, so_transform=V3Transform(origin=Vec3(0, 0, 0)),
    ))
    assert slot is not None
    assert slot.asset.kind == "fiber"
    by_id = {a.id: a for a in slot.asset.anchors}
    assert set(by_id) == {"intercept_in", "intercept_out"}

    a_in = by_id["intercept_in"]
    # outward = −unit([10,0,0]) = (−1,0,0); tip = junction + outward·36.28.
    assert (a_in.axis_x_body.x, a_in.axis_x_body.y, a_in.axis_x_body.z) == \
        pytest.approx((-1.0, 0.0, 0.0), abs=1e-9)
    assert a_in.position_body.x == pytest.approx(-FIBER_FERRULE_TIP_MM)
    assert a_in.aperture_mm == pytest.approx(0.125)  # fallback (no connector)

    a_out = by_id["intercept_out"]
    assert (a_out.axis_x_body.x, a_out.axis_x_body.y, a_out.axis_x_body.z) == \
        pytest.approx((1.0, 0.0, 0.0), abs=1e-9)
    assert a_out.position_body.x == pytest.approx(300.0 + FIBER_FERRULE_TIP_MM)

    # Params mapped to the keys fiber_anchor_op reads (note the rename).
    dp = slot.asset.default_params
    assert dp["coreMfdUm"] == pytest.approx(5.3)
    assert dp["numericalAperture"] == pytest.approx(0.13)
    assert dp["coreRefractiveIndex"] == pytest.approx(1.45)
    assert dp["attenuationDbPerKm"] == pytest.approx(5.0)


def _fiber_scene(aperture_mm: float) -> V3AnchorScene:
    """Straight fiber along +Z: intercept_in at origin, intercept_out 50 mm
    downstream, both faces normal +Z."""
    in_anchor = V3Anchor(
        id="intercept_in", position_body=Vec3(0, 0, 0),
        axis_x_body=Vec3(0, 0, 1), axis_y_body=Vec3(0, 1, 0), axis_z_body=Vec3(1, 0, 0),
        aperture_mm=aperture_mm,
    )
    out_anchor = V3Anchor(
        id="intercept_out", position_body=Vec3(0, 0, 50),
        axis_x_body=Vec3(0, 0, 1), axis_y_body=Vec3(0, 1, 0), axis_z_body=Vec3(1, 0, 0),
        aperture_mm=aperture_mm,
    )
    snap = V3AssetAnchorSnapshot(
        catalog_id="fiber", kind="fiber", anchors=[in_anchor, out_anchor],
        default_params={
            "coreMfdUm": 5.3, "numericalAperture": 0.13,
            "coreRefractiveIndex": 1.46, "attenuationDbPerKm": 5.0, "lengthM": 1.0,
        },
    )
    slot = V3AnchorBindingSlot(
        scene_object_id="fiber0", binding_id="fiber_body", asset=snap,
        effective_transform=V3Transform(origin=Vec3(0, 0, 0)),
    )
    return V3AnchorScene(slots=[slot])


def test_centered_ray_couples_and_emits_from_far_tip():
    scene = _fiber_scene(aperture_mm=1.0)
    ray = make_beam_ray(
        origin=Vec3(0, 0, -1), direction=Vec3(0, 0, 1),
        wavelength_nm=780, waist_radius_mm=0.003, power_mw=1.0,
    )
    res = trace_ray_anchor_scene(ray, scene, AnchorTraceOptions())

    # Coupled: output power = in × η with 0 < η < 1 (Fresnel loss).
    assert res.final_rays, "expected a coupled output ray"
    out_power = res.final_rays[-1].power_mw
    assert 0.0 < out_power < 1.0
    # The fiber port was hit (intercept_in) and re-emitted from the far tip.
    hit_ids = {s.anchor_id for s in res.lab_segments}
    assert "intercept_in" in hit_ids
    # Emission originates at intercept_out (z = 50 in body == lab here).
    assert any(abs(s.start.z - 50.0) < 1e-6 for s in res.lab_segments)


def test_offcenter_ray_beyond_aperture_passes_through():
    scene = _fiber_scene(aperture_mm=1.0)
    # 5 mm off-axis ≫ 1 mm aperture → misses both fiber faces.
    ray = make_beam_ray(
        origin=Vec3(5, 0, -1), direction=Vec3(0, 0, 1),
        wavelength_nm=780, waist_radius_mm=0.003, power_mw=1.0,
    )
    res = trace_ray_anchor_scene(ray, scene, AnchorTraceOptions())

    hit_ids = {s.anchor_id for s in res.lab_segments}
    assert "intercept_in" not in hit_ids and "intercept_out" not in hit_ids
    # No coupling loss applied — beam passes straight through.
    if res.final_rays:
        assert res.final_rays[-1].power_mw == pytest.approx(1.0)
