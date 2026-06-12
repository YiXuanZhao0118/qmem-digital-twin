"""Polarization through the PRODUCTION (anchor-op) Faraday rotator.

The live engine is `anchor_ops.misc_ops.faraday_anchor_op` (NOT the legacy
registry op in kinds/faraday_rotator/physics.py). Faraday rotation is
non-reciprocal: it is fixed about the lab B-field axis (anchor axisX), so
reversing the beam flips the rotation sign in the beam-local s/p frame —
which is what makes a round trip accumulate 2θ instead of cancelling.
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

ROD = V3Anchor(
    id="optical_center", position_body=Vec3(0, 0, 0),
    axis_x_body=Vec3(1, 0, 0), axis_y_body=Vec3(0, 1, 0), axis_z_body=Vec3(0, 0, 1),
    aperture_mm=5.0,
)


def _ctx(direction):
    hit = AnchorHit(slot=None, anchor=ROD, t_lab=1.0, hit_point_body=Vec3(0, 0, 0),
                    offset_y_body=0.0, offset_z_body=0.0, cos_incidence=1.0)
    asset = V3AssetAnchorSnapshot(catalog_id="fr", kind="faraday_rotator", anchors=[ROD])
    return AnchorOpContext(asset=asset, anchor=ROD, hit=hit,
                           params={"rotationDeg": 45, "lengthMm": 18,
                                   "refractiveIndex": 1.95}, dynamic={})


def _ray(jones, direction):
    r = make_beam_ray(origin=Vec3(-1, 0, 0), direction=direction,
                      wavelength_nm=780, power_mw=1.0)
    return r.replaced(jones=jones)


S = (complex(1, 0), complex(0, 0))   # pure s


def test_forward_rotates_plus_45_in_sp():
    """Forward (travelling +axisX): E_s'=cosθ·E_s+sinθ·E_p, E_p'=−sinθ·E_s+cosθ·E_p."""
    op = get_anchor_op("faraday_rotator")
    [out] = op(_ray(S, Vec3(1, 0, 0)), _ctx(Vec3(1, 0, 0)))
    a = math.sqrt(0.5)
    assert out.jones[0].real == pytest.approx(a, abs=1e-12)
    assert out.jones[1].real == pytest.approx(-a, abs=1e-12)


def test_reverse_flips_rotation_sign():
    """Travelling −axisX flips θ → opposite p component vs forward (this is
    the non-reciprocity: cancels in beam frame, but combined with the p̂
    flip on reversal it doubles in lab — the isolator signature)."""
    op = get_anchor_op("faraday_rotator")
    [fwd] = op(_ray(S, Vec3(1, 0, 0)), _ctx(Vec3(1, 0, 0)))
    [rev] = op(_ray(S, Vec3(-1, 0, 0)), _ctx(Vec3(-1, 0, 0)))
    a = math.sqrt(0.5)
    assert rev.jones[0].real == pytest.approx(a, abs=1e-12)
    assert rev.jones[1].real == pytest.approx(a, abs=1e-12)        # sign flipped vs forward
    assert rev.jones[1].real == pytest.approx(-fwd.jones[1].real, abs=1e-12)


def test_power_preserved():
    op = get_anchor_op("faraday_rotator")
    [out] = op(_ray(S, Vec3(1, 0, 0)), _ctx(Vec3(1, 0, 0)))
    assert out.power_mw == pytest.approx(1.0, abs=1e-12)
