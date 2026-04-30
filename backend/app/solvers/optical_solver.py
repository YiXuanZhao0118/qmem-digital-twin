"""Optical chain solver.

Pure-function core that propagates a Beam through a graph of OpticalElements
linked by OpticalLinks. Time-static (CW + slow modulation) for now; AOM/EOM
read center frequency directly from kind_params (the future RF solver will
override this with the time-dependent rf_signal at t).

Conventions
-----------
- Lengths in mm, wavelengths in nm internally converted, frequencies in THz/MHz.
- Astigmatic Gaussian beam: independent complex q for x and y axes.
  q = z + i * z_R, where z_R = pi * w0**2 / (lambda * M^2) (in mm).
- Polarization: Jones vector with complex Ex, Ey.
- Spectrum: list of components, each with lineshape + center offset + amplitude.
- Beam state at a link end is what gets persisted as a BeamSegment row.
"""
from __future__ import annotations

import math
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass, field, replace
from typing import Any, Iterable


SPEED_OF_LIGHT_M_PER_S = 299_792_458.0


# --- math helpers -----------------------------------------------------------


def thz_to_nm(thz: float) -> float:
    return SPEED_OF_LIGHT_M_PER_S / (thz * 1e12) * 1e9


def nm_to_thz(nm: float) -> float:
    return SPEED_OF_LIGHT_M_PER_S / (nm * 1e-9) / 1e12


def rayleigh_range_mm(waist_um: float, wavelength_nm: float, m_squared: float) -> float:
    waist_mm = waist_um / 1000.0
    wavelength_mm = wavelength_nm / 1_000_000.0
    return math.pi * waist_mm * waist_mm / (wavelength_mm * max(m_squared, 1e-9))


def q_at_z(waist_um: float, waist_z_offset_mm: float, m_squared: float, wavelength_nm: float) -> complex:
    """q-parameter at z = 0 (the element's local reference plane) given a beam
    whose waist is at z = waist_z_offset_mm with the given waist size."""
    z_r = rayleigh_range_mm(waist_um, wavelength_nm, m_squared)
    z_from_waist_mm = -waist_z_offset_mm
    return complex(z_from_waist_mm, z_r)


def waist_um_from_q(q: complex, wavelength_nm: float, m_squared: float) -> float:
    z_r = max(q.imag, 1e-12)
    waist_mm = math.sqrt(z_r * (wavelength_nm / 1_000_000.0) * max(m_squared, 1e-9) / math.pi)
    return waist_mm * 1000.0


def w_at_z_um(q: complex, wavelength_nm: float, m_squared: float) -> float:
    """Beam radius at the q-parameter's current z position."""
    z_r = max(q.imag, 1e-12)
    z = q.real
    waist0_um = waist_um_from_q(q, wavelength_nm, m_squared)
    return waist0_um * math.sqrt(1.0 + (z / z_r) ** 2 if z_r > 0 else 1.0)


def propagate_q(q: complex, distance_mm: float) -> complex:
    return complex(q.real + distance_mm, q.imag)


def lens_q(q: complex, focal_mm: float) -> complex:
    if abs(focal_mm) < 1e-12:
        raise ValueError("focal length must be non-zero")
    inv = (1.0 / q) - (1.0 / focal_mm)
    return 1.0 / inv


# --- Jones polarization helpers --------------------------------------------


JonesArray = tuple[complex, complex]


def jones_from_dict(jones: dict[str, float]) -> JonesArray:
    return (
        complex(jones.get("exRe", 1.0), jones.get("exIm", 0.0)),
        complex(jones.get("eyRe", 0.0), jones.get("eyIm", 0.0)),
    )


def jones_to_dict(jones: JonesArray) -> dict[str, float]:
    return {
        "exRe": jones[0].real,
        "exIm": jones[0].imag,
        "eyRe": jones[1].real,
        "eyIm": jones[1].imag,
    }


def jones_apply_matrix(j: JonesArray, m: tuple[complex, complex, complex, complex]) -> JonesArray:
    a, b, c, d = m
    return (a * j[0] + b * j[1], c * j[0] + d * j[1])


def jones_rotation(angle_rad: float) -> tuple[complex, complex, complex, complex]:
    co = math.cos(angle_rad)
    si = math.sin(angle_rad)
    return (complex(co), complex(si), complex(-si), complex(co))


