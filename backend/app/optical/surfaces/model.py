"""Runtime form of ``assets_3d.surface_model`` (docs/surface-optics.md).

``parse_surface_model`` validates the stored JSON through ``SurfaceModelV3``
and turns it into frozen dataclasses with ``Vec3`` axes, re-orthonormalised
(the schema accepts axes within 1e-4 of unit / orthogonal).
"""

from __future__ import annotations

import dataclasses
import math
from dataclasses import dataclass
from typing import Any, Optional

from app.optical.beam_ray import Vec3
from app.optical.surfaces.materials import ISOTROPIC, UNIAXIAL

AIR = "air"
OPAQUE = "opaque"

# Kinds that keep their anchor op even when an asset carries a surface model
# (docs/surface-optics.md, "Decisions"): the emitters and gain chip, the sinks,
# fibre coupling, and the (fibre-pigtailed) EOM.
OP_ONLY_KINDS = frozenset({
    "tapered_amplifier", "laser_source",
    "detector", "camera", "spectrometer", "wavemeter", "beam_dump",
    "fiber", "fiber_coupler", "fiber_connector",
    "eom",
})


def cross(a: Vec3, b: Vec3) -> Vec3:
    return Vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)


@dataclass(frozen=True)
class Medium:
    id: str
    n: Optional[float] = None
    material: Optional[str] = None
    n_o: Optional[float] = None
    n_e: Optional[float] = None
    optic_axis: Optional[Vec3] = None
    # Faraday rotation (rad per mm along magnetic_axis); see MediumV3.
    faraday_rad_per_mm: float = 0.0
    magnetic_axis: Optional[Vec3] = None

    @property
    def uniaxial(self) -> bool:
        return self.n_o is not None or self.material in UNIAXIAL

    def indices(self, wavelength_nm: float) -> tuple[float, Optional[float]]:
        """``(n, None)`` for an isotropic medium, ``(n_o, n_e)`` for a
        uniaxial one."""
        if self.n is not None:
            return self.n, None
        if self.n_o is not None:
            return self.n_o, self.n_e
        if self.material in ISOTROPIC:
            return ISOTROPIC[self.material].n(wavelength_nm), None
        o, e = UNIAXIAL[self.material]
        return o.n(wavelength_nm), e.n(wavelength_nm)

    def mode_index(self, mode: Optional[str], direction: Vec3, wavelength_nm: float) -> float:
        """The index a ray of this eigenmode sees: n (isotropic), n_o, or
        n_e(θ) with ``1/n_e(θ)² = cos²θ/n_o² + sin²θ/n_e²``, θ from the
        optic axis to the wave vector."""
        n_o, n_e = self.indices(wavelength_nm)
        if n_e is None or mode != "e":
            return n_o
        c = self.optic_axis.dot(direction)
        return 1.0 / math.sqrt(c * c / (n_o * n_o) + (1.0 - c * c) / (n_e * n_e))


AIR_MEDIUM = Medium(AIR, n=1.0)


@dataclass(frozen=True)
class Surface:
    id: str
    vertex: Vec3
    x: Vec3            # normal at the vertex
    y: Vec3
    z: Vec3            # x × y
    shape: str         # plane | sphere | cylinder | conic
    radius_mm: Optional[float]
    conic: float
    aspheric: tuple[float, ...]   # A4, A6, ...
    aperture: str      # circle | rectangle | ellipse
    aperture_radius_mm: Optional[float]
    aperture_width_mm: Optional[float]
    aperture_height_mm: Optional[float]
    front: str         # medium on the +x side
    back: str          # medium on the −x side
    coating: str
    reflectance: Optional[float]
    extinction_pp_db: Optional[float]
    extinction_sp_db: Optional[float]


@dataclass(frozen=True)
class SurfaceModel:
    media: dict[str, Medium]
    surfaces: tuple[Surface, ...]

    def medium(self, medium_id: str) -> Medium:
        return AIR_MEDIUM if medium_id == AIR else self.media[medium_id]


def _vec(v: Any) -> Vec3:
    return Vec3(float(v.x), float(v.y), float(v.z))


def parse_surface_model(raw: dict[str, Any]) -> SurfaceModel:
    from app.schemas_v3 import SurfaceModelV3

    m = SurfaceModelV3.model_validate(raw)
    media = {
        mid: Medium(
            mid, n=md.n, material=md.material, n_o=md.n_o, n_e=md.n_e,
            optic_axis=_vec(md.optic_axis).normalized() if md.optic_axis else None,
            faraday_rad_per_mm=math.radians(md.faraday_rotation_deg_per_mm or 0.0),
            magnetic_axis=_vec(md.magnetic_axis).normalized() if md.magnetic_axis else None,
        )
        for mid, md in m.media.items()
    }
    surfaces = []
    for s in m.surfaces:
        x = _vec(s.axis_x_body_local).normalized()
        y0 = _vec(s.axis_y_body_local)
        y = (y0 - x * y0.dot(x)).normalized()
        surfaces.append(Surface(
            id=s.id, vertex=_vec(s.position_mm_body_local), x=x, y=y, z=cross(x, y),
            shape=s.shape.type, radius_mm=s.shape.radius_mm,
            conic=s.shape.conic or 0.0, aspheric=tuple(s.shape.aspheric_coeffs or ()),
            aperture=s.aperture.shape, aperture_radius_mm=s.aperture.radius_mm,
            aperture_width_mm=s.aperture.width_mm, aperture_height_mm=s.aperture.height_mm,
            front=s.front, back=s.back,
            coating=s.coating.type, reflectance=s.coating.reflectance,
            extinction_pp_db=s.coating.extinction_ratio_pp_db,
            extinction_sp_db=s.coating.extinction_ratio_sp_db,
        ))
    return SurfaceModel(media=media, surfaces=tuple(surfaces))


def rotate_optic_axes(model: SurfaceModel, axis: Vec3, angle_rad: float) -> SurfaceModel:
    """The model with every uniaxial medium's optic axis rotated by
    ``angle_rad`` about ``axis`` (right-handed) — a waveplate's per-instance
    ``fastAxisDeg``, which the waveplate op applies as axisY → axisZ about
    axisX."""
    if angle_rad == 0.0:
        return model
    k = axis.normalized()
    c, s = math.cos(angle_rad), math.sin(angle_rad)

    def rot(v: Vec3) -> Vec3:     # Rodrigues
        return v * c + cross(k, v) * s + k * (k.dot(v) * (1.0 - c))

    media = {
        mid: dataclasses.replace(m, optic_axis=rot(m.optic_axis)) if m.optic_axis is not None else m
        for mid, m in model.media.items()
    }
    return SurfaceModel(media=media, surfaces=model.surfaces)


def unit_or_none(v: Vec3) -> Optional[Vec3]:
    n = math.sqrt(v.dot(v))
    return None if n < 1e-12 else Vec3(v.x / n, v.y / n, v.z / n)
