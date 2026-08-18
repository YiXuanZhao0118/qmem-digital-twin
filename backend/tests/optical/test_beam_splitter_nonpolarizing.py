"""Non-polarizing branch of the PBS / beam_splitter anchor op
(anchor_ops/pbs.py). ``polarizing: false`` (Thorlabs BS0xx cubes) splits by
intensity at ``splitRatioTransmitted`` and leaves the polarization alone,
instead of the polarizing p-transmit / s-reflect split.

Same jones convention as test_pbs_extinction: jones[0] = E_s (axisY),
jones[1] = E_p (axisZ); the op returns [out_p (transmit), out_s (reflect)].
"""

import math

import pytest

from app.optical import anchor_ops  # noqa: F401  (registers anchor ops)
from app.optical.anchor_tracer import (
    AnchorHit, AnchorOpContext, V3Anchor, V3AssetAnchorSnapshot, get_anchor_op,
)
from app.optical.beam_ray import Vec3, make_beam_ray


def _anchor() -> V3Anchor:
    return V3Anchor(
        id="intercept_face",
        position_body=Vec3(0, 0, 0),
        axis_x_body=Vec3(1, 0, 0),
        axis_y_body=Vec3(0, 1, 0),
        axis_z_body=Vec3(0, 0, 1),
        aperture_mm=0.0,
    )


def _ctx(**params) -> AnchorOpContext:
    anchor = _anchor()
    hit = AnchorHit(
        slot=None, anchor=anchor, t_lab=0.0, hit_point_body=Vec3(0, 0, 0),
        offset_y_body=0.0, offset_z_body=0.0, cos_incidence=1.0,
    )
    asset = V3AssetAnchorSnapshot(
        catalog_id="bs041_step", kind="beam_splitter", anchors=[anchor],
    )
    # BS041: 1/2" N-BK7 cube, 10:90 (R:T), non-polarizing.
    base = {
        "polarizing": False,
        "splitRatioTransmitted": 0.9,
        "lengthMm": 12.7,
        "refractiveIndex_o": 1.5168,
        "refractiveIndex_e": 1.5168,
    }
    base.update(params)
    return AnchorOpContext(asset=asset, anchor=anchor, hit=hit, params=base, dynamic={})


def _ray(jones):
    return make_beam_ray(
        origin=Vec3(0, 0, 0), direction=Vec3(1, 0, 0),
        wavelength_nm=852, waist_radius_mm=1.0, power_mw=1.0,
    ).replaced(jones=jones)


S = (complex(1, 0), complex(0, 0))   # pure s
P = (complex(0, 0), complex(1, 0))   # pure p
A45 = (complex(math.sqrt(0.5), 0), complex(math.sqrt(0.5), 0))  # 45° linear


@pytest.mark.parametrize("jones", [S, P, A45], ids=["s", "p", "45deg"])
def test_split_ratio_is_polarization_independent(jones):
    """BS041 is 10:90 (R:T) for EVERY input polarization — that is the whole
    point of a non-polarizing cube, and the bug this branch fixes (the op used
    to send pure p 100% to the transmitted port)."""
    op = get_anchor_op("beam_splitter")
    out_p, out_s = op(_ray(jones), _ctx())
    assert out_p.power_mw == pytest.approx(0.9, abs=1e-12)
    assert out_s.power_mw == pytest.approx(0.1, abs=1e-12)


@pytest.mark.parametrize("jones", [S, P, A45], ids=["s", "p", "45deg"])
def test_polarization_state_preserved_on_both_ports(jones):
    """Both ports carry the input jones scaled by √T / √R — no rotation, no
    component dropped."""
    op = get_anchor_op("beam_splitter")
    out_p, out_s = op(_ray(jones), _ctx())
    for out, frac in ((out_p, 0.9), (out_s, 0.1)):
        for out_c, in_c in zip(out.jones, jones):
            assert out_c.real == pytest.approx(in_c.real * math.sqrt(frac), abs=1e-12)
            assert out_c.imag == pytest.approx(in_c.imag * math.sqrt(frac), abs=1e-12)


def test_missing_split_ratio_defaults_to_5050():
    op = get_anchor_op("beam_splitter")
    out_p, out_s = op(_ray(P), _ctx(splitRatioTransmitted=None))
    assert out_p.power_mw == pytest.approx(0.5, abs=1e-12)
    assert out_s.power_mw == pytest.approx(0.5, abs=1e-12)


def test_polarizing_true_keeps_the_pbs_split():
    """The new branch is gated on an EXPLICIT false — a PBS cube that happens
    to carry splitRatioTransmitted still splits by polarization."""
    op = get_anchor_op("beam_splitter")
    ctx = _ctx(polarizing=True, splitRatioTransmitted=0.9)
    out_p, out_s = op(_ray(P), ctx)
    assert out_p.power_mw == pytest.approx(1.0, abs=1e-12)
    assert out_s.power_mw == pytest.approx(0.0, abs=1e-12)


def test_missing_polarizing_key_keeps_the_pbs_split():
    """Legacy assets with no ``polarizing`` key are unchanged."""
    op = get_anchor_op("beam_splitter")
    ctx = _ctx()
    ctx.params.pop("polarizing")
    out_p, out_s = op(_ray(S), ctx)
    assert out_s.power_mw == pytest.approx(1.0, abs=1e-12)
    assert out_p.power_mw == pytest.approx(0.0, abs=1e-12)