def jones_waveplate_matrix(retardance_lambda: float, fast_axis_deg: float) -> tuple[complex, complex, complex, complex]:
    """Rotated waveplate Jones matrix: R(-theta) · diag(1, exp(i*phi)) · R(theta)."""
    phi = 2.0 * math.pi * retardance_lambda
    theta = math.radians(fast_axis_deg)
    co = math.cos(theta)
    si = math.sin(theta)
    e = complex(math.cos(phi), math.sin(phi))
    a = co * co + e * si * si
    b = co * si - e * co * si
    c = co * si - e * co * si
    d = si * si + e * co * co
    return (a, b, c, d)


def jones_polarizer_matrix(transmission_axis_deg: float, transmission: float, extinction_db: float) -> tuple[complex, complex, complex, complex]:
    """Rotated linear polarizer with finite extinction."""
    theta = math.radians(transmission_axis_deg)
    co = math.cos(theta)
    si = math.sin(theta)
    leak = 10.0 ** (-extinction_db / 10.0)
    pass_amp = math.sqrt(transmission)
    leak_amp = math.sqrt(transmission * leak)
    a = complex(co * co * pass_amp + si * si * leak_amp)
    b = complex(co * si * (pass_amp - leak_amp))
    c = complex(co * si * (pass_amp - leak_amp))
    d = complex(si * si * pass_amp + co * co * leak_amp)
    return (a, b, c, d)


# --- Beam dataclass ---------------------------------------------------------


@dataclass
class Beam:
    spectrum: dict[str, Any]                    # mirrors Spectrum schema
    q_x: complex
    q_y: complex
    transverse_mode: dict[str, Any]
    polarization: JonesArray
    power_mw: float
    propagation_axis_local: tuple[float, float, float] = (0.0, 0.0, 1.0)
    wavelength_nm: float = 780.241

    def with_power(self, factor: float) -> "Beam":
        return replace(self, power_mw=max(self.power_mw * factor, 0.0))

    def to_segment_dict(self, link_id: uuid.UUID, run_id: uuid.UUID, beam_index: int = 0) -> dict[str, Any]:
        return {
            "id": uuid.uuid4(),
            "simulation_run_id": run_id,
            "optical_link_id": link_id,
            "sequence_t_ms": None,
            "beam_index": beam_index,
            "spectrum": self.spectrum,
            "spatial_x": {
                "qReal": self.q_x.real,
                "qImag": self.q_x.imag,
                "waistUm": waist_um_from_q(self.q_x, self.wavelength_nm, _m2_of(self, "x")),
                "wAtZUm": w_at_z_um(self.q_x, self.wavelength_nm, _m2_of(self, "x")),
                "wavelengthNm": self.wavelength_nm,
            },
            "spatial_y": {
                "qReal": self.q_y.real,
                "qImag": self.q_y.imag,
                "waistUm": waist_um_from_q(self.q_y, self.wavelength_nm, _m2_of(self, "y")),
                "wAtZUm": w_at_z_um(self.q_y, self.wavelength_nm, _m2_of(self, "y")),
                "wavelengthNm": self.wavelength_nm,
            },
            "transverse_mode": self.transverse_mode,
            "polarization_jones": jones_to_dict(self.polarization),
            "power_mw": self.power_mw,
            "propagation_axis_local": list(self.propagation_axis_local),
        }


def _m2_of(beam: Beam, axis: str) -> float:
    mode = beam.transverse_mode or {}
    key = "mSquaredX" if axis == "x" else "mSquaredY"
    value = mode.get(key)
    if isinstance(value, (int, float)) and value > 0:
        return float(value)
    return float(mode.get("mSquared", 1.0))


# --- emitters --------------------------------------------------------------


def emit_from_laser_source(params: dict[str, Any]) -> Beam:
    wavelength_nm = float(params["centerWavelengthNm"])
    spectrum = dict(params.get("spectrum") or {})
    mode_x = params["spatialModeX"]
    mode_y = params["spatialModeY"]
    transverse = dict(params.get("transverseMode") or {"kind": "TEM00"})
    transverse.setdefault("mSquaredX", float(mode_x.get("mSquared", 1.0)))
    transverse.setdefault("mSquaredY", float(mode_y.get("mSquared", 1.0)))
    polarization = jones_from_dict(params.get("polarization") or {})
    return Beam(
        spectrum=spectrum,
        q_x=q_at_z(
            float(mode_x["waistUm"]),
            float(mode_x.get("waistZOffsetMm", 0.0)),
            float(mode_x.get("mSquared", 1.0)),
            wavelength_nm,
        ),
        q_y=q_at_z(
            float(mode_y["waistUm"]),
            float(mode_y.get("waistZOffsetMm", 0.0)),
            float(mode_y.get("mSquared", 1.0)),
            wavelength_nm,
        ),
        transverse_mode=transverse,
        polarization=polarization,
        power_mw=float(params["nominalPowerMw"]),
        wavelength_nm=wavelength_nm,
    )


