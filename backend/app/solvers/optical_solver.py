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

import numpy as np
import numpy.typing as npt


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


def propagate_envelope(
    env: PulseEnvelopeArrays,
    distance_mm: float,
    refractive_index: float = 1.0,
    gvd_fs2_per_mm: float = 0.0,
    tod_fs3_per_mm: float = 0.0,
) -> PulseEnvelopeArrays:
    """Propagate a slowly-varying complex envelope through `distance_mm` of
    medium with the given GVD (β₂) and TOD (β₃) coefficients.

    Implementation: split-step Fourier in the rotating frame. The envelope is
    transformed to angular-frequency space (ω relative to carrier ω₀), each
    Fourier component is multiplied by

        H(ω) = exp(i · [(β₂·L·ω²)/2 + (β₃·L·ω³)/6])

    and the inverse FFT brings the result back to time. Carrier phase
    `exp(i·k₀·n·L)` is absorbed by the rotating frame (no-op on envelope).
    Group delay (β₁·L) is handled implicitly because we keep the same time
    grid; if you want absolute pulse arrival shifted, update `env.t0_ns` by
    `(refractive_index · L) / c · 1e9`.

    For CW envelopes (`is_cw=True`) this is a no-op: a single-sample envelope
    has no spectral width to disperse, so we just multiply by 1.
    """
    if env.is_cw or env.n_samples < 2 or (gvd_fs2_per_mm == 0.0 and tod_fs3_per_mm == 0.0):
        # No-op for CW or for non-dispersive media; only update t0 to track group delay.
        new_t0 = env.t0_ns + (refractive_index * distance_mm) / SPEED_OF_LIGHT_M_PER_S * 1e6
        return PulseEnvelopeArrays(
            is_cw=env.is_cw,
            t0_ns=new_t0,
            dt_ps=env.dt_ps,
            carrier_thz=env.carrier_thz,
            e_x=env.e_x.copy(),
            e_y=env.e_y.copy(),
        )

    n = env.n_samples
    dt_s = env.dt_ps * 1e-12  # ps → s
    # Angular frequency grid in rad/s (centered around 0; carrier is the rotating frame)
    omega = 2.0 * math.pi * np.fft.fftfreq(n, d=dt_s)
    # Convert GVD from fs²/mm to s²/mm, then multiply by L (mm)
    beta2_s2 = gvd_fs2_per_mm * 1e-30 * distance_mm
    beta3_s3 = tod_fs3_per_mm * 1e-45 * distance_mm
    phase = 0.5 * beta2_s2 * omega**2 + (1.0 / 6.0) * beta3_s3 * omega**3
    H = np.exp(1j * phase)

    Ex_w = np.fft.fft(env.e_x)
    Ey_w = np.fft.fft(env.e_y)
    Ex_out = np.fft.ifft(Ex_w * H)
    Ey_out = np.fft.ifft(Ey_w * H)

    new_t0 = env.t0_ns + (refractive_index * distance_mm) / SPEED_OF_LIGHT_M_PER_S * 1e6
    return PulseEnvelopeArrays(
        is_cw=False,
        t0_ns=new_t0,
        dt_ps=env.dt_ps,
        carrier_thz=env.carrier_thz,
        e_x=Ex_out,
        e_y=Ey_out,
    )


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


# --- PulseEnvelope (numpy-backed for fast math) ----------------------------
#
# This is the in-memory companion of the Pydantic `PulseEnvelope` schema. We
# keep the schema as plain Python lists for JSON portability and use this
# dataclass with numpy arrays for the math kernels.


