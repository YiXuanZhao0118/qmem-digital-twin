"""Polarization through the PRODUCTION (anchor-op) waveplate + mirror.

Verifies the fast-axis-aware waveplate (linear → circular at 45°) and the
mirror's reflection Jones (handedness flip), plus the classic double pass
H → QWP(45°) → mirror → QWP → V (90° rotation).
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

WP = V3Anchor(
    id="intercept_in", position_body=Vec3(0, 0, 0),
    axis_x_body=Vec3(1, 0, 0), axis_y_body=Vec3(0, 1, 0), axis_z_body=Vec3(0, 0, 1),
    aperture_mm=5.0,
)
MIRROR = V3Anchor(
    id="reflection_surface", position_body=Vec3(0, 0, 0),
    axis_x_body=Vec3(1, 0, 0), axis_y_body=Vec3(0, 1, 0), axis_z_body=Vec3(0, 0, 1),
    aperture_mm=5.0,
)


def _wp_ctx(ret_deg, fast_deg=0.0):
    hit = AnchorHit(slot=None, anchor=WP, t_lab=1.0, hit_point_body=Vec3(0, 0, 0),
                    offset_y_body=0.0, offset_z_body=0.0, cos_incidence=1.0)
    asset = V3AssetAnchorSnapshot(catalog_id="wp", kind="waveplate", anchors=[WP])
    return AnchorOpContext(asset=asset, anchor=WP, hit=hit,
                           params={"retardanceDeg": ret_deg, "fastAxisDeg": fast_deg,
                                   "lengthMm": 2.0, "refractiveIndex": 1.55}, dynamic={})


def _mirror_ctx(anchor=MIRROR):
    hit = AnchorHit(slot=None, anchor=anchor, t_lab=1.0, hit_point_body=Vec3(0, 0, 0),
                    offset_y_body=0.0, offset_z_body=0.0, cos_incidence=1.0)
    asset = V3AssetAnchorSnapshot(catalog_id="m", kind="mirror", anchors=[anchor])
    return AnchorOpContext(asset=asset, anchor=anchor, hit=hit,
                           params={"reflectivity": 1.0}, dynamic={})


def _ray(jones, direction=Vec3(1, 0, 0)):
    r = make_beam_ray(origin=Vec3(-1, 0, 0), direction=direction,
                      wavelength_nm=780, power_mw=1.0)
    return r.replaced(jones=jones)


def _ellipticity(jones):
    """χ in degrees (0 = linear, ±45 = circular); sign = handedness."""
    (es, ep) = jones
    sre, sim, pre, pim = es.real, es.imag, ep.real, ep.imag
    I = sre * sre + sim * sim + pre * pre + pim * pim
    im_cross = sre * pim - sim * pre
    return math.degrees(0.5 * math.asin(max(-1.0, min(1.0, 2 * im_cross / I)))) if I > 1e-12 else 0.0


H = (complex(1, 0), complex(0, 0))   # along s


def test_qwp_fast45_makes_circular():
    op = get_anchor_op("waveplate")
    [out] = op(_ray(H), _wp_ctx(90, fast_deg=45))
    assert abs(_ellipticity(out.jones)) == pytest.approx(45, abs=0.5)  # circular


def test_hwp_fast45_rotates_H_to_V():
    op = get_anchor_op("waveplate")
    [out] = op(_ray(H), _wp_ctx(180, fast_deg=45))
    assert abs(out.jones[0]) == pytest.approx(0, abs=1e-6)   # no s
    assert abs(out.jones[1]) == pytest.approx(1, abs=1e-6)   # all p (= V)


def test_mirror_flips_circular_handedness():
    op = get_anchor_op("mirror")
    rcp = (complex(1, 0) / math.sqrt(2), complex(0, -1) / math.sqrt(2))
    chi_in = _ellipticity(rcp)
    [out] = op(_ray(rcp), _mirror_ctx())
    assert _ellipticity(out.jones) == pytest.approx(-chi_in, abs=0.5)  # handedness flipped


def test_double_pass_qwp_mirror_qwp_H_to_V():
    wp = get_anchor_op("waveplate")
    mir = get_anchor_op("mirror")
    [a] = wp(_ray(H), _wp_ctx(90, fast_deg=45))                 # H → circular
    assert abs(_ellipticity(a.jones)) == pytest.approx(45, abs=0.5)
    [b] = mir(_ray(a.jones), _mirror_ctx())                     # reflect (flip)
    # return pass: same waveplate, beam now travels −x
    [c] = wp(_ray(b.jones, direction=Vec3(-1, 0, 0)), _wp_ctx(90, fast_deg=45))
    assert abs(_ellipticity(c.jones)) == pytest.approx(0, abs=0.5)   # linear again
    assert abs(c.jones[0]) == pytest.approx(0, abs=1e-2)            # rotated to V
    assert abs(c.jones[1]) == pytest.approx(1, abs=1e-2)
