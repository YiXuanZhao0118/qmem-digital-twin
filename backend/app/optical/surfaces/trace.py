"""Trace a ray through one part's surface model (docs/surface-optics.md).

The part is surfaces + media, not a sequence: in its current medium a ray
meets the nearest surface (inside that surface's aperture), and the surface
names what is on the far side. That one rule covers reverse traversal, the
two branches of a PBS and air gaps inside one asset without per-kind code.

Everything is in the part's own (body) frame. Standalone for now: Phase 2
wires it into the anchor tracer.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from app.optical.beam_ray import BeamRay, QMatrix, Vec3
from app.optical.jones import beam_local_sp, jones_rotation_angle, rotate_jones
from app.optical.surfaces.geometry import SurfaceHit, intersect
from app.optical.surfaces.interface import interact
from app.optical.surfaces.model import AIR, OPAQUE, Surface, SurfaceModel, cross, unit_or_none

MAX_INTERACTIONS = 32


@dataclass(frozen=True)
class InternalSegment:
    ray: BeamRay       # state at the start of the segment
    end: Vec3
    medium: str


@dataclass
class ElementTrace:
    exits: list[BeamRay] = field(default_factory=list)   # rays leaving into air
    segments: list[InternalSegment] = field(default_factory=list)
    absorbed_mw: float = 0.0
    lost_mw: float = 0.0
    lost: list[str] = field(default_factory=list)


def propagate_in_medium(ray: BeamRay, t: float, model: SurfaceModel, medium_id: str) -> BeamRay:
    """Move the ray a geometric distance ``t`` through a medium: reduced Q
    advances by ``t/n``, the path length by ``t``, and a uniaxial medium
    retards the extraordinary component by ``2π·(n_e(θ) − n_o)·t/λ``."""
    medium = model.medium(medium_id)
    n_o, n_e = medium.indices(ray.wavelength_nm)
    step = t / n_o
    q = ray.q_matrix
    out = ray.with_q_matrix(QMatrix(q.xx + step, q.yy + step, q.xy)).replaced(
        origin=ray.origin + ray.direction * t,
        path_length_mm=ray.path_length_mm + t,
    )
    if n_e is None:
        return out
    d = ray.direction
    e_o = unit_or_none(cross(d, medium.optic_axis))
    if e_o is None:          # along the optic axis: no birefringence
        return out
    cos_th = d.dot(medium.optic_axis)
    n_theta = 1.0 / math.sqrt(cos_th ** 2 / n_o ** 2 + (1.0 - cos_th ** 2) / n_e ** 2)
    delta = 2.0 * math.pi * (n_theta - n_o) * t / (ray.wavelength_nm * 1e-6)
    s_canon, _ = beam_local_sp(d)
    phi = jones_rotation_angle(s_canon, e_o, d)
    j_o, j_e = rotate_jones(out.jones, phi)          # (e_o, d × e_o) basis
    return out.replaced(jones=rotate_jones((j_o, j_e * complex(math.cos(delta), math.sin(delta))), -phi))


def _nearest(model: SurfaceModel, ray: BeamRay) -> tuple[Surface, SurfaceHit] | None:
    best = None
    for s in model.surfaces:
        h = intersect(s, ray.origin, ray.direction)
        if h is not None and (best is None or h.t < best[1].t):
            best = (s, h)
    return best


def trace_element(model: SurfaceModel, ray: BeamRay) -> ElementTrace:
    """Trace ``ray`` (in air, body frame) through the part. A ray that meets
    no surface comes back unchanged in ``exits``."""
    result = ElementTrace()
    queue: list[tuple[BeamRay, str, bool]] = [(ray, AIR, False)]   # (ray, medium, inside?)
    interactions = 0
    while queue:
        r, medium, inside = queue.pop(0)
        found = _nearest(model, r)
        if found is None:
            if medium == AIR:
                result.exits.append(r)
            else:
                result.lost_mw += r.power_mw
                result.lost.append(f"left {medium!r} through no surface")
            continue
        surface, hit = found
        arriving = surface.back if r.direction.dot(hit.normal) > 0.0 else surface.front
        if arriving != medium:
            if arriving == OPAQUE:
                result.absorbed_mw += r.power_mw
            else:
                result.lost_mw += r.power_mw
                result.lost.append(
                    f"in {medium!r} but met surface {surface.id!r} from its {arriving!r} side"
                )
            continue
        interactions += 1
        if interactions > MAX_INTERACTIONS:
            result.lost_mw += r.power_mw
            result.lost.append("interaction budget exceeded")
            continue
        if inside:
            result.segments.append(InternalSegment(r, hit.point, medium))
        at_surface = propagate_in_medium(r, hit.t, model, medium)
        outs, dropped = interact(at_surface, hit, surface, model)
        result.lost.extend(dropped)
        for o in outs:
            if o.medium == OPAQUE:
                result.absorbed_mw += o.ray.power_mw
            else:
                queue.append((o.ray, o.medium, True))
    return result
