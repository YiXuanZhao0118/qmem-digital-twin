"""Finite-extinction leakage for the live PBS / beam_splitter anchor op
(anchor_ops/pbs.py). Without an extinction spec the split is ideal (pure p
transmits, pure s reflects); with a Glan-Laser spec the rejected polarization
leaks into each port, energy-conservingly.

jones convention (anchor local basis): jones[0] = E_s (axisY), jones[1] = E_p
(axisZ). The op returns [out_p (transmit), out_s (reflect)].
"""

import math

import pytest

from app.optical import anchor_ops  # noqa: F401  (registers anchor ops)
from app.optical.anchor_tracer import (
    AnchorHit, AnchorOpContext, V3Anchor, V3AssetAnchorSnapshot, get_anchor_op,
)
from app.optical.beam_ray import Vec3, make_beam_ray


def _anchor() -> V3Anchor:
    # axisX = coating normal (reflection axis); the beam travels +x and the
    # mirror formula sends the s-branch back along -x for this normal.
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
        catalog_id="glan", kind="beam_splitter", anchors=[anchor],
    )
    base = {"lengthMm": 5.0, "refractiveIndex_o": 1.66}
    base.update(params)
    return AnchorOpContext(asset=asset, anchor=anchor, hit=hit, params=base, dynamic={})


def _ray(jones):
    return make_beam_ray(
        origin=Vec3(0, 0, 0), direction=Vec3(1, 0, 0),
        wavelength_nm=852, waist_radius_mm=1.0, power_mw=1.0,
    ).replaced(jones=jones)


def _mag2(j):
    return sum(c.real * c.real + c.imag * c.imag for c in j)


S = (complex(1, 0), complex(0, 0))   # pure s
P = (complex(0, 0), complex(1, 0))   # pure p


# ── ideal (no spec) keeps the perfect split ────────────────────────────────

def test_no_spec_pure_split():
    op = get_anchor_op("beam_splitter")
    out_p, out_s = op(_ray(P), _ctx())
    assert out_p.power_mw == pytest.approx(1.0, abs=1e-12)   # all p transmits
    assert out_s.power_mw == pytest.approx(0.0, abs=1e-12)
    out_p, out_s = op(_ray(S), _ctx())
    assert out_s.power_mw == pytest.approx(1.0, abs=1e-12)   # all s reflects
    assert out_p.power_mw == pytest.approx(0.0, abs=1e-12)


# ── finite extinction leaks the rejected pol into each port ─────────────────

def test_reflected_port_p_leak_at_30db():
    """Sp=30 dB ⇒ 10**-3 of incident p leaks into the reflected (s) port."""
    op = get_anchor_op("beam_splitter")
    out_p, out_s = op(_ray(P), _ctx(extinctionRatioSpDb=30, extinctionRatioPpDb=100000))
    assert out_s.power_mw == pytest.approx(1e-3, rel=1e-6)       # leak
    assert out_p.power_mw == pytest.approx(1.0 - 1e-3, rel=1e-9)  # rest transmits


def test_transmitted_port_s_leak_at_30db():
    """Pp=30 dB ⇒ 10**-3 of incident s leaks into the transmitted (p) port."""
    op = get_anchor_op("beam_splitter")
    out_p, out_s = op(_ray(S), _ctx(extinctionRatioPpDb=30, extinctionRatioSpDb=100000))
    assert out_p.power_mw == pytest.approx(1e-3, rel=1e-6)
    assert out_s.power_mw == pytest.approx(1.0 - 1e-3, rel=1e-9)


def test_energy_conserved_with_leak():
    """t_p + t_s == 1 for any input, leak or not (redistribute, never add)."""
    op = get_anchor_op("beam_splitter")
    a = math.sqrt(0.5)
    mixed = (complex(a, 0), complex(a, 0))  # 45° linear
    out_p, out_s = op(_ray(mixed), _ctx(extinctionRatioSpDb=20, extinctionRatioPpDb=15))
    assert out_p.power_mw + out_s.power_mw == pytest.approx(1.0, abs=1e-12)


def test_leaked_jones_is_the_rejected_component():
    """The reflected port's leaked amplitude sits on the p (jones[1]) slot."""
    op = get_anchor_op("beam_splitter")
    _, out_s = op(_ray(P), _ctx(extinctionRatioSpDb=30, extinctionRatioPpDb=100000))
    assert abs(out_s.jones[0]) == pytest.approx(0.0, abs=1e-12)        # no s in
    assert abs(out_s.jones[1]) == pytest.approx(math.sqrt(1e-3), rel=1e-6)


# ── per-branch slab index: transmit (e-ray) n_e, reflect (o-ray) n_o ────────

def test_per_branch_index_birefringent():
    """Glan calcite: the transmitted slab uses n_e, the reflected slab n_o, so
    the two branches advance the q-parameter by L/n_e vs L/n_o."""
    op = get_anchor_op("beam_splitter")
    L, n_e, n_o = 5.0, 1.48, 1.66
    a = math.sqrt(0.5)
    ray = _ray((complex(a, 0), complex(a, 0)))  # 45° linear ⇒ both branches live
    qx_in = ray.qx.real
    out_p, out_s = op(ray, _ctx(lengthMm=L, refractiveIndex_e=n_e, refractiveIndex_o=n_o))
    assert out_p.qx.real - qx_in == pytest.approx(L / n_e, abs=1e-9)
    assert out_s.qx.real - qx_in == pytest.approx(L / n_o, abs=1e-9)


def test_isotropic_cube_same_index_both_branches():
    """A PBS cube sets only the isotropic refractiveIndex ⇒ both branches use it."""
    op = get_anchor_op("beam_splitter")
    L, n = 10.0, 1.5168
    a = math.sqrt(0.5)
    ray = _ray((complex(a, 0), complex(a, 0)))
    qx_in = ray.qx.real
    out_p, out_s = op(ray, _ctx(lengthMm=L, refractiveIndex=n))
    assert out_p.qx.real - qx_in == pytest.approx(L / n, abs=1e-9)
    assert out_s.qx.real - qx_in == pytest.approx(L / n, abs=1e-9)
