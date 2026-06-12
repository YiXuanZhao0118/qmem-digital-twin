"""The PBS / Glan split is referenced to the polarizer's OWN orientation, not
the world-up beam-local frame (anchor_ops/pbs.py, 2026-06-12).

Why this matters: an optical isolator's output Glan is rotated ~45° about the
beam vs the input Glan. With the old beam-local split BOTH prisms split on the
same axis, so the output prism TRANSMITTED the Faraday-rotated polarization it
should have REFLECTED. The fix rotates the incoming Jones into each polarizer's
plane-of-incidence frame (s = dir × axisX) before splitting.

These tests pin a single rotated Glan: a beam polarized along the Glan's own
reflect (s) axis must fully reflect, even though that same Jones vector is the
TRANSMIT (p) component in the world-up beam-local frame.
"""

import math

import pytest

from app.optical import anchor_ops  # noqa: F401  (registers anchor ops)
from app.optical.anchor_tracer import (
    AnchorHit, AnchorOpContext, V3Anchor, V3AssetAnchorSnapshot, get_anchor_op,
)
from app.optical.beam_ray import Vec3, make_beam_ray


def _ctx(axis_x: Vec3, axis_y: Vec3, axis_z: Vec3, **params) -> AnchorOpContext:
    anchor = V3Anchor(
        id="intercept_face", position_body=Vec3(0, 0, 0),
        axis_x_body=axis_x, axis_y_body=axis_y, axis_z_body=axis_z, aperture_mm=0.0,
    )
    hit = AnchorHit(slot=None, anchor=anchor, t_lab=0.0, hit_point_body=Vec3(0, 0, 0),
                    offset_y_body=0.0, offset_z_body=0.0, cos_incidence=1.0)
    asset = V3AssetAnchorSnapshot(catalog_id="glan", kind="beam_splitter", anchors=[anchor])
    base = {"lengthMm": 5.0}
    base.update(params)
    return AnchorOpContext(asset=asset, anchor=anchor, hit=hit, params=base, dynamic={})


def _ray(jones):
    return make_beam_ray(origin=Vec3(0, 0, 0), direction=Vec3(1, 0, 0),
                         wavelength_nm=852, waist_radius_mm=1.0, power_mw=1.0).replaced(jones=jones)


def test_split_follows_glan_clock_angle():
    """Beam +x; coating tilted at 45° in the x-z plane → axisX=(0.707,0,0.707).
    Then s_glan = dir × axisX = -y. A beam polarized along -y is the GLAN's
    reflect (s) axis, so it must FULLY REFLECT — but -y is the p (jones[1])
    component in the world-up beam-local frame, which the old code would have
    transmitted. This is the exact failure mode behind the isolator bug."""
    op = get_anchor_op("beam_splitter")
    ax = Vec3(math.sqrt(0.5), 0.0, math.sqrt(0.5))
    # Jones (0,1): in beam-local(+x) that is the p-axis = -y = the Glan's s-axis.
    out_p, out_s = op(_ray((complex(0, 0), complex(1, 0))),
                      _ctx(ax, Vec3(0, 1, 0), Vec3(0, 0, 1)))
    assert out_s.power_mw == pytest.approx(1.0, abs=1e-9)   # reflects (along Glan s)
    assert out_p.power_mw == pytest.approx(0.0, abs=1e-9)


def test_orthogonal_input_transmits_through_rotated_glan():
    """Same rotated Glan; a beam along the Glan's p-axis (= +z in beam-local for
    this geometry) must fully TRANSMIT."""
    op = get_anchor_op("beam_splitter")
    ax = Vec3(math.sqrt(0.5), 0.0, math.sqrt(0.5))
    # Jones (1,0): beam-local s = +z = the Glan's p-axis here.
    out_p, out_s = op(_ray((complex(1, 0), complex(0, 0))),
                      _ctx(ax, Vec3(0, 1, 0), Vec3(0, 0, 1)))
    assert out_p.power_mw == pytest.approx(1.0, abs=1e-9)   # transmits (along Glan p)
    assert out_s.power_mw == pytest.approx(0.0, abs=1e-9)
