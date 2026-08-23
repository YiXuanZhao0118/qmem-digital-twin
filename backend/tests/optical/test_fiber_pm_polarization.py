"""Polarization through a PM patch cord (`anchor_ops/fiber.py::_pm_transfer`).

A PM fibre is not a polarizer — it is a two-eigen-axis guide. What it gives
you is that a launch ON an axis stays on it, and that the twist between the
two connector keys comes out as a rotation. The slow axis of each end is
carried by that end's synthesized anchor **axisY** (the loader builds it from
`endX.slowAxisDegInBodyFrame`, `db_scene_loader._slow_axis_basis`).
"""

import math

import pytest

from app.optical import anchor_ops  # noqa: F401  (registers anchor ops)
from app.optical.anchor_tracer import (
    AnchorHit,
    AnchorOpContext,
    V3Anchor,
    V3AssetAnchorSnapshot,
    get_anchor_op,
)
from app.optical.beam_ray import Vec3, make_beam_ray

PER_DB = 25.0
LEAK = 10.0 ** (-PER_DB / 20.0)


def _end(anchor_id, x, slow_deg):
    """A fibre end whose axisY sits `slow_deg` from vertical, about +X."""
    a = math.radians(slow_deg)
    slow = Vec3(0.0, -math.sin(a), math.cos(a))
    fast = Vec3(0.0, -math.cos(a), -math.sin(a))
    return V3Anchor(id=anchor_id, position_body=Vec3(x, 0, 0),
                    axis_x_body=Vec3(1, 0, 0), axis_y_body=slow, axis_z_body=fast,
                    aperture_mm=0.125)


def _ctx(in_anchor, out_anchor, fiber_type="polarization_maintaining"):
    hit = AnchorHit(slot=None, anchor=in_anchor, t_lab=1.0,
                    hit_point_body=in_anchor.position_body,
                    offset_y_body=0.0, offset_z_body=0.0, cos_incidence=1.0)
    asset = V3AssetAnchorSnapshot(catalog_id="fiber", kind="fiber",
                                  anchors=[in_anchor, out_anchor])
    return AnchorOpContext(
        asset=asset, anchor=in_anchor, hit=hit,
        params={"coreMfdUm": 5.3, "numericalAperture": 0.12,
                "coreRefractiveIndex": 1.46, "attenuationDbPerKm": 4.0,
                "lengthM": 1.0, "fiberType": fiber_type,
                "polarizationExtinctionRatioDb": PER_DB},
        dynamic={})


def _launch(deg=0.0):
    """Linear launch `deg` from vertical. For +X propagation the beam-local
    s axis IS vertical, so s=cos / p=sin."""
    r = make_beam_ray(origin=Vec3(-1, 0, 0), direction=Vec3(1, 0, 0),
                      wavelength_nm=852, power_mw=1.0)
    a = math.radians(deg)
    return r.replaced(jones=(complex(math.cos(a), 0), complex(math.sin(a), 0)))


def _run(slow_a=0.0, slow_b=0.0, launch_deg=0.0, fiber_type="polarization_maintaining"):
    op = get_anchor_op("fiber")
    a, b = _end("intercept_in", 0.0, slow_a), _end("intercept_out", 100.0, slow_b)
    [out] = op(_launch(launch_deg), _ctx(a, b, fiber_type))
    return out


def test_on_axis_launch_stays_on_axis():
    """Launched on the slow axis, out on the slow axis — that is the whole
    point of PM fibre. Only the PER crosstalk appears on the other one."""
    out = _run(slow_a=0.0, slow_b=0.0, launch_deg=0.0)
    assert abs(out.jones[1]) / abs(out.jones[0]) == pytest.approx(LEAK, rel=1e-9)


def test_crosstalk_floor_is_the_declared_per():
    """polarizationExtinctionRatioDb means exactly: launch on one axis, this
    much POWER shows up on the other."""
    out = _run()
    ratio_db = 10.0 * math.log10(abs(out.jones[0]) ** 2 / abs(out.jones[1]) ** 2)
    assert ratio_db == pytest.approx(PER_DB, abs=1e-9)


def test_key_twist_rotates_the_output_polarization():
    """endA keyed vertical, endB keyed 30° over → a vertical launch leaves
    30° over. This is what makes slowAxisDegInBodyFrame worth setting."""
    out = _run(slow_a=0.0, slow_b=30.0, launch_deg=0.0)
    # Beam-local s is vertical, p is horizontal, so the tilt reads cos/sin.
    # The crosstalk mixing angle ε rides ON TOP of the twist (both are
    # rotations about the propagation axis, so they simply add) — at 25 dB
    # that is 3.22°, which is the whole visible effect of the PER here.
    tilt = math.radians(30.0) + math.atan(LEAK)
    assert abs(out.jones[0]) == pytest.approx(math.cos(tilt), rel=1e-9)
    assert abs(out.jones[1]) == pytest.approx(math.sin(tilt), rel=1e-9)


def test_launching_on_the_fast_axis_also_survives():
    """It is a guide, NOT a polarizer: 90° off the slow axis is not a loss,
    it just comes out on the fast axis."""
    on = _run(launch_deg=0.0)
    off = _run(launch_deg=90.0)
    assert off.power_mw == pytest.approx(on.power_mw, rel=1e-12)
    assert abs(off.jones[0]) / abs(off.jones[1]) == pytest.approx(LEAK, rel=1e-9)


def test_power_is_not_created_by_the_crosstalk():
    for deg in (0.0, 30.0, 45.0, 90.0):
        out = _run(launch_deg=deg)
        mag = abs(out.jones[0]) ** 2 + abs(out.jones[1]) ** 2
        assert mag == pytest.approx(1.0, rel=1e-9), f"launch {deg}°"


def test_single_mode_fiber_is_left_alone():
    """SM fibre scrambles polarization in reality; v1 passes it through
    rather than inventing a scramble the user cannot control."""
    out = _run(slow_a=0.0, slow_b=30.0, launch_deg=20.0, fiber_type="single_mode")
    ref = _launch(20.0)
    assert out.jones == ref.jones
