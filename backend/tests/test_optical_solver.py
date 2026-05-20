"""Tests for the optical solver core (pure-function math + chain traversal)."""
from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, replace as replace_beam
from typing import Any

import pytest

from app.solvers.optical_solver import (
    Beam,
    apply_aom,
    apply_beam_splitter,
    apply_dichroic_mirror,
    apply_lens_spherical,
    apply_mirror,
    apply_polarizer,
    apply_waveplate,
    emit_from_laser_source,
    emit_from_tapered_amplifier,
    jones_from_dict,
    lens_q,
    nm_to_thz,
    propagate_beam_precise,
    propagate_q,
    q_at_z,
    rayleigh_range_mm,
    solve_chain,
    synthesize_field_from_beam,
    waist_um_from_q,
)
import numpy as np


# --- math primitives --------------------------------------------------------


def test_rayleigh_range_typical_values():
    # 200 um waist at 780 nm with M^2=1
    z_r = rayleigh_range_mm(200.0, 780.0, 1.0)
    expected = math.pi * 0.2 ** 2 / (780e-6)
    assert math.isclose(z_r, expected, rel_tol=1e-6)


def test_q_at_z_at_waist_is_pure_imaginary():
    q = q_at_z(100.0, 0.0, 1.0, 780.0)
    assert q.real == 0.0
    assert q.imag > 0


def test_q_at_z_offset_shifts_real_part():
    # If waist is at z = +5 mm, then q at z=0 is (-5) + i*z_R
    q = q_at_z(100.0, 5.0, 1.0, 780.0)
    assert math.isclose(q.real, -5.0, abs_tol=1e-9)


def test_propagate_q_just_adds_distance():
    q = complex(2.0, 30.0)
    moved = propagate_q(q, 10.0)
    assert moved.real == 12.0
    assert moved.imag == 30.0


def test_lens_q_preserves_modulus_for_collimated_beam():
    # A collimated beam (q = i*z_R, large z_R) focused by f mm lens should
    # produce q' with real part close to -f for very large z_R.
    q = complex(0.0, 10000.0)
    q_after = lens_q(q, 100.0)
    assert q_after.real < 0
    assert math.isclose(q_after.real, -100.0, abs_tol=2.0)


def test_waist_um_roundtrip():
    q = q_at_z(150.0, 0.0, 1.0, 780.0)
    assert math.isclose(waist_um_from_q(q, 780.0, 1.0), 150.0, abs_tol=1e-6)


# --- emitters ---------------------------------------------------------------


def make_laser_params(power_mw: float = 50.0, waist_x: float = 200.0, waist_y: float = 100.0):
    return {
        "centerWavelengthNm": 780.0,
        "spectrum": {
            "centerThz": nm_to_thz(780.0),
            "components": [{"kind": "main", "lineshape": "lorentzian", "fwhmMhz": 0.1, "amplitude": 1.0}],
        },
        "spatialModeX": {"waistUm": waist_x, "waistZOffsetMm": 0.0, "mSquared": 1.0},
        "spatialModeY": {"waistUm": waist_y, "waistZOffsetMm": 0.0, "mSquared": 1.0},
        "transverseMode": {"kind": "TEM00"},
        "polarization": {"exRe": 1.0, "exIm": 0.0, "eyRe": 0.0, "eyIm": 0.0},
        "nominalPowerMw": power_mw,
    }


def test_emit_laser_source_produces_correct_power():
    beam = emit_from_laser_source(make_laser_params(power_mw=42.0))
    assert beam.power_mw == 42.0
    assert beam.wavelength_nm == 780.0


def test_emit_laser_source_astigmatic_waist():
    beam = emit_from_laser_source(make_laser_params(waist_x=200.0, waist_y=80.0))
    wx = waist_um_from_q(beam.q_x, 780.0, 1.0)
    wy = waist_um_from_q(beam.q_y, 780.0, 1.0)
    assert math.isclose(wx, 200.0, abs_tol=0.5)
    assert math.isclose(wy, 80.0, abs_tol=0.5)


