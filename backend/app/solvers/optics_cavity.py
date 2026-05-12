"""Pure-analytical optical cavity calculator — Phase Optics-Cavity.

Three cavity types:

  - linear   : two-mirror Fabry-Perot. Round-trip path = 2L.
  - ring_tri : 3-mirror ring (triangle). Round-trip = L (already total).
  - ring_bow : 4-mirror bowtie. Round-trip = L (already total).

The solver returns a bundle of derived quantities and an optional Airy
transmission spectrum sampled around the resonance closest to the
requested wavelength. No DB persistence, no SolverRunner — cavity
calculations are sub-millisecond, so the route just returns the result
synchronously.

Conventions
-----------
- Mirror reflectivities R_i are intensity reflectivities in [0, 1).
- Effective round-trip reflectivity:  R_rt = product(R_i)
- One-pass internal loss:  1 - T_loss  (T_loss in [0, 1])
- FSR_hz  = c0 / L_round_trip_m
- Finesse = pi * (R_rt * (1-T_loss))**(1/4) / (1 - sqrt(R_rt * (1-T_loss)))
            (Bourgault / Born&Wolf form for an asymmetric cavity)
- FWHM    = FSR / Finesse
- Q       = nu_0 / FWHM
- tau_photon = Q / (2*pi*nu_0)
- Stability (linear, two-mirror):  0 <= g1*g2 <= 1, where
    g_i = 1 - L / R_i_curv   (R_i_curv = mirror radius of curvature)
    Flat mirror: R_i_curv = inf  ->  g_i = 1.

All lengths in mm on the wire; converted to SI internally.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal


C0_M_PER_S = 2.998_792_458e8


CavityKind = Literal["linear", "ring_tri", "ring_bow"]


@dataclass
class CavityMirror:
    """One mirror in the cavity. R is intensity reflectivity in [0, 1).
    `radius_curvature_mm` may be None (flat) or +inf-equivalent."""

    reflectivity: float
    radius_curvature_mm: float | None = None  # None = flat


@dataclass
class CavityRequest:
    kind: CavityKind
    length_mm: float
    """For 'linear' this is mirror-to-mirror separation L (round trip = 2L).
    For ring kinds this is the *total* round-trip path length."""
    wavelength_nm: float
    mirrors: list[CavityMirror]
    intracavity_loss: float = 0.0  # one-pass intensity loss (0..1)
    refractive_index: float = 1.0
    spectrum_span_fsr: float = 4.0  # how many FSR to plot around resonance
    spectrum_points: int = 401


@dataclass
class CavityResult:
    fsr_hz: float
    fsr_mhz: float
    round_trip_length_mm: float
    finesse: float
    linewidth_hz: float
    linewidth_mhz: float
    linewidth_pm: float  # converted to wavelength FWHM at the design lambda
    quality_factor: float
    photon_lifetime_ns: float
    resonance_wavelength_nm: float
    resonance_frequency_thz: float
    rt_reflectivity: float
    g1g2: float | None  # only for 'linear' two-mirror cavities
    stable: bool | None
    waist_um: float | None  # TEM00 waist for stable two-mirror cavity
    spectrum_freq_offset_mhz: list[float]
    spectrum_transmission: list[float]
    spectrum_reflection: list[float]
    warnings: list[str]


def _round_trip_length_m(req: CavityRequest) -> float:
    if req.kind == "linear":
        return 2.0 * req.length_mm * 1e-3 * req.refractive_index
    return req.length_mm * 1e-3 * req.refractive_index


def _airy(phase: float, R: float) -> tuple[float, float]:
    """Symmetric Fabry-Perot Airy. Returns (transmission, reflection)
    fractions of incident intensity. `phase` is the round-trip phase
    in radians; `R` is the effective round-trip intensity reflectivity
    (already includes loss)."""
    if R >= 1.0:
        return 0.0, 1.0
    F = 4.0 * R / (1.0 - R) ** 2
    t = 1.0 / (1.0 + F * math.sin(phase / 2.0) ** 2)
    return t, 1.0 - t


def _two_mirror_waist_um(
    L_mm: float, R1_mm: float | None, R2_mm: float | None, wavelength_nm: float
) -> float | None:
    """TEM00 waist of a stable two-mirror cavity (waist on the mirror
    with smaller curvature). Flat mirror -> waist sits on it."""
    if R1_mm is None and R2_mm is None:
        return None  # plane-parallel: waist undefined (marginally stable)
    L = L_mm * 1e-3
    lam = wavelength_nm * 1e-9

    g1 = 1.0 if R1_mm is None else 1.0 - L_mm / R1_mm
    g2 = 1.0 if R2_mm is None else 1.0 - L_mm / R2_mm
    g1g2 = g1 * g2
    if g1g2 < 0 or g1g2 > 1:
        return None  # unstable
    denom = (g1 + g2 - 2 * g1 * g2) ** 2
    if denom <= 0:
        return None
    w0_sq = (lam * L / math.pi) * math.sqrt(g1g2 * (1 - g1g2)) / (g1 + g2 - 2 * g1 * g2)
    if w0_sq <= 0:
        return None
    return math.sqrt(w0_sq) * 1e6  # m -> um


def compute(req: CavityRequest) -> CavityResult:
    warnings: list[str] = []

    if req.length_mm <= 0:
        raise ValueError("length_mm must be > 0")
    if req.wavelength_nm <= 0:
        raise ValueError("wavelength_nm must be > 0")
    if not req.mirrors:
        raise ValueError("at least one mirror required")
    for m in req.mirrors:
        if not (0.0 <= m.reflectivity < 1.0):
            raise ValueError("mirror reflectivity must be in [0, 1)")

    expected_count = {"linear": 2, "ring_tri": 3, "ring_bow": 4}[req.kind]
    if len(req.mirrors) != expected_count:
        warnings.append(
            f"{req.kind} expects {expected_count} mirrors, got {len(req.mirrors)} — "
            f"using product of given reflectivities"
        )

    L_rt_m = _round_trip_length_m(req)
    fsr_hz = C0_M_PER_S / L_rt_m

    R_rt_raw = 1.0
    for m in req.mirrors:
        R_rt_raw *= m.reflectivity
    one_pass_loss = max(0.0, min(1.0, req.intracavity_loss))
    # Round-trip intensity factor — for ring_*, light passes loss once per
    # trip; for linear it passes the medium twice. Approximate uniformly
    # as one-pass since loss is usually a single intracavity element.
    R_eff = R_rt_raw * (1.0 - one_pass_loss)

    if R_eff >= 1.0:
        finesse = float("inf")
    else:
        # Born & Wolf (7.62): F = pi * R^(1/4) / (1 - sqrt(R))
        R_qsqrt = R_eff ** 0.25
        finesse = math.pi * R_qsqrt / (1.0 - math.sqrt(R_eff))

    linewidth_hz = fsr_hz / finesse if finesse > 0 else float("inf")
    linewidth_mhz = linewidth_hz * 1e-6

    # Wavelength FWHM at the design lambda: dλ ≈ λ² / c · dν
    lam_m = req.wavelength_nm * 1e-9
    linewidth_m = (lam_m ** 2 / C0_M_PER_S) * linewidth_hz
    linewidth_pm = linewidth_m * 1e12

    nu0 = C0_M_PER_S / lam_m
    quality_factor = nu0 / linewidth_hz if linewidth_hz > 0 else float("inf")
    photon_lifetime_ns = (
        quality_factor / (2 * math.pi * nu0) * 1e9 if math.isfinite(quality_factor) else float("inf")
    )

    # Stability (only linear two-mirror cavities have a clean g-parameter).
    g1g2 = None
    stable = None
    waist_um = None
    if req.kind == "linear" and len(req.mirrors) == 2:
        R1 = req.mirrors[0].radius_curvature_mm
        R2 = req.mirrors[1].radius_curvature_mm
        g1 = 1.0 if R1 is None else 1.0 - req.length_mm / R1
        g2 = 1.0 if R2 is None else 1.0 - req.length_mm / R2
        g1g2 = g1 * g2
        stable = 0.0 <= g1g2 <= 1.0
        if stable:
            waist_um = _two_mirror_waist_um(req.length_mm, R1, R2, req.wavelength_nm)
        else:
            warnings.append(
                f"Cavity is geometrically unstable: g1*g2 = {g1g2:.3f} (need 0 <= g1*g2 <= 1)"
            )

    # Airy spectrum centered on the resonance closest to lambda. Frequency
    # axis is offset from nu0 in MHz; transmission is the standard Airy
    # function (= 1 at resonance for a symmetric, lossless cavity).
    span_fsr = max(0.5, req.spectrum_span_fsr)
    n_pts = max(11, min(2001, req.spectrum_points))
    span_hz = span_fsr * fsr_hz
    df = span_hz / (n_pts - 1)
    spectrum_freq_offset_mhz: list[float] = []
    spectrum_t: list[float] = []
    spectrum_r: list[float] = []
    for i in range(n_pts):
        f_offset_hz = -span_hz / 2.0 + i * df
        # Round-trip phase: 2*pi * (round_trip_length / lambda(f))
        nu = nu0 + f_offset_hz
        if nu <= 0:
            spectrum_freq_offset_mhz.append(f_offset_hz * 1e-6)
            spectrum_t.append(0.0)
            spectrum_r.append(1.0)
            continue
        phase = 2.0 * math.pi * L_rt_m * nu / C0_M_PER_S
        t, r = _airy(phase, R_eff)
        spectrum_freq_offset_mhz.append(f_offset_hz * 1e-6)
        spectrum_t.append(t)
        spectrum_r.append(r)

    return CavityResult(
        fsr_hz=fsr_hz,
        fsr_mhz=fsr_hz * 1e-6,
        round_trip_length_mm=L_rt_m * 1e3,
        finesse=finesse,
        linewidth_hz=linewidth_hz,
        linewidth_mhz=linewidth_mhz,
        linewidth_pm=linewidth_pm,
        quality_factor=quality_factor,
        photon_lifetime_ns=photon_lifetime_ns,
        resonance_wavelength_nm=req.wavelength_nm,
        resonance_frequency_thz=nu0 * 1e-12,
        rt_reflectivity=R_eff,
        g1g2=g1g2,
        stable=stable,
        waist_um=waist_um,
        spectrum_freq_offset_mhz=spectrum_freq_offset_mhz,
        spectrum_transmission=spectrum_t,
        spectrum_reflection=spectrum_r,
        warnings=warnings,
    )