@dataclass
class PulseEnvelopeArrays:
    """Numpy-backed slowly-varying complex envelope of an optical field.

    `e_x` and `e_y` are length-N complex arrays in √mW units (so |E|² is
    instantaneous power in mW). When `is_cw=True` the arrays are length 1
    and `dt_ps` is ignored.

    The envelope sits in the rotating frame of `carrier_thz`; the full field
    is `Re[E(t) · exp(-i·2π·carrier·t)]` for each polarisation.
    """
    is_cw: bool
    t0_ns: float
    dt_ps: float
    carrier_thz: float
    e_x: npt.NDArray[np.complex128]
    e_y: npt.NDArray[np.complex128]

    @property
    def n_samples(self) -> int:
        return int(self.e_x.shape[0])

    def time_axis_ns(self) -> npt.NDArray[np.float64]:
        if self.is_cw:
            return np.array([self.t0_ns])
        return self.t0_ns + np.arange(self.n_samples) * (self.dt_ps * 1e-3)

    def mean_power_mw(self) -> float:
        """Time-averaged |E_x|² + |E_y|² in mW."""
        return float(np.mean(np.abs(self.e_x) ** 2 + np.abs(self.e_y) ** 2))

    def to_schema_dict(self) -> dict[str, Any]:
        """Convert to JSON-friendly dict matching the Pydantic schema."""
        return {
            "isCw": self.is_cw,
            "t0Ns": self.t0_ns,
            "dtPs": self.dt_ps,
            "nSamples": self.n_samples,
            "carrierThz": self.carrier_thz,
            "eXRe": self.e_x.real.tolist(),
            "eXIm": self.e_x.imag.tolist(),
            "eYRe": self.e_y.real.tolist(),
            "eYIm": self.e_y.imag.tolist(),
        }

    @classmethod
    def cw(cls, *, carrier_thz: float, ex: complex, ey: complex) -> "PulseEnvelopeArrays":
        """Build a CW envelope from two complex polarisation amplitudes."""
        return cls(
            is_cw=True,
            t0_ns=0.0,
            dt_ps=0.0,
            carrier_thz=carrier_thz,
            e_x=np.array([ex], dtype=np.complex128),
            e_y=np.array([ey], dtype=np.complex128),
        )

    @classmethod
    def from_schema_dict(cls, data: dict[str, Any]) -> "PulseEnvelopeArrays":
        ex = np.asarray(data.get("eXRe", []), dtype=np.float64) + 1j * np.asarray(
            data.get("eXIm", []), dtype=np.float64
        )
        ey = np.asarray(data.get("eYRe", []), dtype=np.float64) + 1j * np.asarray(
            data.get("eYIm", []), dtype=np.float64
        )
        if ex.size == 0:
            ex = np.array([0.0 + 0.0j])
        if ey.size == 0:
            ey = np.array([0.0 + 0.0j])
        return cls(
            is_cw=bool(data.get("isCw", True)),
            t0_ns=float(data.get("t0Ns", 0.0)),
            dt_ps=float(data.get("dtPs", 0.0)),
            carrier_thz=float(data["carrierThz"]),
            e_x=ex,
            e_y=ey,
        )