# --- per-kind dispatchers ---------------------------------------------------


def make_beam(power: float = 50.0) -> Beam:
    return Beam(
        spectrum={"centerThz": nm_to_thz(780.0), "components": [{"kind": "main", "lineshape": "delta", "amplitude": 1.0}]},
        q_x=complex(0.0, 100.0),
        q_y=complex(0.0, 100.0),
        transverse_mode={"kind": "TEM00", "mSquaredX": 1.0, "mSquaredY": 1.0},
        polarization=(complex(1.0), complex(0.0)),
        power_mw=power,
        wavelength_nm=780.0,
    )


def make_ta_params() -> dict[str, Any]:
    return {
        "smallSignalGainDb": 20.0,
        "saturationPowerMw": 100.0,
        "maxInputPowerMw": 30.0,
        "inputSpatialModeX": {"waistUm": 100.0, "waistZOffsetMm": 0.0, "mSquared": 1.0},
        "inputSpatialModeY": {"waistUm": 100.0, "waistZOffsetMm": 0.0, "mSquared": 1.0},
        "inputPolarization": {"exRe": 0.0, "exIm": 0.0, "eyRe": 1.0, "eyIm": 0.0},
        "ase": {"powerMw": 0.0, "bandwidthNm": 1.0, "centerOffsetNm": 0.0},
        "outputSpatialModeX": {"waistUm": 500.0, "waistZOffsetMm": 0.0, "mSquared": 1.5},
        "outputSpatialModeY": {"waistUm": 50.0, "waistZOffsetMm": 0.0, "mSquared": 8.0},
        "outputTransverseMode": {"kind": "TEM00"},
    }


def test_tapered_amplifier_uses_polarization_overlap_for_seed_gain():
    params = make_ta_params()
    matched_seed = replace_beam(
        make_beam(10.0),
        q_x=q_at_z(100.0, 0.0, 1.0, 780.0),
        q_y=q_at_z(100.0, 0.0, 1.0, 780.0),
        polarization=(complex(0.0), complex(1.0)),
    )
    wrong_pol_seed = replace_beam(matched_seed, polarization=(complex(1.0), complex(0.0)))

    matched = emit_from_tapered_amplifier(params, matched_seed)
    rejected = emit_from_tapered_amplifier(params, wrong_pol_seed)

    assert matched.power_mw > 50.0
    assert rejected.power_mw < 1e-3
    assert abs(matched.polarization[0]) < 1e-12
    assert abs(matched.polarization[1] - 1.0) < 1e-12


def test_tapered_amplifier_uses_mode_overlap_for_seed_gain():
    params = make_ta_params()
    matched_seed = replace_beam(
        make_beam(10.0),
        q_x=q_at_z(100.0, 0.0, 1.0, 780.0),
        q_y=q_at_z(100.0, 0.0, 1.0, 780.0),
        polarization=(complex(0.0), complex(1.0)),
    )
    mismatched_seed = replace_beam(
        matched_seed,
        q_x=q_at_z(1000.0, 0.0, 1.0, 780.0),
        q_y=q_at_z(1000.0, 0.0, 1.0, 780.0),
    )

    matched = emit_from_tapered_amplifier(params, matched_seed)
    mismatched = emit_from_tapered_amplifier(params, mismatched_seed)

    assert matched.power_mw > mismatched.power_mw
    assert mismatched.power_mw < matched.power_mw * 0.2


def test_mirror_attenuates_power_by_reflectivity():
    out = apply_mirror(make_beam(50.0), {"reflectivity": 0.95})
    assert math.isclose(out["out"].power_mw, 47.5, abs_tol=1e-9)


