"""The Mach-Zehnder / fibre-pigtail half of `anchor_ops.misc_ops.eom_anchor_op`.

Two independent axes on one kind (see the plugin docstring):
  modulationKind  phase (Jones retardance) vs amplitude (power transmission)
  fiberPigtailed  free-space slab vs guided, re-emitted at intercept_out

The reference part is the EOSpace AZ-0S5-20-PFA-PFA-850/900: RF Vπ 2.5 V,
bias Vπ 1.4 V, insertion loss 3.5 dB, extinction ratio 18 dB.
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

PKG_MM = 100.0

# axisY is the TM / modulated axis. Body +Z, as the real device authors it
# (z-cut chip lying flat) — and for a +X-propagating beam that is exactly the
# beam-local s axis, so make_beam_ray's default jones (1, 0) launches ON it.
IN = V3Anchor(
    id="intercept_in", position_body=Vec3(0, 0, 0),
    axis_x_body=Vec3(1, 0, 0), axis_y_body=Vec3(0, 0, 1), axis_z_body=Vec3(0, -1, 0),
    aperture_mm=0.125,
)
OUT = V3Anchor(
    id="intercept_out", position_body=Vec3(PKG_MM, 0, 0),
    axis_x_body=Vec3(1, 0, 0), axis_y_body=Vec3(0, 0, 1), axis_z_body=Vec3(0, -1, 0),
    aperture_mm=0.125,
)

AZ_PARAMS = {
    "vPiV": 2.5,
    "biasVPiV": 1.4,
    "polarizationExtinctionRatioDb": 20.0,
    "modulationKind": "amplitude",
    "insertionLossDb": 3.5,
    "extinctionRatioDb": 18.0,
    "fiberPigtailed": True,
    "coreMfdUm": 5.3,
}

IL_LIN = 10.0 ** (-3.5 / 10.0)


def _ctx(params, dynamic=None, anchors=(IN, OUT)):
    hit = AnchorHit(slot=None, anchor=IN, t_lab=1.0, hit_point_body=Vec3(0, 0, 0),
                    offset_y_body=0.0, offset_z_body=0.0, cos_incidence=1.0)
    asset = V3AssetAnchorSnapshot(catalog_id="eom", kind="eom", anchors=list(anchors))
    return AnchorOpContext(asset=asset, anchor=IN, hit=hit,
                           params=params, dynamic=dynamic or {})


def _ray(direction=Vec3(1, 0, 0)):
    return make_beam_ray(origin=Vec3(-1, 0, 0), direction=direction,
                         wavelength_nm=852, power_mw=1.0)


def _run(dynamic=None, **overrides):
    """dynamic= is still passed as dynamic_sources, but the op reads the two
    knobs from ctx.params — so merge them the way the tracer does."""
    params = {**AZ_PARAMS, **overrides, **(dynamic or {})}
    op = get_anchor_op("eom")
    return op(_ray(), _ctx(params, dynamic))


# ── Mach-Zehnder transmission ──────────────────────────────────────────────

def test_peak_transmission_is_the_insertion_loss():
    """Unbiased, undriven → φ=0 → the datasheet 3.5 dB and nothing more."""
    [out] = _run()
    assert out.power_mw == pytest.approx(IL_LIN, rel=1e-12)


def test_v_pi_gives_the_datasheet_extinction_ratio():
    """A half-wave drive swings to the null; peak/null IS extinctionRatioDb."""
    [peak] = _run(dynamic={"driveVoltageV": 0.0})
    [null] = _run(dynamic={"driveVoltageV": 2.5})
    ratio_db = 10.0 * math.log10(peak.power_mw / null.power_mw)
    assert ratio_db == pytest.approx(18.0, abs=1e-9)


def test_bias_uses_its_own_v_pi():
    """Bias Vπ (1.4 V) is a separate electrode from the RF Vπ (2.5 V): half
    of it puts the modulator at quadrature, not half of the RF one."""
    [quad] = _run(dynamic={"biasVoltageV": 0.7})
    r = 10.0 ** 1.8
    m = (r - 1.0) / (r + 1.0)
    assert quad.power_mw == pytest.approx(IL_LIN / (1.0 + m), rel=1e-12)
    [null] = _run(dynamic={"biasVoltageV": 1.4})
    [peak] = _run()
    assert 10.0 * math.log10(peak.power_mw / null.power_mw) == pytest.approx(18.0, abs=1e-9)


def test_drive_and_bias_add_in_phase():
    """φ is the sum of the two normalised voltages — a bias at quadrature
    plus a quarter-wave drive lands on the same null as a full-wave drive."""
    [both] = _run(dynamic={"biasVoltageV": 0.7, "driveVoltageV": 1.25})
    [null] = _run(dynamic={"driveVoltageV": 2.5})
    assert both.power_mw == pytest.approx(null.power_mw, rel=1e-9)


def test_amplitude_mode_drive_does_not_touch_polarization():
    """The arms have already interfered — the drive is power, not retardance.
    An on-axis launch comes out on-axis whatever the drive is doing."""
    [a] = _run(dynamic={"driveVoltageV": 0.0})
    [b] = _run(dynamic={"driveVoltageV": 1.1})
    assert a.jones == b.jones


# ── Fibre-pigtail geometry ─────────────────────────────────────────────────

def test_pigtailed_output_leaves_the_exit_port_as_the_fibre_mode():
    op = get_anchor_op("eom")
    tilted = _ray(Vec3(1, 0.02, -0.01))
    [out] = op(tilted, _ctx(AZ_PARAMS))
    assert (out.origin.x, out.origin.y, out.origin.z) == (PKG_MM, 0.0, 0.0)
    # Tilt erased: the waveguide imposes its own mode on the way out.
    assert out.direction.x == pytest.approx(1.0, abs=1e-12)
    assert out.direction.y == pytest.approx(0.0, abs=1e-12)
    # Waist ON the exit face, w0 = MFD/2.
    w0_mm = 5.3 / 2.0 / 1000.0
    z_r = math.pi * w0_mm * w0_mm / (852.0 * 1e-6)
    assert out.qx.real == pytest.approx(0.0, abs=1e-12)
    assert out.qx.imag == pytest.approx(z_r, rel=1e-12)
    assert out.qx == out.qy
    assert out.qxy == 0j


def test_pigtailed_without_an_exit_port_is_malformed_not_silent():
    op = get_anchor_op("eom")
    assert op(_ray(), _ctx(AZ_PARAMS, anchors=(IN,))) == []


def test_bulk_part_still_uses_the_free_space_slab():
    """fiberPigtailed=False must keep the pre-existing geometry: the ray
    leaves from the ENTRY anchor, having propagated one slab internally."""
    op = get_anchor_op("eom")
    [out] = op(_ray(), _ctx({**AZ_PARAMS, "fiberPigtailed": False}))
    assert (out.origin.x, out.origin.y, out.origin.z) == (0.0, 0.0, 0.0)


# ── Phase mode is untouched ────────────────────────────────────────────────

def test_phase_mode_still_retards_the_slow_component():
    """Regression guard on the original op: for a BULK crystal (not a
    waveguide) δ = π·V/Vπ lands on jones[1] and power is untouched
    (insertionLossDb defaults to 0 dB on the kind)."""
    op = get_anchor_op("eom")
    params = {"modulationKind": "phase", "vPiV": 5.0, "driveVoltageV": 2.5}
    ray = _ray().replaced(jones=(complex(1, 0), complex(1, 0)))
    [out] = op(ray, _ctx(params, {"driveVoltageV": 2.5}))
    delta = math.pi * 0.5
    assert out.jones[0] == complex(1, 0)
    assert out.jones[1].real == pytest.approx(math.cos(delta), abs=1e-12)
    assert out.jones[1].imag == pytest.approx(math.sin(delta), abs=1e-12)
    assert out.power_mw == pytest.approx(1.0, rel=1e-12)


def test_phase_mode_honours_insertion_loss_when_declared():
    op = get_anchor_op("eom")
    params = {"modulationKind": "phase", "vPiV": 5.0, "insertionLossDb": 3.0}
    [out] = op(_ray(), _ctx(params, {}))
    assert out.power_mw == pytest.approx(10.0 ** -0.3, rel=1e-12)


# ── Waveguide polarization ─────────────────────────────────────────────────

def _ray_at(deg: float):
    """A linear launch `deg` away from the TM axis. TM is beam-local s here
    (see IN above), so s=cos, p=sin."""
    a = math.radians(deg)
    return _ray().replaced(jones=(complex(math.cos(a), 0), complex(math.sin(a), 0)))


def _run_ray(ray, **overrides):
    op = get_anchor_op("eom")
    return op(ray, _ctx({**AZ_PARAMS, **overrides}))


def test_cross_polarized_launch_is_rejected_at_the_waveguide_per():
    """A guided modulator is single-polarization: light on the wrong axis
    survives only at polarizationExtinctionRatioDb (20 dB here)."""
    [on] = _run_ray(_ray_at(0))
    [cross] = _run_ray(_ray_at(90))
    assert 10.0 * math.log10(on.power_mw / cross.power_mw) == pytest.approx(20.0, abs=1e-9)


def test_forty_five_degree_launch_loses_half_the_power():
    """Malus: only the TM projection is guided, so cos²45° = 1/2."""
    [on] = _run_ray(_ray_at(0))
    [half] = _run_ray(_ray_at(45))
    leak = 10.0 ** (-20.0 / 20.0)
    assert half.power_mw == pytest.approx(on.power_mw * 0.5 * (1.0 + leak * leak), rel=1e-9)


def test_output_is_linear_on_the_tm_axis_whatever_went_in():
    """Whatever the launch, what leaves a single-polarization waveguide is
    on its TM axis (bar the PER leak)."""
    [out] = _run_ray(_ray_at(45))
    leak = abs(out.jones[1]) / abs(out.jones[0])
    assert leak == pytest.approx(10.0 ** (-20.0 / 20.0), rel=1e-9)


def test_bulk_phase_crystal_is_not_polarization_filtered():
    """A retarder in a mount must NOT act as a polarizer — the waveguide gate
    is modulationKind=amplitude OR fiberPigtailed, and this is neither."""
    op = get_anchor_op("eom")
    params = {"modulationKind": "phase", "vPiV": 5.0, "fiberPigtailed": False,
              "polarizationExtinctionRatioDb": 20.0}
    [out] = op(_ray_at(90), _ctx(params))
    assert out.power_mw == pytest.approx(1.0, rel=1e-12)
