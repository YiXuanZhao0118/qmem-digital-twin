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
from typing import Optional

from app.optical.aperture import (
    gaussian_circular_aperture_fraction,
    gaussian_rect_aperture_fraction,
    gaussian_width_mm,
)
from app.optical.beam_ray import BeamRay, QMatrix, Vec3
from app.optical.jones import beam_local_sp, jones_intensity, rotate_jones
from app.optical.surfaces.geometry import SurfaceHit, intersect
from app.optical.surfaces.interface import interact
from app.optical.surfaces.model import AIR, OPAQUE, Surface, SurfaceModel, unit_or_none

MAX_INTERACTIONS = 32


@dataclass(frozen=True)
class InternalSegment:
    ray: BeamRay       # state at the start of the segment
    end: Vec3
    medium: str


@dataclass(frozen=True)
class ApertureClip:
    """The Gaussian power fraction one surface aperture passes (``aperture.py``:
    the lens op's knife-edge for a circle, two exact slits for a rectangle).
    ``radius_mm`` is the circle's radius, or a rectangle's inscribed-circle
    radius (half its smaller side) — the number the BeamScope readout shows."""
    surface_id: str
    radius_mm: float
    w_eff_mm: float
    decenter_mm: float
    fraction: float


@dataclass
class ElementTrace:
    exits: list[BeamRay] = field(default_factory=list)   # rays leaving into air
    segments: list[InternalSegment] = field(default_factory=list)
    absorbed_mw: float = 0.0
    lost_mw: float = 0.0
    lost: list[str] = field(default_factory=list)
    # Aperture clipping, one entry per circle / rectangle surface met, in order.
    clips: list[ApertureClip] = field(default_factory=list)
    clipped_mw: float = 0.0


def propagate_in_medium(
    ray: BeamRay, t: float, model: SurfaceModel, medium_id: str, mode: Optional[str] = None,
) -> BeamRay:
    """Move the ray a geometric distance ``t`` through a medium, as the
    eigenmode ``mode`` (its own index n): reduced Q advances by ``t/n``, the
    path length by ``t``. A Faraday medium rotates the Jones vector by
    ``rotate_jones(−ρ·t·(k·b̂))``, the faraday op's handedness."""
    medium = model.medium(medium_id)
    n = medium.mode_index(mode, ray.direction, ray.wavelength_nm)
    step = t / n
    q = ray.q_matrix
    out = ray.with_q_matrix(QMatrix(q.xx + step, q.yy + step, q.xy)).replaced(
        origin=ray.origin + ray.direction * t,
        path_length_mm=ray.path_length_mm + t,
    )
    if medium.magnetic_axis is not None:
        theta = -medium.faraday_rad_per_mm * t * ray.direction.dot(medium.magnetic_axis)
        out = out.replaced(jones=rotate_jones(out.jones, theta))
    return out


def _phase(ray: BeamRay, t: float, model: SurfaceModel, medium_id: str, mode: Optional[str]) -> float:
    """Optical phase ``k₀·n·t`` gained over ``t`` — only compared between
    the o and e rays of one part, to recombine them."""
    n = model.medium(medium_id).mode_index(mode, ray.direction, ray.wavelength_nm)
    return 2.0 * math.pi * n * t / (ray.wavelength_nm * 1e-6)


def _merge_coherent(exits: list[tuple[BeamRay, float]]) -> list[BeamRay]:
    """Recombine rays that leave the part parallel (within 1e-12 in cos) and
    overlapping (lateral offset below 1e-3 of the beam radius) — the o and e
    rays of a waveplate. The Jones vectors add with their phase difference
    referred to one wavefront, so the retardance is exact at any tilt; the
    lowest-phase (fast) ray keeps its phase, as the waveplate op does. The
    power follows the summed Jones intensity; Q and the rest are the
    strongest ray's."""
    groups: list[list[tuple[BeamRay, float]]] = []
    for r, ph in sorted(exits, key=lambda e: -e[0].power_mw):
        for g in groups:
            ref = g[0][0]
            rel = r.origin - ref.origin
            lateral = (rel - ref.direction * rel.dot(ref.direction)).length()
            w = math.sqrt(gaussian_width_mm(ref.qx, ref.wavelength_nm)
                          * gaussian_width_mm(ref.qy, ref.wavelength_nm))
            if 1.0 - r.direction.dot(ref.direction) < 1e-12 and lateral < 1e-3 * w:
                g.append((r, ph))
                break
        else:
            groups.append([(r, ph)])
    merged = []
    for g in groups:
        ref = g[0][0]
        if len(g) == 1:
            merged.append(ref)
            continue
        k0 = 2.0 * math.pi / (ref.wavelength_nm * 1e-6)
        phases = [ph + k0 * (ref.origin - r.origin).dot(ref.direction) for r, ph in g]
        p0 = min(phases)
        js, jp = 0j, 0j
        for (r, _), ph in zip(g, phases):
            rot = complex(math.cos(ph - p0), math.sin(ph - p0))
            js += r.jones[0] * rot
            jp += r.jones[1] * rot
        i_ref = jones_intensity(ref.jones)
        power = ref.power_mw * jones_intensity((js, jp)) / i_ref if i_ref > 1e-30 else 0.0
        merged.append(ref.replaced(jones=(js, jp), power_mw=power))
    return merged