def test_lens_spherical_modifies_both_axes():
    beam = make_beam()
    out = apply_lens_spherical(beam, {"focalMm": 50.0, "transmission": 1.0})
    assert out["out"].q_x != beam.q_x
    assert out["out"].q_y != beam.q_y
    # x and y should match for spherical lens
    assert math.isclose(out["out"].q_x.real, out["out"].q_y.real, abs_tol=1e-9)


def test_chief_ray_defaults_to_zero():
    beam = make_beam()
    assert beam.x_c_mm == 0 and beam.y_c_mm == 0
    assert beam.theta_xc_rad == 0 and beam.theta_yc_rad == 0


def test_lens_spherical_no_kick_on_centered_beam():
    beam = make_beam()
    out = apply_lens_spherical(beam, {"focalMm": 100.0, "transmission": 1.0})["out"]
    assert math.isclose(out.theta_xc_rad, 0.0, abs_tol=1e-12)
    assert math.isclose(out.theta_yc_rad, 0.0, abs_tol=1e-12)


def test_lens_spherical_kicks_off_axis_chief_ray():
    """An on-axis beam tilted by θ hits a centered lens — the lens applies
    standard ABCD chief-ray kick. After lens, θ_xc' = D·θ + C·x_c, with the
    new x_c = A·x_c + B·θ (thin lens: A=1, B=0, C=-1/f, D=1)."""
    beam = replace_beam(make_beam(), x_c_mm=0.5, theta_xc_rad=0.0)
    out = apply_lens_spherical(beam, {"focalMm": 100.0, "transmission": 1.0})["out"]
    # x_c unchanged (A=1, B=0); θ_xc gains -x_c/f = -0.005 rad
    assert math.isclose(out.x_c_mm, 0.5, abs_tol=1e-12)
    assert math.isclose(out.theta_xc_rad, -0.5 / 100.0, abs_tol=1e-12)


def test_mirror_flips_q_per_spec():
    beam = replace_beam(make_beam(), q_x=complex(50.0, 30.0), q_y=complex(50.0, 30.0))
    out = apply_mirror(beam, {"reflectivity": 1.0})["out"]
    assert math.isclose(out.q_x.real, -50.0, abs_tol=1e-12)
    assert math.isclose(out.q_x.imag, -30.0, abs_tol=1e-12)


# --- Phase E.1: curved mirror + plate thickness optional kindParams ---------


def test_mirror_curved_focuses_collimated_beam():
    """Concave mirror R=200mm has f = R/2 = 100mm. A collimated beam (waist
    at the mirror) reflects + focuses ~100mm AHEAD of the mirror. Combined
    with q-flip, the resulting q.real ≈ -100 mm (waist is "ahead" of mirror
    in the reflected frame)."""
    beam = replace_beam(make_beam(), q_x=complex(0.0, 4030.0), q_y=complex(0.0, 4030.0))  # 1mm collimated
    out = apply_mirror(beam, {"radiusOfCurvatureMm": 200.0, "reflectivity": 1.0})["out"]
    # New waist sits ~100mm AHEAD (negative q.real) AFTER the q-flip + focus.
    assert math.isclose(out.q_x.real, -100.0, rel_tol=0.02)


def test_mirror_no_radius_acts_as_flat():
    """Mirror with no radiusOfCurvatureMm behaves identically to the bare
    flat-mirror dispatch (just q flip + reflectivity power attenuation)."""
    beam = replace_beam(make_beam(), q_x=complex(50.0, 30.0), q_y=complex(50.0, 30.0))
    out = apply_mirror(beam, {"reflectivity": 1.0})["out"]
    assert math.isclose(out.q_x.real, -50.0, abs_tol=1e-12)
    assert math.isclose(out.q_x.imag, -30.0, abs_tol=1e-12)


def test_waveplate_no_thickness_preserves_q():
    """Without thicknessMm + refractiveIndex, the waveplate body acts as
    identity at the envelope level — only Jones changes."""
    beam = replace_beam(make_beam(), q_x=complex(20.0, 50.0), q_y=complex(20.0, 50.0))
    out = apply_waveplate(beam, {"retardanceLambda": 0.5, "fastAxisDeg": 0.0})["out"]
    assert math.isclose(out.q_x.real, 20.0, abs_tol=1e-12)


