"""Tests for the optical solver core (pure-function math + chain traversal)."""
from __future__ import annotations

import math
import uuid
from dataclasses import dataclass
from typing import Any

import pytest

from app.solvers.optical_solver import (
    Beam,
    apply_beam_splitter,
    apply_dichroic_mirror,
    apply_lens_spherical,
    apply_mirror,
    apply_polarizer,
    apply_waveplate,
    emit_from_laser_source,
    jones_from_dict,
    lens_q,
    nm_to_thz,
    propagate_q,
    q_at_z,
    rayleigh_range_mm,
    solve_chain,
    waist_um_from_q,
)


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


def test_beam_splitter_50_50_splits_power_equally():
    out = apply_beam_splitter(make_beam(100.0), {"splitRatioTransmitted": 0.5, "transmission": 1.0})
    assert math.isclose(out["out_t"].power_mw, 50.0, abs_tol=1e-9)
    assert math.isclose(out["out_r"].power_mw, 50.0, abs_tol=1e-9)


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
    component_id: uuid.UUID
    element_kind: str
    kind_params: dict[str, Any]
    input_ports: list[dict[str, Any]]
    output_ports: list[dict[str, Any]]


@dataclass
class FakeLink:
    id: uuid.UUID
    from_component_id: uuid.UUID
    from_port: str
    to_component_id: uuid.UUID
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
        component_id=mid_id,
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
        component_id=laser_id,
        element_kind="laser_source",
        kind_params=make_laser_params(power_mw=50.0),
        input_ports=[],
        output_ports=[out_port("out")],
    )
    mirror = FakeElement(
        component_id=mirror_id,
        element_kind="mirror",
        kind_params={"reflectivity": 0.9, "normalLocal": [1, 0, 0]},
        input_ports=[in_port("in")],
        output_ports=[out_port("out")],
    )
    detector = FakeElement(
        component_id=detector_id,
        element_kind="detector",
        kind_params={"responsivityAPerW": 0.5, "quantumEfficiency": 0.8, "bandwidthMhz": 1000.0, "saturationPowerMw": 100.0},
        input_ports=[in_port("in")],
        output_ports=[],
    )

    link1 = FakeLink(
        id=uuid.uuid4(),
        from_component_id=laser_id, from_port="out",
        to_component_id=mirror_id, to_port="in",
        free_space_mm=100.0,
    )
    link2 = FakeLink(
        id=uuid.uuid4(),
        from_component_id=mirror_id, from_port="out",
        to_component_id=detector_id, to_port="in",
        free_space_mm=200.0,
    )

    result = solve_chain([laser, mirror, detector], [link1, link2])
    assert not result.errors
    assert len(result.segments) == 2

    seg1 = next(s for s in result.segments if s["optical_link_id"] == link1.id)
    seg2 = next(s for s in result.segments if s["optical_link_id"] == link2.id)
    assert math.isclose(seg1["power_mw"], 50.0, abs_tol=1e-9)
    assert math.isclose(seg2["power_mw"], 50.0 * 0.9, abs_tol=1e-9)
    # After 100mm propagation, q.real should advance by 100mm
    assert math.isclose(seg1["spatial_x"]["qReal"], 100.0, abs_tol=1e-6)
    assert math.isclose(seg2["spatial_x"]["qReal"], 100.0 + 200.0, abs_tol=1e-6)


def test_solve_chain_aom_three_orders():
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
         "acousticVelocityMPerS": 4200.0, "modulationBandwidthMhz": 20.0},
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
    assert math.isclose(pplus_power, 100.0 * 0.85, abs_tol=1e-9)
    assert math.isclose(pminus_power, 100.0 * 0.85, abs_tol=1e-9)

    # +1st should have spectrum shifted by +80 MHz, -1st by -80 MHz
    pplus_seg = next(s for s in result.segments if s["optical_link_id"] == links[2].id)
    pminus_seg = next(s for s in result.segments if s["optical_link_id"] == links[3].id)
    plus_offset = pplus_seg["spectrum"]["components"][0]["offsetMhz"]
    minus_offset = pminus_seg["spectrum"]["components"][0]["offsetMhz"]
    assert math.isclose(plus_offset, 80.0, abs_tol=1e-9)
    assert math.isclose(minus_offset, -80.0, abs_tol=1e-9)


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
        lens_id, "lens_spherical",
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