def cw_envelope_from_polarization(
    carrier_thz: float, polarization: JonesArray, total_power_mw: float
) -> PulseEnvelopeArrays:
    """Build a CW PulseEnvelopeArrays from existing CW (Jones, power) state.

    Used as a bridge while the rest of the solver still tracks CW fields via
    `polarization` + `power_mw`. The envelope amplitudes √mW are scaled so
    that |Ex|² + |Ey|² == total_power_mw and the Jones direction is preserved.
    """
    norm = abs(polarization[0]) ** 2 + abs(polarization[1]) ** 2
    if norm <= 0:
        return PulseEnvelopeArrays.cw(carrier_thz=carrier_thz, ex=0.0, ey=0.0)
    scale = math.sqrt(total_power_mw / norm)
    return PulseEnvelopeArrays.cw(
        carrier_thz=carrier_thz,
        ex=complex(polarization[0]) * scale,
        ey=complex(polarization[1]) * scale,
    )


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
    # ------------------------------------------------------------------ time
    # Optional pulse envelope. When None the Beam represents a CW field with
    # `power_mw` and `polarization` carrying all the temporal information.
    # When present, the envelope IS the temporal information and `power_mw`
    # becomes a derived quantity (mean of |E|² over the envelope).
    envelope: "PulseEnvelopeArrays | None" = None

    def with_power(self, factor: float) -> "Beam":
        scale = math.sqrt(max(factor, 0.0))
        new_env: PulseEnvelopeArrays | None = None
        if self.envelope is not None:
            new_env = PulseEnvelopeArrays(
                is_cw=self.envelope.is_cw,
                t0_ns=self.envelope.t0_ns,
                dt_ps=self.envelope.dt_ps,
                carrier_thz=self.envelope.carrier_thz,
                e_x=self.envelope.e_x * scale,
                e_y=self.envelope.e_y * scale,
            )
        return replace(self, power_mw=max(self.power_mw * factor, 0.0), envelope=new_env)

    def to_segment_dict(
        self,
        link_id: uuid.UUID,
        run_id: uuid.UUID,
        beam_index: int = 0,
        sequence_t_ms: float | None = None,
    ) -> dict[str, Any]:
        return {
            "id": uuid.uuid4(),
            "simulation_run_id": run_id,
            "optical_link_id": link_id,
            "sequence_t_ms": sequence_t_ms,
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


def _gaussian_overlap_1d(seed_q: complex, target_mode: dict[str, Any] | None, wavelength_nm: float, m_squared: float) -> float:
    if not target_mode:
        return 1.0
    seed_w_um = w_at_z_um(seed_q, wavelength_nm, m_squared)
    target_w_um = float(target_mode.get("waistUm", seed_w_um))
    if seed_w_um <= 0 or target_w_um <= 0:
        return 0.0
    numerator = 2.0 * seed_w_um * target_w_um
    denominator = seed_w_um * seed_w_um + target_w_um * target_w_um
    return max(0.0, min(1.0, numerator / max(denominator, 1e-30)))


def gaussian_mode_overlap(seed: Beam, target_x: dict[str, Any] | None, target_y: dict[str, Any] | None) -> float:
    """Approximate TEM00 coupling from seed mode into the TA input mode.

    This intentionally uses the propagated seed beam radius at the TA seed
    port. Phase-front and lateral offset coupling are left to geometry/ray
    alignment; this term models the mode-size match the user asked for.
    """

    x = _gaussian_overlap_1d(seed.q_x, target_x, seed.wavelength_nm, _m2_of(seed, "x"))
    y = _gaussian_overlap_1d(seed.q_y, target_y, seed.wavelength_nm, _m2_of(seed, "y"))
    field_overlap = x * y
    return max(0.0, min(1.0, field_overlap * field_overlap))


def polarization_overlap(seed: JonesArray, target: JonesArray) -> float:
    seed_norm = abs(seed[0]) ** 2 + abs(seed[1]) ** 2
    target_norm = abs(target[0]) ** 2 + abs(target[1]) ** 2
    if seed_norm <= 1e-30 or target_norm <= 1e-30:
        return 0.0
    inner = seed[0] * target[0].conjugate() + seed[1] * target[1].conjugate()
    return max(0.0, min(1.0, (abs(inner) ** 2) / (seed_norm * target_norm)))


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

    input_mode_x = params.get("inputSpatialModeX") or params.get("backwardSpatialModeX")
    input_mode_y = params.get("inputSpatialModeY") or params.get("backwardSpatialModeY")
    mode_eta = gaussian_mode_overlap(seed, input_mode_x, input_mode_y)
    required_pol = jones_from_dict(params.get("inputPolarization") or {"exRe": 0.0, "eyRe": 1.0})
    pol_eta = polarization_overlap(seed.polarization, required_pol)
    effective_seed_power_mw = seed.power_mw * mode_eta * pol_eta

    # Saturated gain amplifier:  P_out = P_sat·G0·P_in / (P_sat + (G0-1)·P_in).
    # P_in is the *coupled* seed power, not merely the raw beam power hitting
    # the TA package: mode match and TE/polarization match both matter.
    gain_db = float(params["smallSignalGainDb"])
    p_sat = float(params["saturationPowerMw"])
    g0 = 10.0 ** (gain_db / 10.0)
    p_in = max(effective_seed_power_mw, 1e-12)
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
        polarization=required_pol,
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


def _kp_first(params: dict[str, Any], *names: str, default: Any = None) -> Any:
    """Phase 5 transitional helper: read the first non-None value among
    the listed JSON keys. Used while kindParams legacy names
    (`fastAxisDeg`, `transmissionAxisDeg`, ...) are migrated to their
    frame-suffixed equivalents (`fastAxisDegBeamLocal`,
    `transmissionAxisDegBeamLocal`, ...). Once alembic 0019 runs,
    only the new keys exist in DB; the legacy reads remain as a safety
    net for un-migrated input."""
    for name in names:
        v = params.get(name)
        if v is not None:
            return v
    return default


def apply_waveplate(beam: Beam, params: dict[str, Any]) -> dict[str, Beam]:
    matrix = jones_waveplate_matrix(
        float(params["retardanceLambda"]),
        float(_kp_first(params, "fastAxisDegBeamLocal", "fastAxisDeg", default=0.0)),
    )
    j = jones_apply_matrix(beam.polarization, matrix)
    return {"out": replace(beam, polarization=j).with_power(float(params.get("transmission", 0.99)))}


def apply_polarizer(beam: Beam, params: dict[str, Any]) -> dict[str, Beam]:
    matrix = jones_polarizer_matrix(
        float(_kp_first(params, "transmissionAxisDegBeamLocal", "transmissionAxisDeg", default=0.0)),
        float(params.get("transmission", 0.95)),
        float(params.get("extinctionRatioDb", 30.0)),
    )
    j = jones_apply_matrix(beam.polarization, matrix)
    intensity_factor = abs(j[0]) ** 2 + abs(j[1]) ** 2
    in_intensity = abs(beam.polarization[0]) ** 2 + abs(beam.polarization[1]) ** 2
    factor = intensity_factor / max(in_intensity, 1e-12)
    return {"out": replace(beam, polarization=j).with_power(factor)}


def apply_beam_splitter(beam: Beam, params: dict[str, Any]) -> dict[str, Beam]:
    transmission = float(params.get("transmission", 0.99))
    polarizing = bool(params.get("polarizing", False))

    if polarizing:
        # Polarising beamsplitter cube — diagonal interface between two right-
        # angle prisms. P-polarised (parallel to plane of incidence) transmits
        # straight through; S-polarised (perpendicular to plane of incidence)
        # reflects 90°. The plane of incidence depends on how the PBS is
        # oriented in the lab, so the PBS frame's P-axis is NOT necessarily
        # aligned with the beam's Jones x-axis.
        #
        # `transmissionAxisDeg` (default 0°) gives the angle of the PBS's
        # P-axis in the beam's local Jones frame:
        #   - 0°  → P=Ex (horizontal-incidence plane, reflection sideways)
        #   - 90° → P=Ey (vertical-incidence plane, reflection up/down — the
        #            convention shown in the Thorlabs PBS252 product diagram
        #            where the reflected beam goes "down" out of the cube)
        # Rotate into the PBS frame for branch powers; output polarization is
        # then reset to the pure P/S eigenstate in the beam's Jones frame.
        p_axis_deg = float(_kp_first(params, "transmissionAxisDegBeamLocal", "transmissionAxisDeg", default=0.0))
        theta_rad = math.radians(p_axis_deg)
        rot_into = jones_rotation(-theta_rad)  # beam frame → PBS frame
        rot_back = jones_rotation(theta_rad)   # PBS frame → beam frame

        in_jones = jones_apply_matrix(beam.polarization, rot_into)
        ip, is_ = in_jones  # Jones in PBS frame: (P-component, S-component)

        ex, ey = beam.polarization
        in_intensity = abs(ex) ** 2 + abs(ey) ** 2
        if in_intensity < 1e-30:
            zero = beam.with_power(0.0)
            return {"out_t": zero, "out_r": zero}
        t_factor = (abs(ip) ** 2 / in_intensity) * max(transmission, 0.0)
        r_factor = (abs(is_) ** 2 / in_intensity) * max(transmission, 0.0)
        # Branch power follows the input projection, but branch polarization is
        # the PBS eigenstate itself: transmitted = P-axis, reflected = S-axis.
        t_jones = jones_apply_matrix((complex(1.0), complex(0.0)), rot_back)
        r_jones = jones_apply_matrix((complex(0.0), complex(1.0)), rot_back)
        transmitted = replace(beam, polarization=t_jones).with_power(t_factor)
        reflected = replace(beam, polarization=r_jones).with_power(r_factor)
        return {"out_t": transmitted, "out_r": reflected}

    t = float(params.get("splitRatioTransmitted", 0.5))
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
    raw_order = params.get("diffractionOrder", 1)
    selected_order = -1 if raw_order == -1 else 0 if raw_order == 0 else 1
    if port == "0th":
        return beam.with_power(1.0 if selected_order == 0 else 1.0 - eta)
    if port == "+1st":
        new_spec = _shift_spectrum(beam.spectrum, +f_rf_mhz)
        return replace(beam.with_power(eta if selected_order == 1 else 0.0), spectrum=new_spec)
    if port == "-1st":
        new_spec = _shift_spectrum(beam.spectrum, -f_rf_mhz)
        return replace(beam.with_power(eta if selected_order == -1 else 0.0), spectrum=new_spec)
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
    program_factor_by_object: dict[uuid.UUID, float] | None = None,
    sequence_t_ms: float | None = None,
) -> ChainResult:
    """Pure-function chain solver.

    `elements`/`links` may be ORM instances or any object with the matching
    attribute names (object_id, element_kind, kind_params, input_ports,
    output_ports, from_object_id, from_port, to_object_id, to_port,
    free_space_mm).

    `program_factor_by_object`: optional per-OBJECT scalar in [0, ∞) that
    the solver multiplies into the element's primary scaling factor (laser
    power, AOM efficiency, EOM modulation depth, etc.). Per-object since
    timing programs are now keyed by object_id (alembic 0015).

    `sequence_t_ms`: stamped onto every BeamSegment row this run produces, so
    a transient pass can store one snapshot per timestep into the same
    `simulation_run_id` and reconstruct a time-series afterwards.
    """

    if emitter_kinds is None:
        emitter_kinds = {"laser_source", "tapered_amplifier"}
    factors = program_factor_by_object or {}

    nodes: dict[uuid.UUID, Any] = {elem.object_id: elem for elem in elements}
    incoming: dict[uuid.UUID, list[Any]] = defaultdict(list)
    outgoing: dict[uuid.UUID, list[Any]] = defaultdict(list)
    for link in links:
        incoming[link.to_object_id].append(link)
        outgoing[link.from_object_id].append(link)

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
            in_degree[link.to_object_id] -= 1
            if in_degree[link.to_object_id] == 0:
                queue.append(link.to_object_id)
    if len(ordered) != len(nodes):
        result.errors.append("Optical graph contains a cycle.")
        return result

    # Validate roots are emitters. A "root" here means an OpticalElement with
    # no incoming OpticalLink. Non-emitter roots (mirror, lens, …) are dangling
    # — they exist in the catalog but aren't wired into a beam path. That's a
    # config issue, not a fatal one; the rest of the graph (anything reachable
    # from a laser/TA) can still be solved. Demoted to a warning with an
    # actionable hint so the user knows how to fix it.
    roots = [nid for nid in nodes if not incoming[nid]]
    if not roots:
        result.errors.append("No emitter element found (need a laser_source or tapered_amplifier).")
        return result
    dangling_root_ids: set[uuid.UUID] = set()
    has_emitter_root = False
    for root_id in roots:
        kind = nodes[root_id].element_kind
        if kind in emitter_kinds:
            has_emitter_root = True
            continue
        dangling_root_ids.add(root_id)
        result.warnings.append(
            f"Component {root_id} is registered as '{kind}' but has no input link from a "
            f"laser/TA — it has no beam to act on. Add an OpticalLink so it receives a beam, "
            f"or delete its OpticalElement record. Skipping."
        )
    if not has_emitter_root:
        result.errors.append(
            "No emitter element is connected to the graph (need a laser_source or "
            "tapered_amplifier with at least one outgoing OpticalLink)."
        )
        return result

    # State: beam at each (target_node_id, target_port) after free-space propagation.
    beam_at_input: dict[tuple[uuid.UUID, str], Beam] = {}

    for nid in ordered:
        elem = nodes[nid]
        kind = elem.element_kind
        params = elem.kind_params or {}

        # Per-component timing factor: a scalar in [0, ∞) the timing solver
        # passed in for this component at the current sequence_t_ms. CW =
        # everyone gets 1.0 (default), so existing behaviour is preserved.
        factor = float(factors.get(nid, 1.0))
        scaled_params = _apply_program_factor(kind, params, factor)

        if kind in emitter_kinds:
            if kind == "laser_source":
                beam_at_output: dict[str, Beam] = {"out": emit_from_laser_source(scaled_params)}
            else:  # tapered_amplifier; check for seed input
                seed = beam_at_input.get((nid, "seed"))
                beam_at_output = {"out": emit_from_tapered_amplifier(scaled_params, seed)}
        else:
            # Aggregate inputs (for now use the first available input port)
            primary_in: Beam | None = None
            for port_id in _ports_of(elem, "input"):
                key = (nid, port_id)
                if key in beam_at_input:
                    primary_in = beam_at_input[key]
                    break

            if primary_in is None:
                if nid not in dangling_root_ids:
                    result.warnings.append(
                        f"Element {nid} ({kind}) has no incoming beam; skipping."
                    )
                continue

            beam_at_output = _dispatch_element(kind, primary_in, elem, scaled_params, result)

        # Propagate each outgoing port through its link's free space
        for link in outgoing[nid]:
            beam = beam_at_output.get(link.from_port)
            if beam is None:
                result.warnings.append(
                    f"Link from {nid}:{link.from_port} has no beam; skipping segment."
                )
                continue
            new_envelope = beam.envelope
            if new_envelope is not None:
                # Free space n=1, GVD=0; the envelope just gets group-delay shifted.
                # Dispersive media (fibers, crystals) are handled inside their
                # own apply_* functions, not here.
                new_envelope = propagate_envelope(
                    new_envelope, link.free_space_mm, refractive_index=1.0,
                )
            propagated = replace(
                beam,
                q_x=propagate_q(beam.q_x, link.free_space_mm),
                q_y=propagate_q(beam.q_y, link.free_space_mm),
                envelope=new_envelope,
            )
            result.segments.append(
                propagated.to_segment_dict(link.id, result.run_id, sequence_t_ms=sequence_t_ms)
            )
            beam_at_input[(link.to_object_id, link.to_port)] = propagated

    return result


def _apply_program_factor(
    kind: str, params: dict[str, Any], factor: float
) -> dict[str, Any]:
    """Multiply a TimingProgram value into the element's primary scalar.

    Per kind:
      - laser_source / tapered_amplifier:  nominalPowerMw   *= factor
      - aom:                                baseEfficiency  *= factor (clamped 0..1)
      - eom:                                kind_params["timingFactor"] = factor
                                            (consumed when modulation is added)
      - everything else: pass through unchanged.

    Returns a *new* dict so we don't mutate the caller's params.
    """
    if factor == 1.0:
        return params  # fast path — preserves caller identity for unaffected runs.
    if kind in ("laser_source", "tapered_amplifier"):
        nominal = float(params.get("nominalPowerMw", 0.0))
        return {**params, "nominalPowerMw": nominal * factor}
    if kind == "aom":
        eta = float(params.get("baseEfficiency", 0.85))
        # Clamp factor·eta into [0, 1] so we never claim >100 % diffraction.
        scaled = max(0.0, min(1.0, eta * factor))
        return {**params, "baseEfficiency": scaled}
    if kind == "eom":
        return {**params, "timingFactor": factor}
    return params


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