def _nearest(model: SurfaceModel, ray: BeamRay) -> tuple[Surface, SurfaceHit] | None:
    best = None
    for s in model.surfaces:
        h = intersect(s, ray.origin, ray.direction)
        if h is not None and (best is None or h.t < best[1].t):
            best = (s, h)
    return best


def _clip(surface: Surface, hit: SurfaceHit, ray: BeamRay) -> Optional[ApertureClip]:
    """Gaussian power through a circular or rectangular aperture, measured in
    the surface's tangent plane (u along axisY, v along axisZ). An ellipse
    clips the chief ray only (None here)."""
    if surface.aperture == "ellipse":
        return None
    wl = ray.wavelength_nm
    # Reduced Q + vacuum λ gives the physical width inside a medium too.
    w_eff = math.sqrt(gaussian_width_mm(ray.qx, wl) * gaussian_width_mm(ray.qy, wl))
    r_c = math.hypot(hit.u, hit.v)
    if surface.aperture == "circle":
        radius = surface.aperture_radius_mm
        frac = gaussian_circular_aperture_fraction(w_eff, radius, r_c)
    else:
        radius = 0.5 * min(surface.aperture_width_mm, surface.aperture_height_mm)
        frac = gaussian_rect_aperture_fraction(
            w_eff, surface.aperture_width_mm, surface.aperture_height_mm, hit.u, hit.v,
        )
    return ApertureClip(surface.id, radius, w_eff, r_c, frac)


def trace_element(model: SurfaceModel, ray: BeamRay) -> ElementTrace:
    """Trace ``ray`` (in air, body frame) through the part. A ray that meets
    no surface comes back unchanged in ``exits``.

    Aperture energy clipping: each path through the part is attenuated by
    its TIGHTEST circular aperture, not the product of all of them — the
    knife-edge model assumes a full Gaussian arriving, and behind the first
    aperture the wings are already gone, so multiplying would clip a lens'
    two faces twice.

    Uniaxial media split light into o and e rays (``interface``); the ones
    that leave parallel and overlapping are recombined coherently at the end
    (``_merge_coherent``)."""
    result = ElementTrace()
    # (ray, medium, inside?, tightest aperture fraction passed so far,
    #  eigenmode in a uniaxial medium, optical phase since entering the part)
    queue: list[tuple[BeamRay, str, bool, float, Optional[str], float]] = [
        (ray, AIR, False, 1.0, None, 0.0),
    ]
    exits: list[tuple[BeamRay, float]] = []
    interactions = 0
    while queue:
        r, medium, inside, passed, mode, phase = queue.pop(0)
        found = _nearest(model, r)
        if found is None:
            if medium == AIR:
                exits.append((r, phase))
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
        at_surface = propagate_in_medium(r, hit.t, model, medium, mode)
        phase += _phase(r, hit.t, model, medium, mode)
        clip = _clip(surface, hit, at_surface)
        if clip is not None:
            result.clips.append(clip)
            if clip.fraction < passed:
                kept = at_surface.power_mw * clip.fraction / passed
                result.clipped_mw += at_surface.power_mw - kept
                at_surface = at_surface.replaced(power_mw=kept)
                passed = clip.fraction
        outs, dropped = interact(at_surface, hit, surface, model, mode)
        result.lost.extend(dropped)
        for o in outs:
            if o.medium == OPAQUE:
                result.absorbed_mw += o.ray.power_mw
            else:
                queue.append((o.ray, o.medium, True, passed, o.mode, phase))
    result.exits = _merge_coherent(exits)
    return result


def effective_focal_length(model: SurfaceModel, ray: BeamRay, h: float = 1e-3) -> Optional[float]:
    """The part's EFL along this ray, ``−h/Δθ`` from exactly traced parallel
    neighbour rays offset by ``h`` along each transverse axis — the true EFL
    of a thick lens, not its back focal length. The geometric mean of the two
    axes (signed; negative = diverging). None when the part has no single
    exit for all three rays, the two axes disagree in sign, or either axis has
    no power (a plate; a cylindrical lens, whose unpowered axis is only
    rounding noise — a round POP Airy pattern is meaningless for it anyway)."""
    chief = trace_element(model, ray)
    if len(chief.exits) != 1:
        return None
    c = chief.exits[0].direction
    powers = []
    for axis in beam_local_sp(ray.direction):
        n = trace_element(model, ray.replaced(origin=ray.origin + axis * h))
        if len(n.exits) != 1:
            return None
        dd = n.exits[0].direction - c
        dd_perp = dd - c * c.dot(dd)
        ax_out = unit_or_none(axis - c * c.dot(axis))
        if ax_out is None:
            return None
        powers.append(-dd_perp.dot(ax_out) / h)
    p_s, p_t = powers
    if min(abs(p_s), abs(p_t)) < 1e-9 or p_s * p_t <= 0.0:   # |f| > 1e9 mm: no power
        return None
    return math.copysign(1.0 / math.sqrt(p_s * p_t), p_s)
