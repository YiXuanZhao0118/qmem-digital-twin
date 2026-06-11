"""Thick-lens ABCD path of the lens anchor op (short-focus / aspheric).

Guards the sign convention against the retired LA1509 golden matrix, checks
EFL/BFL come out right, and that a collimated beam focuses at back_vertex+BFL
(not the thin-lens approximation that collapses the principal planes).
"""

import math

import pytest

from app.optical import anchor_ops  # noqa: F401  (register ops)
from app.optical.anchor_ops.lens import _thick_lens_abcd
from app.optical.anchor_tracer import (
    AnchorHit, AnchorOpContext, V3Anchor, V3AssetAnchorSnapshot, get_anchor_op,
)
from app.optical.beam_ray import Vec3, make_beam_ray


# ── ABCD sign convention vs the LA1509 golden (thorlabs_la1509_b.json) ─────

def test_abcd_matches_la1509_golden():
    # Convex-first: R1=51.5 (convex front), R2=∞ (flat back), n=1.5168, d=3.6.
    a, b, c, d = _thick_lens_abcd(51.5, None, 1.5168, 3.6)
    assert a == pytest.approx(0.976183, abs=1e-5)
    assert b == pytest.approx(2.373419, abs=1e-5)
    assert c == pytest.approx(-0.010035, abs=1e-5)
    assert d == pytest.approx(1.0, abs=1e-9)
    assert (-1.0 / c) == pytest.approx(99.65, abs=0.1)   # EFL


def test_abcd_a230tm_b_fit_efl_and_bfl():
    # Datasheet-equivalent radii fitted to EFL=4.51, BFL=WD=2.53 (n=1.59, d=2.75).
    a, b, c, d = _thick_lens_abcd(2.3244, 10.308, 1.59, 2.75)
    assert (-1.0 / c) == pytest.approx(4.51, abs=0.01)        # EFL
    assert (-a / c) == pytest.approx(2.53, abs=0.01)          # BFL


# ── op end-to-end: collimated beam focuses at back_vertex + BFL ────────────

A_FRONT = V3Anchor(
    id="intercept_in",
    position_body=Vec3(0, 0, 0),
    axis_x_body=Vec3(0, 0, 1),     # optical axis +z
    axis_y_body=Vec3(0, 1, 0),
    axis_z_body=Vec3(1, 0, 0),
    aperture_mm=0.0,               # no clip for this focus test
)


def _ctx(params: dict) -> AnchorOpContext:
    hit = AnchorHit(
        slot=None, anchor=A_FRONT, t_lab=0.0, hit_point_body=Vec3(0, 0, 0),
        offset_y_body=0.0, offset_z_body=0.0, cos_incidence=1.0,
    )
    asset = V3AssetAnchorSnapshot(
        catalog_id="a230tm_b_step", kind="lens_plano_convex",
        anchors=[A_FRONT], default_params=params,
    )
    return AnchorOpContext(asset=asset, anchor=A_FRONT, hit=hit,
                           params=params, dynamic={})


def _collimated_ray():
    # Big waist ⇒ huge Rayleigh range ⇒ effectively collimated at the lens.
    return make_beam_ray(
        origin=Vec3(0, 0, 0), direction=Vec3(0, 0, 1),
        wavelength_nm=852.347, waist_radius_mm=5.0, power_mw=50.0,
    )


def test_thick_collimated_focuses_at_bfl_behind_back_vertex():
    d_mm = 2.75
    params = {
        "focalLengthMm": 4.51, "radiusFrontMm": 2.3244, "radiusBackMm": 10.308,
        "refractiveIndex": 1.59, "centerThicknessMm": d_mm,
    }
    op = get_anchor_op("lens_plano_convex")
    [out] = op(_collimated_ray(), _ctx(params))
    # Output emitted at the back vertex (front anchor z=0 + d along +z).
    assert out.origin.z == pytest.approx(d_mm, abs=1e-6)
    # Waist (Re(q)=0) forms at distance −Re(q') ahead ⇒ BFL beyond back vertex.
    bfl = 2.53
    assert -out.qx.real == pytest.approx(bfl, abs=0.03)
    assert -out.qy.real == pytest.approx(bfl, abs=0.03)
    # Focus location along the axis = back vertex + BFL.
    assert out.origin.z + (-out.qx.real) == pytest.approx(d_mm + bfl, abs=0.03)


def test_thick_vs_thin_focus_differs_by_principal_plane_hiatus():
    op = get_anchor_op("lens_plano_convex")
    thick = {
        "focalLengthMm": 4.51, "radiusFrontMm": 2.3244, "radiusBackMm": 10.308,
        "refractiveIndex": 1.59, "centerThicknessMm": 2.75,
    }
    thin = {"focalLengthMm": 4.51}
    [ot] = op(_collimated_ray(), _ctx(thick))
    [on] = op(_collimated_ray(), _ctx(thin))
    # Absolute focus z (origin.z + distance-to-waist).
    z_thick = ot.origin.z + (-ot.qx.real)
    z_thin = on.origin.z + (-on.qx.real)
    # Thick focus sits at WD (2.53) behind the back vertex (z = 2.75 + 2.53).
    assert z_thick == pytest.approx(2.75 + 2.53, abs=0.03)
    # Thin focus sits at f behind the single plane (z ≈ 4.51) — they differ by
    # the principal-plane hiatus, ~0.77 mm here.
    assert z_thin == pytest.approx(4.51, abs=0.05)
    assert abs(z_thick - z_thin) > 0.5


def test_thin_fallback_when_no_thick_params():
    op = get_anchor_op("lens_plano_convex")
    [out] = op(_collimated_ray(), _ctx({"focalLengthMm": 4.51}))
    assert out.origin.z == pytest.approx(0.0, abs=1e-9)   # no back-vertex shift