def test_waveplate_with_thickness_propagates_q_by_d_over_n():
    """With thicknessMm = 1mm, n = 1.5 → d/n ≈ 0.6667 mm added to q.real."""
    beam = replace_beam(make_beam(), q_x=complex(20.0, 50.0), q_y=complex(20.0, 50.0))
    out = apply_waveplate(
        beam,
        {"retardanceLambda": 0.5, "fastAxisDeg": 0.0,
         "thicknessMm": 1.0, "refractiveIndex": 1.5, "transmission": 1.0},
    )["out"]
    assert math.isclose(out.q_x.real, 20.0 + 1.0 / 1.5, abs_tol=1e-9)


# --- Phase F.1: profileKind passthrough + field synthesis -------------------


def test_emit_laser_default_profile_kind_is_gaussian():
    beam = emit_from_laser_source(make_laser_params())
    assert beam.transverse_mode.get("profileKind") == "gaussian"


def test_emit_laser_with_tophat_profile_kind_echoes_metadata():
    params = make_laser_params()
    params["profileKind"] = "tophat"
    params["profileParams"] = {"radiusMm": 0.5}
    beam = emit_from_laser_source(params)
    assert beam.transverse_mode["profileKind"] == "tophat"
    assert beam.transverse_mode["profileParams"]["radiusMm"] == 0.5


def test_emit_laser_unknown_profile_kind_falls_back_to_gaussian():
    params = make_laser_params()
    params["profileKind"] = "schmaussian"
    beam = emit_from_laser_source(params)
    assert beam.transverse_mode["profileKind"] == "gaussian"


def test_synthesize_field_gaussian_default():
    beam = emit_from_laser_source(make_laser_params(power_mw=4.0))
    x = np.linspace(-1.0, 1.0, 33)
    y = np.linspace(-1.0, 1.0, 33)
    field = synthesize_field_from_beam(beam, x, y)
    assert field.shape == (33, 33)
    # Power scale: peak amplitude proportional to sqrt(power_mw=4) = 2
    peak = float(np.max(np.abs(field)))
    assert peak > 0.0


def test_synthesize_field_tophat_uniform_inside_radius():
    params = make_laser_params(power_mw=9.0)
    params["profileKind"] = "tophat"
    params["profileParams"] = {"radiusMm": 0.5}
    beam = emit_from_laser_source(params)
    x = np.linspace(-1.0, 1.0, 51)
    y = np.linspace(-1.0, 1.0, 51)
    field = synthesize_field_from_beam(beam, x, y)
    # Center inside → amplitude = sqrt(power_mw) = 3
    assert math.isclose(abs(field[25, 25]), 3.0, abs_tol=1e-9)
    # Outside → 0
    assert abs(field[0, 0]) < 1e-12


def test_propagate_beam_precise_gaussian_grows_by_root_2_at_zr():
    """A 200 µm Gaussian propagated one Rayleigh range should reach ~283 µm
    spot radius (within FFT-sampling tolerance)."""
    params = make_laser_params(power_mw=1.0, waist_x=200.0, waist_y=200.0)
    beam = emit_from_laser_source(params)
    z_R_mm = beam.q_x.imag  # ≈ 161 mm at 780nm
    out = propagate_beam_precise(beam, z_R_mm, grid_span_mm=6.0, n_grid=256)
    # Tolerate 15% (FFT grid sampling)
    assert math.isclose(out["spot_radius_x_um"], 200.0 * math.sqrt(2.0), rel_tol=0.15)


