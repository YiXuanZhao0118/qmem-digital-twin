"""BeamRay — Python mirror of frontend/src/optical/beam-ray.ts.

See that file's docstring for full convention. Highlights:
  - origin / direction in lab mm
  - qx, qy independent complex q-parameters (astigmatism)
  - jones = (E_s, E_p) in beam-local s/p frame
  - power in mW, wavelength in nm
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from typing import Optional


# ---------------------------------------------------------------------------
# Vec3
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Vec3:
    x: float
    y: float
    z: float

    def __add__(self, other: "Vec3") -> "Vec3":
        return Vec3(self.x + other.x, self.y + other.y, self.z + other.z)

    def __sub__(self, other: "Vec3") -> "Vec3":
        return Vec3(self.x - other.x, self.y - other.y, self.z - other.z)

    def __mul__(self, s: float) -> "Vec3":
        return Vec3(self.x * s, self.y * s, self.z * s)

    __rmul__ = __mul__

    def dot(self, other: "Vec3") -> float:
        return self.x * other.x + self.y * other.y + self.z * other.z

    def length(self) -> float:
        return math.sqrt(self.dot(self))

    def normalized(self) -> "Vec3":
        n = self.length()
        if n < 1e-15:
            raise ValueError("cannot normalize zero vector")
        return Vec3(self.x / n, self.y / n, self.z / n)


def vec3_distance(a: Vec3, b: Vec3) -> float:
    return (a - b).length()


# ---------------------------------------------------------------------------
# Complex helper (use built-in complex throughout)
# ---------------------------------------------------------------------------

def q_at_waist(waist_radius_mm: float, lambda_mm: float) -> complex:
    """q at the waist: q = i * z_R where z_R = pi * w0^2 / lambda."""
    z_r = math.pi * waist_radius_mm * waist_radius_mm / lambda_mm
    return complex(0.0, z_r)


# Non-paraxial divergence -----------------------------------------------------
# The q-parameter ABCD propagation is paraxial (z_R = π w₀²/λ), which makes the
# far-field half-angle θ = M²λ/(π w₀) — fine for w₀ ≫ λ, but it over-/mis-states
# divergence as w₀ → λ (high-NA fiber tips, tight focuses). We KEEP q paraxial
# (so chief-ray geometry + lens focusing stay correct) and apply the
# non-paraxial correction ONLY to the reported/rendered beam WIDTH:
#   s     = M²λ/(π w₀)            (paraxial divergence param = sin θ, rigorous)
#   floor : s ≤ 1  ⇔  w₀ ≥ M²λ/π (NA=1 diffraction limit; s>1 is evanescent)
#   z_R_eff = z_R·√(1−s²)         (far-field slope → tan(arcsin s) = s/√(1−s²))
# Low NA (s≪1): z_R_eff ≈ z_R, recovers the paraxial hyperbola exactly.
# Shared by the laser emitter, the optical-link cone, TA mode-match, and (next)
# fiber mode-match so every high-NA waist is treated identically.
_NONPARAXIAL_S_FLOOR = 0.999  # cap below 1 so z_R_eff never hits 0 (90° cone)


def nonparaxial_fundamental_waist_mm(
    q_re_mm: float, q_im_mm: float, m2: float, wavelength_nm: float,
) -> tuple[float, bool]:
    """Non-paraxial FUNDAMENTAL (mode-factor-excluded) real beam radius at the
    point described by paraxial ``q`` (``q_im`` = z_R, ``q_re`` = signed
    distance from the waist). Returns ``(w_real_mm, past_diffraction_limit)``;
    multiply by the transverse-mode width factor afterwards."""
    z_r = abs(q_im_mm)
    lam_mm = wavelength_nm * 1e-6
    if z_r <= 0.0 or lam_mm <= 0.0:
        return 0.0, False
    m2_eff = m2 if (m2 and m2 > 0) else 1.0
    w0_embedded_mm = math.sqrt(lam_mm * z_r / math.pi)
    w0_real_mm = w0_embedded_mm * math.sqrt(m2_eff)
    s = m2_eff * lam_mm / (math.pi * w0_real_mm) if w0_real_mm > 0 else 1.0
    past_limit = s >= 1.0
    s_eff = min(s, _NONPARAXIAL_S_FLOOR)
    z_r_eff = z_r * math.sqrt(1.0 - s_eff * s_eff)
    if z_r_eff <= 0.0:
        return w0_real_mm, past_limit
    w_real_mm = w0_real_mm * math.sqrt(1.0 + (q_re_mm / z_r_eff) ** 2)
    return w_real_mm, past_limit


# ---------------------------------------------------------------------------
# BeamRay
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class BeamRay:
    # Chief ray (lab frame, mm)
    origin: Vec3
    direction: Vec3                  # unit vector

    # Gaussian beam envelope (per-axis q)
    qx: complex
    qy: complex

    # Spectrum & energy
    wavelength_nm: float              # nominal optical carrier
    power_mw: float

    # Polarization (beam-local s/p frame)
    jones: tuple[complex, complex]   # (E_s, E_p)

    # Tracking
    path_length_mm: float = 0.0
    phase_accum_rad: float = 0.0
    # Accumulated optical-frequency offset (Hz) relative to the nominal carrier
    # implied by wavelength_nm. AOMs add order*f_RF here instead of perturbing
    # wavelength_nm, so a beat note between two rays is the exact difference of
    # their freq_offset_hz (no catastrophic cancellation).
    freq_offset_hz: float = 0.0

    # Embedded-Gaussian per-axis width multiplier (M²/mode upgrade). qx/qy
    # carry the EMBEDDED fundamental Gaussian (its z_R already reduced by M²
    # so divergence is correct); the REAL transverse width = (q-derived
    # embedded width) × width_mult. width_mult folds √(M²) and the high-order
    # transverse-mode factor (LG: √(2p+|l|+1) both axes; HG: x=√(2m+1),
    # y=√(2n+1)). 1.0 = TEM00, M²=1. Pure readout scale — does NOT affect
    # propagation, so it rides unchanged through every ABCD op via replaced().
    width_mult_x: float = 1.0
    width_mult_y: float = 1.0
    # Per-axis M² (beam quality), carried separately from width_mult so the
    # non-paraxial width correction can recover the divergence param s =
    # M²λ/(πw₀) at readout. mode_factor = width_mult / √M². Default 1.0 = M²=1.
    m2x: float = 1.0
    m2y: float = 1.0

    # Bookkeeping
    parent_id: Optional[str] = None
    exclude_face_key: Optional[str] = None
    is_ghost: bool = False

    def replaced(self, **kwargs) -> "BeamRay":
        """Return a new BeamRay with fields overridden."""
        return replace(self, **kwargs)


def make_beam_ray(
    *,
    origin: Vec3,
    direction: Vec3,
    wavelength_nm: float,
    waist_radius_mm: float = 0.5,
    power_mw: float = 1.0,
    jones: tuple[complex, complex] = (complex(1, 0), complex(0, 0)),
) -> BeamRay:
    """Build a BeamRay at a waist of `waist_radius_mm`, propagating along
    `direction`. Defaults: circular Gaussian (qx = qy), linearly polarized
    in +s, 1 mW."""
    lambda_mm = wavelength_nm * 1e-6
    q = q_at_waist(waist_radius_mm, lambda_mm)
    return BeamRay(
        origin=origin,
        direction=direction.normalized(),
        qx=q,
        qy=q,
        wavelength_nm=wavelength_nm,
        power_mw=power_mw,
        jones=jones,
    )
