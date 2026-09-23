"""Surface geometry: sag, ray intersection, local normal and curvature.

Local coordinates of a surface: ``u = (r − vertex)·y``, ``v = (r − vertex)·z``
and the sag ``w = (r − vertex)·x = s(u, v)``. ``radius_mm > 0`` puts the centre
of curvature on the +x side, so near the vertex ``s ≈ (u² + v²)/(2R)``.

The curvature tensor ``K`` returned with a hit is the second fundamental form
in an orthonormal tangent basis ``(e1, e2)`` with respect to the unit normal
``normal`` (which points to the +x side): ``K > 0`` means the surface curves
toward +normal. It is exact off-vertex, which is what makes a decentred or
tilted curved surface come out right.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

from app.optical.beam_ray import Vec3
from app.optical.surfaces.model import Surface, cross

T_MIN = 1e-9   # same self-intersection guard as the anchor tracer


@dataclass(frozen=True)
class Sag:
    w: float
    wu: float
    wv: float
    wuu: float
    wuv: float
    wvv: float


@dataclass(frozen=True)
class SurfaceHit:
    t: float
    point: Vec3
    u: float
    v: float
    normal: Vec3                          # unit, +x side
    e1: Vec3                              # orthonormal tangent basis,
    e2: Vec3                              # (e1, e2, normal) right-handed
    k: tuple[float, float, float]         # K in (e1, e2): (k11, k22, k12)


def sag(surface: Surface, u: float, v: float) -> Optional[Sag]:
    """Sag and its first/second derivatives, or None outside the surface's
    domain (past the rim of a sphere, or a conic's turning point)."""
    if surface.shape == "plane":
        return Sag(0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    c = 1.0 / surface.radius_mm
    if surface.shape == "cylinder":
        root = 1.0 - c * c * u * u
        if root <= 0.0:
            return None
        s = math.sqrt(root)
        return Sag(c * u * u / (1.0 + s), c * u / s, 0.0, c / s ** 3, 0.0, 0.0)
    # sphere, conic: rotationally symmetric, s = f(r2) with r2 = u² + v²
    k = surface.conic if surface.shape == "conic" else 0.0
    r2 = u * u + v * v
    root = 1.0 - (1.0 + k) * c * c * r2
    if root <= 0.0:
        return None
    s = math.sqrt(root)
    f = c * r2 / (1.0 + s)
    f1 = c / (2.0 * s)
    f2 = (1.0 + k) * c ** 3 / (4.0 * s ** 3)
    if surface.shape == "conic":
        for j, a in enumerate(surface.aspheric):   # A4·r2², A6·r2³, ...
            p = j + 2
            f += a * r2 ** p
            f1 += p * a * r2 ** (p - 1)
            f2 += p * (p - 1) * a * r2 ** (p - 2)
    return Sag(
        f,
        2.0 * u * f1, 2.0 * v * f1,
        2.0 * f1 + 4.0 * u * u * f2, 4.0 * u * v * f2, 2.0 * f1 + 4.0 * v * v * f2,
    )


def _local(surface: Surface, r: Vec3) -> tuple[float, float, float]:
    d = r - surface.vertex
    return d.dot(surface.y), d.dot(surface.z), d.dot(surface.x)


def _quadratic_roots(a: float, b: float, c: float) -> list[float]:
    if abs(a) < 1e-300:
        return [] if abs(b) < 1e-300 else [-c / b]
    disc = b * b - 4.0 * a * c
    if disc < 0.0:
        return []
    sq = math.sqrt(disc)
    q = -0.5 * (b + math.copysign(sq, b))   # stable form
    roots = [q / a]
    if q != 0.0:
        roots.append(c / q)
    return sorted(roots)


def _candidate_ts(surface: Surface, o: Vec3, d: Vec3) -> list[float]:
    """Parameters t (ascending) where the ray meets the surface's own sheet —
    the one containing the vertex, not the far side of the sphere."""
    if surface.shape == "plane":
        den = d.dot(surface.x)
        if abs(den) < 1e-15:
            return []
        return [(surface.vertex - o).dot(surface.x) / den]
    if surface.shape in ("sphere", "cylinder"):
        r = surface.radius_mm
        centre = surface.vertex + surface.x * r
        oc, dd = o - centre, d
        if surface.shape == "cylinder":   # drop the component along the axis (z)
            oc = oc - surface.z * oc.dot(surface.z)
            dd = d - surface.z * d.dot(surface.z)
        ts = _quadratic_roots(dd.dot(dd), 2.0 * oc.dot(dd), oc.dot(oc) - r * r)
        # the vertex cap has (p − centre)·x of the opposite sign to R
        return [t for t in ts if (o + d * t - centre).dot(surface.x) * r < 0.0]
    # conic / asphere: Newton on F(t) = w(t) − s(u(t), v(t)) from the plane hit
    den = d.dot(surface.x)
    if abs(den) < 1e-15:
        return []
    t = (surface.vertex - o).dot(surface.x) / den
    du, dv = d.dot(surface.y), d.dot(surface.z)
    for _ in range(50):
        u, v, w = _local(surface, o + d * t)
        sg = sag(surface, u, v)
        if sg is None:
            return []
        fp = den - sg.wu * du - sg.wv * dv
        if abs(fp) < 1e-15:
            return []
        step = (w - sg.w) / fp
        t -= step
        if abs(step) < 1e-12:
            return [t]
    return []


def _in_aperture(surface: Surface, u: float, v: float) -> bool:
    if surface.aperture == "circle":
        return u * u + v * v <= surface.aperture_radius_mm ** 2
    hw, hh = 0.5 * surface.aperture_width_mm, 0.5 * surface.aperture_height_mm
    if surface.aperture == "rectangle":
        return abs(u) <= hw and abs(v) <= hh
    return (u / hw) ** 2 + (v / hh) ** 2 <= 1.0


def intersect(surface: Surface, o: Vec3, d: Vec3, t_min: float = T_MIN) -> Optional[SurfaceHit]:
    """Nearest hit at ``t > t_min`` inside the aperture, with the local frame."""
    for t in _candidate_ts(surface, o, d):
        if t <= t_min:
            continue
        p = o + d * t
        u, v, _ = _local(surface, p)
        if not _in_aperture(surface, u, v):
            continue
        sg = sag(surface, u, v)
        if sg is None:
            continue
        return _hit(surface, t, p, u, v, sg)
    return None


def _hit(surface: Surface, t: float, p: Vec3, u: float, v: float, sg: Sag) -> SurfaceHit:
    x, y, z = surface.x, surface.y, surface.z
    g = math.sqrt(1.0 + sg.wu * sg.wu + sg.wv * sg.wv)
    normal = (x - y * sg.wu - z * sg.wv) * (1.0 / g)
    # Tangent vectors of r(u, v) = vertex + u·y + v·z + s·x, metric G = JᵀJ,
    # second fundamental form L = Hess(s)/g. For a unit tangent e = J·a the
    # normal curvature is aᵀLa, so K = AᵀLA with [e1 e2] = J·A.
    tu = y + x * sg.wu
    tv = z + x * sg.wv
    e1 = tu.normalized()
    e2 = cross(normal, e1)
    guu, guv, gvv = tu.dot(tu), tu.dot(tv), tv.dot(tv)
    det = guu * gvv - guv * guv
    # A = G⁻¹·Jᵀ·[e1 e2]
    j1 = (tu.dot(e1), tv.dot(e1))
    j2 = (tu.dot(e2), tv.dot(e2))
    a11 = (gvv * j1[0] - guv * j1[1]) / det
    a21 = (-guv * j1[0] + guu * j1[1]) / det
    a12 = (gvv * j2[0] - guv * j2[1]) / det
    a22 = (-guv * j2[0] + guu * j2[1]) / det
    luu, luv, lvv = sg.wuu / g, sg.wuv / g, sg.wvv / g

    def form(p1: float, p2: float, q1: float, q2: float) -> float:
        return p1 * (luu * q1 + luv * q2) + p2 * (luv * q1 + lvv * q2)

    k = (form(a11, a21, a11, a21), form(a12, a22, a12, a22), form(a11, a21, a12, a22))
    return SurfaceHit(t=t, point=p, u=u, v=v, normal=normal, e1=e1, e2=e2, k=k)