def test_propagate_beam_precise_zero_distance_returns_input():
    """distance_mm = 0 short-circuits the FFT step; output spot radius
    should match the input waist within tight tolerance."""
    params = make_laser_params(power_mw=1.0, waist_x=200.0, waist_y=200.0)
    beam = emit_from_laser_source(params)
    out = propagate_beam_precise(beam, 0.0, grid_span_mm=4.0, n_grid=256)
    assert math.isclose(out["spot_radius_x_um"], 200.0, rel_tol=0.10)
    assert out["total_power"] > 0.0


def test_propagate_beam_precise_intensity_grid_shape():
    """API contract: returned intensity is (n_grid, n_grid), axes length n_grid."""
    beam = emit_from_laser_source(make_laser_params(power_mw=1.0))
    out = propagate_beam_precise(beam, 50.0, grid_span_mm=4.0, n_grid=128)
    assert out["intensity"].shape == (128, 128)
    assert len(out["x_axis_mm"]) == 128
    assert len(out["y_axis_mm"]) == 128


def test_synthesize_field_hg_mn_picks_correct_mode():
    params = make_laser_params()
    params["profileKind"] = "hg_mn"
    params["profileParams"] = {"m": 1, "n": 0}  # HG_1,0 has one node along x
    beam = emit_from_laser_source(params)
    x = np.linspace(-0.6, 0.6, 65)
    y = np.linspace(-0.6, 0.6, 65)
    field = synthesize_field_from_beam(beam, x, y)
    # HG_1,0 vanishes at x = 0 (the node line)
    centre_line = field[32, :]
    assert abs(centre_line[32]) < 1e-3


def test_pbs_transmitted_with_thickness_acts_as_glass_plate():
    """PBS with thicknessMm = 12.7 (Thorlabs PBS252) propagates q by d/n on
    the transmitted arm."""
    amp = 1.0 / math.sqrt(2.0)
    beam = replace_beam(make_beam(100.0), polarization=(complex(amp), complex(amp)),
                        q_x=complex(0.0, 50.0), q_y=complex(0.0, 50.0))
    out = apply_beam_splitter(
        beam,
        {"polarizing": True, "transmissionAxisDeg": 0.0, "transmission": 1.0,
         "thicknessMm": 12.7, "refractiveIndex": 1.515},
    )
    # transmitted arm: q advanced by d/n ≈ 8.38 mm
    assert math.isclose(out["out_t"].q_x.real, 12.7 / 1.515, abs_tol=1e-6)
    # reflected arm: q flipped (sign reversal)
    assert math.isclose(out["out_r"].q_x.real, 0.0, abs_tol=1e-12)
    assert math.isclose(out["out_r"].q_x.imag, -50.0, abs_tol=1e-12)


def test_beam_splitter_50_50_splits_power_equally():
    out = apply_beam_splitter(make_beam(100.0), {"splitRatioTransmitted": 0.5, "transmission": 1.0})
    assert math.isclose(out["out_t"].power_mw, 50.0, abs_tol=1e-9)
    assert math.isclose(out["out_r"].power_mw, 50.0, abs_tol=1e-9)


def test_pbs_projects_45_degree_input_to_pure_linear_branches():
    amp = 1.0 / math.sqrt(2.0)
    beam = replace_beam(make_beam(100.0), polarization=(complex(amp), complex(amp)))
    out = apply_beam_splitter(
        beam,
        {"polarizing": True, "transmissionAxisDeg": 0.0, "transmission": 1.0},
    )

    assert math.isclose(out["out_t"].power_mw, 50.0, abs_tol=1e-9)
    assert math.isclose(out["out_r"].power_mw, 50.0, abs_tol=1e-9)
    assert abs(out["out_t"].polarization[0] - 1.0) < 1e-12
    assert abs(out["out_t"].polarization[1]) < 1e-12
    assert abs(out["out_r"].polarization[0]) < 1e-12
    assert abs(out["out_r"].polarization[1] - 1.0) < 1e-12