def emit_from_tapered_amplifier(params: dict[str, Any], seed: Beam | None) -> Beam:
    if seed is None:
        # Pure ASE source: build a wide-spectrum dummy beam from output mode.
        mode_x = params["outputSpatialModeX"]
        mode_y = params["outputSpatialModeY"]
        transverse = dict(params.get("outputTransverseMode") or {"kind": "TEM00"})
        ase = params["ase"]
        wavelength_nm = 780.241
        spectrum = {
            "centerThz": nm_to_thz(wavelength_nm),
            "components": [
                {
                    "kind": "ase",
                    "lineshape": "gaussian",
                    "offsetMhz": 0.0,
                    "fwhmMhz": _bandwidth_nm_to_mhz(float(ase["bandwidthNm"]), wavelength_nm),
                    "amplitude": 1.0,
                },
            ],
        }
        return Beam(
            spectrum=spectrum,
            q_x=q_at_z(
                float(mode_x["waistUm"]),
                float(mode_x.get("waistZOffsetMm", 0.0)),
                float(mode_x.get("mSquared", 1.0)),
                wavelength_nm,
            ),
            q_y=q_at_z(
                float(mode_y["waistUm"]),
                float(mode_y.get("waistZOffsetMm", 0.0)),
                float(mode_y.get("mSquared", 1.0)),
                wavelength_nm,
            ),
            transverse_mode=transverse,
            polarization=(complex(1.0), complex(0.0)),
            power_mw=float(ase["powerMw"]),
            wavelength_nm=wavelength_nm,
        )

    # Saturated gain amplifier:  P_out = P_sat·G0·P_in / (P_sat + (G0-1)·P_in)
    gain_db = float(params["smallSignalGainDb"])
    p_sat = float(params["saturationPowerMw"])
    g0 = 10.0 ** (gain_db / 10.0)
    p_in = max(seed.power_mw, 1e-12)
    p_out = p_sat * g0 * p_in / (p_sat + (g0 - 1.0) * p_in)

    # ASE pedestal added as a separate spectrum component.
    ase = params["ase"]
    new_spectrum = {
        "centerThz": seed.spectrum.get("centerThz", nm_to_thz(seed.wavelength_nm)),
        "components": list(seed.spectrum.get("components") or []) + [
            {
                "kind": "ase",
                "lineshape": "gaussian",
                "offsetMhz": _nm_offset_to_mhz(float(ase.get("centerOffsetNm", 0.0)), seed.wavelength_nm),
                "fwhmMhz": _bandwidth_nm_to_mhz(float(ase["bandwidthNm"]), seed.wavelength_nm),
                "amplitude": float(ase["powerMw"]) / max(p_out, 1e-12),
            },
        ],
    }

    # Output mode replaces input (TA reshapes the beam significantly).
    mode_x = params["outputSpatialModeX"]
    mode_y = params["outputSpatialModeY"]
    transverse = dict(params.get("outputTransverseMode") or {"kind": "TEM00"})
    transverse.setdefault("mSquaredX", float(mode_x.get("mSquared", 1.0)))
    transverse.setdefault("mSquaredY", float(mode_y.get("mSquared", 1.0)))
    return replace(
        seed,
        spectrum=new_spectrum,
        q_x=q_at_z(
            float(mode_x["waistUm"]),
            float(mode_x.get("waistZOffsetMm", 0.0)),
            float(mode_x.get("mSquared", 1.0)),
            seed.wavelength_nm,
        ),
        q_y=q_at_z(
            float(mode_y["waistUm"]),
            float(mode_y.get("waistZOffsetMm", 0.0)),
            float(mode_y.get("mSquared", 1.0)),
            seed.wavelength_nm,
        ),
        transverse_mode=transverse,
        power_mw=p_out + float(ase["powerMw"]),
    )


