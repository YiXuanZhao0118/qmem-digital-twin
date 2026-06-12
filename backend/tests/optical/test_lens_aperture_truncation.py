"""Lens anchor-op clear-aperture energy truncation (POP Stage 1).

A beam wider than the lens clear aperture loses its wings: the on-axis
Gaussian fraction ``1 − exp(−2a²/w²)``. Combined with the coating
``transmittance`` factor, this attenuates the outgoing ``power_mw``. The
diffraction *pattern* from the same truncation is the separate POP field
channel — here we only assert the energy bookkeeping.
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
from app.optical.aperture import gaussian_circular_aperture_fraction
from app.optical.beam_ray import Vec3, make_beam_ray


def _anchor(aperture_mm: float) -> V3Anchor:
    return V3Anchor(
        id="intercept_in",
        position_body=Vec3(0, 0, 0),
        axis_x_body=Vec3(1, 0, 0),
        axis_y_body=Vec3(0, 1, 0),
        axis_z_body=Vec3(0, 0, 1),
        aperture_mm=aperture_mm,
    )


def _ctx(aperture_mm: float, *, f_mm=100.0, transmittance=None) -> AnchorOpContext:
    anchor = _anchor(aperture_mm)
    hit = AnchorHit(
        slot=None, anchor=anchor, t_lab=0.0,
        hit_point_body=Vec3(0, 0, 0),
        offset_y_body=0.0, offset_z_body=0.0, cos_incidence=1.0,
    )
    asset = V3AssetAnchorSnapshot(
        catalog_id="a230tm_b", kind="lens_plano_convex", anchors=[anchor],
    )
    params = {"focalLengthMm": f_mm}
    if transmittance is not None:
        params["transmittance"] = transmittance
    return AnchorOpContext(
        asset=asset, anchor=anchor, hit=hit, params=params, dynamic={},
    )


def _waist_ray(w0_mm: float) -> "BeamRay":
    # Beam at its waist (origin = waist) ⇒ q = i·zR ⇒ gaussian width = w0.
    return make_beam_ray(
        origin=Vec3(0, 0, 0), direction=Vec3(1, 0, 0),
        wavelength_nm=780, waist_radius_mm=w0_mm, power_mw=1.0,
    )


# ── aperture fraction closed-form limits ──────────────────────────────────

def test_fraction_full_when_aperture_dominates():
    assert gaussian_circular_aperture_fraction(0.5, 20.0) == pytest.approx(1.0, abs=1e-9)


def test_fraction_w_equals_a_is_one_minus_e_minus_2():
    assert gaussian_circular_aperture_fraction(2.0, 2.0) == pytest.approx(
        1.0 - math.exp(-2.0), abs=1e-12
    )


def test_fraction_unity_when_no_aperture():
    assert gaussian_circular_aperture_fraction(2.0, 0.0) == 1.0


# ── decentred beam still inside a large aperture ──────────────────────────
# Regression: a 1 mm beam sitting 8.76 mm off-axis in a 12.7 mm-radius lens is
# fully contained (8.76 + a few w < 12.7) ⇒ ~100% passes. The old pinhole-at-
# offset factor exp(−2·r_c²/w²) wrongly collapsed this to ~1e-71, blocking the
# beam at LENS_PLANO_CONVEX1.

def test_decentred_but_contained_beam_passes():
    # w_eff≈0.972, aperture 12.7, decenter 8.759 → true integral ≈ 1.0.
    assert gaussian_circular_aperture_fraction(0.972, 12.7, 8.759) == pytest.approx(
        1.0, abs=1e-6
    )


def test_decentred_at_the_rim_is_half():
    # Beam centre exactly on the aperture edge ⇒ knife-edge gives ½.
    assert gaussian_circular_aperture_fraction(0.5, 5.0, 5.0) == pytest.approx(
        0.5, abs=1e-9
    )


def test_decentred_well_outside_is_zero():
    # Centre several w beyond the rim ⇒ fully clipped.
    assert gaussian_circular_aperture_fraction(0.5, 2.0, 20.0) == 0.0


# ── lens op power attenuation ─────────────────────────────────────────────

def test_op_attenuates_power_by_aperture_and_transmittance():
    op = get_anchor_op("lens_plano_convex")
    [out] = op(_waist_ray(2.0), _ctx(2.0, transmittance=0.995))
    t_ap = 1.0 - math.exp(-2.0)
    assert out.power_mw == pytest.approx(1.0 * t_ap * 0.995, rel=1e-9)


def test_op_large_aperture_only_transmittance_loss():
    op = get_anchor_op("lens_plano_convex")
    [out] = op(_waist_ray(0.5), _ctx(20.0, transmittance=0.995))
    assert out.power_mw == pytest.approx(0.995, rel=1e-6)


def test_op_no_aperture_no_transmittance_preserves_power():
    # Back-compat: a lens asset with no aperture / no transmittance is lossless.
    op = get_anchor_op("lens_plano_convex")
    [out] = op(_waist_ray(0.5), _ctx(0.0))
    assert out.power_mw == pytest.approx(1.0, rel=1e-9)