def test_dichroic_long_pass_routes_by_wavelength():
    beam = make_beam()  # 780 nm
    long_pass = apply_dichroic_mirror(beam, {"cutoffWavelengthNm": 600.0, "passBand": "long", "transmission": 1.0, "reflectivity": 1.0})
    assert long_pass["out_pass"].power_mw > 0
    assert long_pass["out_refl"].power_mw == 0

    short_pass = apply_dichroic_mirror(beam, {"cutoffWavelengthNm": 600.0, "passBand": "short", "transmission": 1.0, "reflectivity": 1.0})
    assert short_pass["out_pass"].power_mw == 0
    assert short_pass["out_refl"].power_mw > 0


def test_waveplate_hwp_rotates_h_to_v():
    # Half-wave plate at 45° rotates H polarization to V
    h_beam = Beam(
        spectrum={}, q_x=complex(0, 100), q_y=complex(0, 100), transverse_mode={},
        polarization=(complex(1.0), complex(0.0)),
        power_mw=10.0, wavelength_nm=780.0,
    )
    out = apply_waveplate(h_beam, {"retardanceLambda": 0.5, "fastAxisDeg": 45.0, "transmission": 1.0})
    # Expect Ex ≈ 0, Ey ≈ ±1 (sign depends on convention)
    j = out["out"].polarization
    assert abs(abs(j[0]) ** 2) < 0.01
    assert abs(abs(j[1]) ** 2 - 1.0) < 0.01


def test_polarizer_blocks_orthogonal_polarization():
    # Vertical-polarized beam through a horizontal polarizer
    v_beam = Beam(
        spectrum={}, q_x=complex(0, 100), q_y=complex(0, 100), transverse_mode={},
        polarization=(complex(0.0), complex(1.0)),
        power_mw=100.0, wavelength_nm=780.0,
    )
    out = apply_polarizer(v_beam, {
        "transmissionAxisDeg": 0.0,  # horizontal
        "transmission": 1.0,
        "extinctionRatioDb": 30.0,
    })
    # Should be heavily attenuated (~ 30 dB extinction → ~ 0.1% remaining)
    assert out["out"].power_mw < 1.0


# --- chain traversal --------------------------------------------------------


@dataclass
class FakeElement:
    object_id: uuid.UUID
    element_kind: str
    kind_params: dict[str, Any]
    input_ports: list[dict[str, Any]]
    output_ports: list[dict[str, Any]]


@dataclass
class FakeLink:
    id: uuid.UUID
    from_object_id: uuid.UUID
    from_port: str
    to_object_id: uuid.UUID
    to_port: str
    free_space_mm: float


def in_port(port_id: str = "in") -> dict[str, Any]:
    return {"portId": port_id, "role": "input", "label": port_id, "kind": "main"}


def out_port(port_id: str = "out") -> dict[str, Any]:
    return {"portId": port_id, "role": "output", "label": port_id, "kind": "main"}


def test_solve_chain_empty_scene_returns_warning():
    result = solve_chain([], [])
    assert result.segments == []
    assert any("No optical elements" in w for w in result.warnings)


def test_solve_chain_no_emitter_root_errors():
    mid_id = uuid.uuid4()
    mirror = FakeElement(
        object_id=mid_id,
        element_kind="mirror",
        kind_params={"reflectivity": 0.99, "normalLocal": [1, 0, 0]},
        input_ports=[in_port("in")],
        output_ports=[out_port("out")],
    )
    result = solve_chain([mirror], [])
    assert result.errors
    assert any("emit" in e.lower() or "laser" in e.lower() for e in result.errors)