def _bandwidth_nm_to_mhz(bandwidth_nm: float, center_wavelength_nm: float) -> float:
    f0 = SPEED_OF_LIGHT_M_PER_S / (center_wavelength_nm * 1e-9)
    df = SPEED_OF_LIGHT_M_PER_S / ((center_wavelength_nm + bandwidth_nm) * 1e-9)
    return abs(f0 - df) / 1e6


def _nm_offset_to_mhz(offset_nm: float, center_wavelength_nm: float) -> float:
    if abs(offset_nm) < 1e-12:
        return 0.0
    f0 = SPEED_OF_LIGHT_M_PER_S / (center_wavelength_nm * 1e-9)
    f1 = SPEED_OF_LIGHT_M_PER_S / ((center_wavelength_nm + offset_nm) * 1e-9)
    return (f1 - f0) / 1e6


# --- per-kind dispatchers --------------------------------------------------


def apply_mirror(beam: Beam, params: dict[str, Any]) -> dict[str, Beam]:
    return {"out": beam.with_power(float(params.get("reflectivity", 0.99)))}


def apply_lens_spherical(beam: Beam, params: dict[str, Any]) -> dict[str, Beam]:
    f = float(params["focalMm"])
    transmission = float(params.get("transmission", 0.99))
    out = replace(beam, q_x=lens_q(beam.q_x, f), q_y=lens_q(beam.q_y, f))
    return {"out": out.with_power(transmission)}


def apply_lens_cylindrical(beam: Beam, params: dict[str, Any]) -> dict[str, Beam]:
    f = float(params["focalMm"])
    axis = params.get("cylindricalAxis", "x")
    transmission = float(params.get("transmission", 0.99))
    if axis == "x":
        out = replace(beam, q_x=lens_q(beam.q_x, f))
    else:
        out = replace(beam, q_y=lens_q(beam.q_y, f))
    return {"out": out.with_power(transmission)}


def apply_waveplate(beam: Beam, params: dict[str, Any]) -> dict[str, Beam]:
    matrix = jones_waveplate_matrix(
        float(params["retardanceLambda"]),
        float(params.get("fastAxisDeg", 0.0)),
    )
    j = jones_apply_matrix(beam.polarization, matrix)
    return {"out": replace(beam, polarization=j).with_power(float(params.get("transmission", 0.99)))}


def apply_polarizer(beam: Beam, params: dict[str, Any]) -> dict[str, Beam]:
    matrix = jones_polarizer_matrix(
        float(params.get("transmissionAxisDeg", 0.0)),
        float(params.get("transmission", 0.95)),
        float(params.get("extinctionRatioDb", 30.0)),
    )
    j = jones_apply_matrix(beam.polarization, matrix)
    intensity_factor = abs(j[0]) ** 2 + abs(j[1]) ** 2
    in_intensity = abs(beam.polarization[0]) ** 2 + abs(beam.polarization[1]) ** 2
    factor = intensity_factor / max(in_intensity, 1e-12)
    return {"out": replace(beam, polarization=j).with_power(factor)}


def apply_beam_splitter(beam: Beam, params: dict[str, Any]) -> dict[str, Beam]:
    t = float(params.get("splitRatioTransmitted", 0.5))
    transmission = float(params.get("transmission", 0.99))
    transmitted = beam.with_power(t * transmission)
    reflected = beam.with_power((1.0 - t) * transmission)
    return {"out_t": transmitted, "out_r": reflected}


def apply_dichroic_mirror(beam: Beam, params: dict[str, Any]) -> dict[str, Beam]:
    cutoff = float(params["cutoffWavelengthNm"])
    pass_band = params.get("passBand", "long")
    is_passing = (
        beam.wavelength_nm >= cutoff if pass_band == "long" else beam.wavelength_nm <= cutoff
    )
    transmission = float(params.get("transmission", 0.95))
    reflectivity = float(params.get("reflectivity", 0.95))
    if is_passing:
        return {"out_pass": beam.with_power(transmission), "out_refl": beam.with_power(0.0)}
    return {"out_pass": beam.with_power(0.0), "out_refl": beam.with_power(reflectivity)}


def apply_fiber_coupler(beam: Beam, params: dict[str, Any]) -> dict[str, Beam]:
    eta = float(params.get("couplingEfficiency", 0.7))
    return {"out": beam.with_power(eta)}


def apply_isolator(beam: Beam, params: dict[str, Any]) -> dict[str, Beam]:
    forward_loss_db = float(params.get("forwardLossDb", 0.5))
    return {"out": beam.with_power(10.0 ** (-forward_loss_db / 10.0))}


