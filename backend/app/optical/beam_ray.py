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
    wavelength_nm: float
    power_mw: float

    # Polarization (beam-local s/p frame)
    jones: tuple[complex, complex]   # (E_s, E_p)

    # Tracking
    path_length_mm: float = 0.0
    phase_accum_rad: float = 0.0

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