def test_solve_chain_simple_laser_to_mirror_to_detector():
    laser_id = uuid.uuid4()
    mirror_id = uuid.uuid4()
    detector_id = uuid.uuid4()

    laser = FakeElement(
        object_id=laser_id,
        element_kind="laser_source",
        kind_params=make_laser_params(power_mw=50.0),
        input_ports=[],
        output_ports=[out_port("out")],
    )
    mirror = FakeElement(
        object_id=mirror_id,
        element_kind="mirror",
        kind_params={"reflectivity": 0.9, "normalLocal": [1, 0, 0]},
        input_ports=[in_port("in")],
        output_ports=[out_port("out")],
    )
    detector = FakeElement(
        object_id=detector_id,
        element_kind="detector",
        kind_params={"responsivityAPerW": 0.5, "quantumEfficiency": 0.8, "bandwidthMhz": 1000.0, "saturationPowerMw": 100.0},
        input_ports=[in_port("in")],
        output_ports=[],
    )

    link1 = FakeLink(
        id=uuid.uuid4(),
        from_object_id=laser_id, from_port="out",
        to_object_id=mirror_id, to_port="in",
        free_space_mm=100.0,
    )
    link2 = FakeLink(
        id=uuid.uuid4(),
        from_object_id=mirror_id, from_port="out",
        to_object_id=detector_id, to_port="in",
        free_space_mm=200.0,
    )

    result = solve_chain([laser, mirror, detector], [link1, link2])
    assert not result.errors
    assert len(result.segments) == 2

    seg1 = next(s for s in result.segments if s["optical_link_id"] == link1.id)
    seg2 = next(s for s in result.segments if s["optical_link_id"] == link2.id)
    assert math.isclose(seg1["power_mw"], 50.0, abs_tol=1e-9)
    assert math.isclose(seg2["power_mw"], 50.0 * 0.9, abs_tol=1e-9)
    # After 100mm free-space, q.real = 100mm (waist at emitter, 100mm behind).
    assert math.isclose(seg1["spatial_x"]["qReal"], 100.0, abs_tol=1e-6)
    # Mirror flips q (wavefront-curvature reversal, Siegman §17): q.real
    # 100 → -100, then +200mm free-space → -100 + 200 = 100.
    assert math.isclose(seg2["spatial_x"]["qReal"], -100.0 + 200.0, abs_tol=1e-6)


def test_solve_chain_aom_bragg_selected_order():
    laser_id = uuid.uuid4()
    aom_id = uuid.uuid4()
    dump_0_id = uuid.uuid4()
    dump_p_id = uuid.uuid4()
    dump_n_id = uuid.uuid4()

    aom_ports_out = [out_port("0th"), out_port("+1st"), out_port("-1st")]

    laser = FakeElement(laser_id, "laser_source", make_laser_params(power_mw=100.0), [], [out_port("out")])
    aom = FakeElement(
        aom_id, "aom",
        {"baseEfficiency": 0.85, "centerFreqMhz": 80.0, "deflectionPerMhzUrad": 200.0,
         "acousticVelocityMPerS": 4200.0, "modulationBandwidthMhz": 20.0,
         "diffractionOrder": -1},
        [in_port("in")],
        aom_ports_out,
    )
    dumps = [
        FakeElement(d, "beam_dump", {"absorption": 0.999}, [in_port("in")], [])
        for d in (dump_0_id, dump_p_id, dump_n_id)
    ]

    links = [
        FakeLink(uuid.uuid4(), laser_id, "out", aom_id, "in", 50.0),
        FakeLink(uuid.uuid4(), aom_id, "0th", dump_0_id, "in", 50.0),
        FakeLink(uuid.uuid4(), aom_id, "+1st", dump_p_id, "in", 50.0),
        FakeLink(uuid.uuid4(), aom_id, "-1st", dump_n_id, "in", 50.0),
    ]

    result = solve_chain([laser, aom] + dumps, links)
    assert not result.errors
    # Four segments: laser→aom, aom→three dumps
    assert len(result.segments) == 4

    powers = {s["optical_link_id"]: s["power_mw"] for s in result.segments}
    laser_link_power = powers[links[0].id]
    p0_power = powers[links[1].id]
    pplus_power = powers[links[2].id]
    pminus_power = powers[links[3].id]

    assert math.isclose(laser_link_power, 100.0, abs_tol=1e-9)
    assert math.isclose(p0_power, 100.0 * (1.0 - 0.85), abs_tol=1e-9)
    assert math.isclose(pplus_power, 0.0, abs_tol=1e-9)
    assert math.isclose(pminus_power, 100.0 * 0.85, abs_tol=1e-9)

    # +1st should have spectrum shifted by +80 MHz, -1st by -80 MHz
    pplus_seg = next(s for s in result.segments if s["optical_link_id"] == links[2].id)
    pminus_seg = next(s for s in result.segments if s["optical_link_id"] == links[3].id)
    plus_offset = pplus_seg["spectrum"]["components"][0]["offsetMhz"]
    minus_offset = pminus_seg["spectrum"]["components"][0]["offsetMhz"]
    assert math.isclose(plus_offset, 80.0, abs_tol=1e-9)
    assert math.isclose(minus_offset, -80.0, abs_tol=1e-9)