def apply_aom(beam: Beam, params: dict[str, Any], port: str) -> Beam | None:
    eta = float(params.get("baseEfficiency", 0.85))
    f_rf_mhz = float(params.get("centerFreqMhz", 80.0))
    if port == "0th":
        return beam.with_power(1.0 - eta)
    if port == "+1st":
        new_spec = _shift_spectrum(beam.spectrum, +f_rf_mhz)
        return replace(beam.with_power(eta), spectrum=new_spec)
    if port == "-1st":
        new_spec = _shift_spectrum(beam.spectrum, -f_rf_mhz)
        return replace(beam.with_power(eta), spectrum=new_spec)
    return None


def apply_eom(beam: Beam, params: dict[str, Any]) -> dict[str, Beam]:
    insertion_loss_db = float(params.get("insertionLossDb", 3.0))
    out = beam.with_power(10.0 ** (-insertion_loss_db / 10.0))
    # NOTE: Bessel sideband generation deferred until RF solver provides f_RF(t).
    return {"out": out}


def apply_nonlinear_crystal(beam: Beam, params: dict[str, Any]) -> dict[str, Beam]:
    process = params.get("process", "SHG")
    if process == "SHG":
        new_wavelength = beam.wavelength_nm / 2.0
        new_spec = {
            "centerThz": nm_to_thz(new_wavelength),
            "components": [
                {"kind": "main", "lineshape": "delta", "offsetMhz": 0.0, "amplitude": 1.0},
            ],
        }
        # Naive conversion efficiency (placeholder); real impl uses sinc² and intensity.
        eta = min(0.5, 0.05 * float(params.get("lengthMm", 1.0)))
        return {
            "out": replace(beam, spectrum=new_spec, wavelength_nm=new_wavelength).with_power(eta),
        }
    # SFG / DFG / OPO need two-input handling; deferred.
    return {"out": beam.with_power(0.1)}


def apply_saturable_absorber(beam: Beam, params: dict[str, Any]) -> dict[str, Beam]:
    # Static low-intensity transmission only; saturation deferred.
    loss = float(params.get("nonSaturableLoss", 0.05))
    return {"out": beam.with_power(1.0 - loss)}


def _shift_spectrum(spectrum: dict[str, Any], delta_mhz: float) -> dict[str, Any]:
    new_components = []
    for component in (spectrum.get("components") or []):
        shifted = dict(component)
        shifted["offsetMhz"] = float(shifted.get("offsetMhz", 0.0)) + delta_mhz
        new_components.append(shifted)
    return {**spectrum, "components": new_components}


# --- chain solver ----------------------------------------------------------