def test_solve_chain_aom_zero_order_is_rf_off():
    beam = emit_from_laser_source(make_laser_params(power_mw=40.0))
    params = {"baseEfficiency": 0.85, "centerFreqMhz": 80.0, "diffractionOrder": 0}

    assert math.isclose(apply_aom(beam, params, "0th").power_mw, 40.0, abs_tol=1e-9)
    assert math.isclose(apply_aom(beam, params, "+1st").power_mw, 0.0, abs_tol=1e-9)
    assert math.isclose(apply_aom(beam, params, "-1st").power_mw, 0.0, abs_tol=1e-9)


def test_solve_chain_detects_cycle():
    a_id = uuid.uuid4()
    b_id = uuid.uuid4()
    a = FakeElement(a_id, "mirror", {"reflectivity": 0.99, "normalLocal": [1, 0, 0]}, [in_port("in")], [out_port("out")])
    b = FakeElement(b_id, "mirror", {"reflectivity": 0.99, "normalLocal": [1, 0, 0]}, [in_port("in")], [out_port("out")])
    links = [
        FakeLink(uuid.uuid4(), a_id, "out", b_id, "in", 1.0),
        FakeLink(uuid.uuid4(), b_id, "out", a_id, "in", 1.0),
    ]
    result = solve_chain([a, b], links)
    assert any("cycle" in e.lower() for e in result.errors)


def test_solve_chain_lens_focuses_collimated_beam():
    laser_id = uuid.uuid4()
    lens_id = uuid.uuid4()
    detector_id = uuid.uuid4()

    laser = FakeElement(laser_id, "laser_source", make_laser_params(power_mw=10.0, waist_x=2000.0, waist_y=2000.0), [], [out_port("out")])
    lens = FakeElement(
        lens_id, "lens_biconvex",  # V2 Phase 5 (alembic 0031): renamed from lens_spherical
        {"focalMm": 100.0, "transmission": 1.0},
        [in_port("in")], [out_port("out")],
    )
    detector = FakeElement(detector_id, "detector",
        {"responsivityAPerW": 0.5, "quantumEfficiency": 0.8, "bandwidthMhz": 1000.0, "saturationPowerMw": 100.0},
        [in_port("in")], [],
    )

    links = [
        FakeLink(uuid.uuid4(), laser_id, "out", lens_id, "in", 0.0),  # right at lens
        FakeLink(uuid.uuid4(), lens_id, "out", detector_id, "in", 100.0),  # at focal length
    ]

    result = solve_chain([laser, lens, detector], links)
    assert not result.errors
    # At the focal plane, beam should be near its new waist (small q.real)
    detector_seg = next(s for s in result.segments if s["optical_link_id"] == links[1].id)
    waist_at_detector = detector_seg["spatial_x"]["wAtZUm"]
    waist_initial = waist_um_from_q(complex(0, 0) + laser.kind_params["spatialModeX"]["waistUm"], 780.0, 1.0)
    # After lens of large-collimated 2mm waist beam, focused waist << initial waist
    assert detector_seg["spatial_x"]["waistUm"] < 200.0  # focused down significantly