@dataclass
class ChainResult:
    run_id: uuid.UUID
    segments: list[dict[str, Any]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _ports_of(element: Any, role: str) -> list[str]:
    raw = element.input_ports if role == "input" else element.output_ports
    ids: list[str] = []
    for port in raw or []:
        if isinstance(port, dict) and port.get("role") == role:
            value = port.get("portId") or port.get("port_id")
            if value:
                ids.append(str(value))
    return ids


def solve_chain(
    elements: Iterable[Any],
    links: Iterable[Any],
    *,
    run_id: uuid.UUID | None = None,
    emitter_kinds: set[str] | None = None,
) -> ChainResult:
    """Pure-function chain solver.

    `elements`/`links` may be ORM instances or any object with the matching
    attribute names (component_id, element_kind, kind_params, input_ports,
    output_ports, from_component_id, from_port, to_component_id, to_port,
    free_space_mm).
    """

    if emitter_kinds is None:
        emitter_kinds = {"laser_source", "tapered_amplifier"}

    nodes: dict[uuid.UUID, Any] = {elem.component_id: elem for elem in elements}
    incoming: dict[uuid.UUID, list[Any]] = defaultdict(list)
    outgoing: dict[uuid.UUID, list[Any]] = defaultdict(list)
    for link in links:
        incoming[link.to_component_id].append(link)
        outgoing[link.from_component_id].append(link)

    result = ChainResult(run_id=run_id or uuid.uuid4())

    if not nodes:
        result.warnings.append("No optical elements in scene.")
        return result

    # Topological sort
    in_degree = {nid: len(incoming[nid]) for nid in nodes}
    queue: deque[uuid.UUID] = deque(nid for nid, deg in in_degree.items() if deg == 0)
    ordered: list[uuid.UUID] = []
    while queue:
        nid = queue.popleft()
        ordered.append(nid)
        for link in outgoing[nid]:
            in_degree[link.to_component_id] -= 1
            if in_degree[link.to_component_id] == 0:
                queue.append(link.to_component_id)
    if len(ordered) != len(nodes):
        result.errors.append("Optical graph contains a cycle.")
        return result

    # Validate roots are emitters
    roots = [nid for nid in nodes if not incoming[nid]]
    if not roots:
        result.errors.append("No emitter element found (need a laser_source or tapered_amplifier).")
        return result
    for root_id in roots:
        kind = nodes[root_id].element_kind
        if kind not in emitter_kinds:
            result.errors.append(
                f"Component {root_id} is a chain root but element_kind '{kind}' cannot emit. "
                f"Only {sorted(emitter_kinds)} may be roots."
            )
    if result.errors:
        return result

    # State: beam at each (target_node_id, target_port) after free-space propagation.
    beam_at_input: dict[tuple[uuid.UUID, str], Beam] = {}

    for nid in ordered:
        elem = nodes[nid]
        kind = elem.element_kind
        params = elem.kind_params or {}

        if kind in emitter_kinds:
            if kind == "laser_source":
                beam_at_output: dict[str, Beam] = {"out": emit_from_laser_source(params)}
            else:  # tapered_amplifier; check for seed input
                seed = beam_at_input.get((nid, "seed"))
                beam_at_output = {"out": emit_from_tapered_amplifier(params, seed)}
        else:
            # Aggregate inputs (for now use the first available input port)
            primary_in: Beam | None = None
            for port_id in _ports_of(elem, "input"):
                key = (nid, port_id)
                if key in beam_at_input:
                    primary_in = beam_at_input[key]
                    break

            if primary_in is None:
                result.warnings.append(f"Element {nid} ({kind}) has no incoming beam; skipping.")
                continue

            beam_at_output = _dispatch_element(kind, primary_in, elem, params, result)

        # Propagate each outgoing port through its link's free space
        for link in outgoing[nid]:
            beam = beam_at_output.get(link.from_port)
            if beam is None:
                result.warnings.append(
                    f"Link from {nid}:{link.from_port} has no beam; skipping segment."
                )
                continue
            propagated = replace(
                beam,
                q_x=propagate_q(beam.q_x, link.free_space_mm),
                q_y=propagate_q(beam.q_y, link.free_space_mm),
            )
            result.segments.append(propagated.to_segment_dict(link.id, result.run_id))
            beam_at_input[(link.to_component_id, link.to_port)] = propagated

    return result


def _dispatch_element(
    kind: str,
    beam: Beam,
    elem: Any,
    params: dict[str, Any],
    result: ChainResult,
) -> dict[str, Beam]:
    if kind == "mirror":
        return apply_mirror(beam, params)
    if kind == "lens_spherical":
        return apply_lens_spherical(beam, params)
    if kind == "lens_cylindrical":
        return apply_lens_cylindrical(beam, params)
    if kind == "waveplate":
        return apply_waveplate(beam, params)
    if kind == "polarizer":
        return apply_polarizer(beam, params)
    if kind == "beam_splitter":
        return apply_beam_splitter(beam, params)
    if kind == "dichroic_mirror":
        return apply_dichroic_mirror(beam, params)
    if kind == "fiber_coupler":
        return apply_fiber_coupler(beam, params)
    if kind == "isolator":
        return apply_isolator(beam, params)
    if kind == "aom":
        outputs: dict[str, Beam] = {}
        for port_id in _ports_of(elem, "output"):
            beam_for_port = apply_aom(beam, params, port_id)
            if beam_for_port is not None:
                outputs[port_id] = beam_for_port
        return outputs
    if kind == "eom":
        return apply_eom(beam, params)
    if kind == "nonlinear_crystal":
        return apply_nonlinear_crystal(beam, params)
    if kind == "saturable_absorber":
        return apply_saturable_absorber(beam, params)
    if kind in {"detector", "camera", "spectrometer", "wavemeter", "beam_dump"}:
        # Sinks: terminate. Still record the incoming beam by emitting nothing.
        return {}
    result.warnings.append(f"No solver dispatch for element_kind '{kind}'; treating as identity.")
    return {port_id: beam for port_id in _ports_of(elem, "output")}
