"""What one surface does to a beam: direction, Q, Jones and power.

Frames: the incoming ray carries Q and Jones in the canonical beam frame of
its direction (``jones.beam_local_sp``). At the surface both are re-expressed
in the plane-of-incidence frame ``(e_s, p)`` with ``e_s = d × N`` (or the
canonical s at normal incidence) and ``p = d × e_s``, the surface acts, and
the result is re-expressed in the canonical frame of the outgoing direction.

Q is carried REDUCED (``Q̂ = Q/n``, air-equivalent) so every readout keeps the
vacuum wavelength. With ``A = diag(1, e_t·p)`` mapping tangent-plane
coordinates onto the beam's transverse ones, phase matching on the surface
gives ``A₂·Q̂₂⁻¹·A₂ = A₁·Q̂₁⁻¹·A₁ − Δ·K`` with
``Δ = n_out·(N·d_out) − n_in·(N·d_in)`` (N oriented along the propagation);
refraction and reflection are the same law. See docs/surface-optics.md.

Jones phases follow the existing waveplate op (the slower eigen-axis gains
``e^{+iδ}``), so total internal reflection uses ``cosθₜ = +i·√(sin²θₜ − 1)``.
Power is ``power_mw`` scaled by the Jones intensity ratio, as every anchor op
does; the Jones vector is not renormalised.
"""

from __future__ import annotations

import cmath
import math
from dataclasses import dataclass

from app.optical.beam_ray import BeamRay, Mat2, QMatrix
from app.optical.jones import beam_local_sp, jones_intensity, jones_rotation_angle, rotate_jones
from app.optical.surfaces.geometry import SurfaceHit
from app.optical.surfaces.model import OPAQUE, Surface, SurfaceModel, cross, unit_or_none


@dataclass(frozen=True)
class Outgoing:
    ray: BeamRay
    medium: str        # the medium the ray is now in (OPAQUE = absorbed)


def refractive_index(model: SurfaceModel, medium_id: str, wavelength_nm: float) -> float:
    """The index the chief ray refracts with. v1 uses n_o for a uniaxial
    medium; the o/e difference enters as Jones retardance in the medium."""
    return model.medium(medium_id).indices(wavelength_nm)[0]


def fresnel(n1: float, n2: float, cos_i: float, cos_t: complex) -> tuple[complex, complex, complex, complex]:
    """``(r_s, r_p, τ_s, τ_p)``. ``τ`` is the transmitted amplitude scaled so
    ``|τ|²`` is the power transmittance. ``r_p`` is for ``p = d × e_s`` on both
    sides, hence ``r_p = −r_s`` at normal incidence."""
    r_s = (n1 * cos_i - n2 * cos_t) / (n1 * cos_i + n2 * cos_t)
    r_p = (n2 * cos_i - n1 * cos_t) / (n2 * cos_i + n1 * cos_t)
    scale = cmath.sqrt(n2 * cos_t / (n1 * cos_i))
    t_s = 2.0 * n1 * cos_i / (n1 * cos_i + n2 * cos_t)
    t_p = 2.0 * n1 * cos_i / (n2 * cos_i + n1 * cos_t)
    return r_s, r_p, scale * t_s, scale * t_p


def _form(k: tuple[float, float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    k11, k22, k12 = k
    return a[0] * (k11 * b[0] + k12 * b[1]) + a[1] * (k12 * b[0] + k22 * b[1])


def interact(
    ray: BeamRay, hit: SurfaceHit, surface: Surface, model: SurfaceModel,
) -> tuple[list[Outgoing], list[str]]:
    """Apply one surface. Returns the outgoing rays (0–2) and the reasons for
    any branch that had to be dropped. The reflected fraction at a
    transmissive surface is not traced (no multiple reflections in v1)."""
    d = ray.direction
    dn = d.dot(hit.normal)
    forward = dn > 0.0
    n_i = hit.normal if forward else hit.normal * -1.0
    k = hit.k if forward else (-hit.k[0], -hit.k[1], -hit.k[2])
    m_in, m_out = (surface.back, surface.front) if forward else (surface.front, surface.back)
    cos_i = abs(dn)
    wl = ray.wavelength_nm
    n1 = refractive_index(model, m_in, wl)

    s_canon, _ = beam_local_sp(d)
    e_s = unit_or_none(cross(d, n_i)) or s_canon
    e_t = cross(n_i, e_s)
    phi_in = jones_rotation_angle(s_canon, e_s, d)
    ray_f = ray.rotated_frame(phi_in)
    jones_f = rotate_jones(ray.jones, phi_in)

    # Transmitted direction (None = total internal reflection).
    d_t = None
    n2 = n1
    cos_t: complex = 0j
    if m_out != OPAQUE:
        n2 = refractive_index(model, m_out, wl)
        mu = n1 / n2
        sin2_t = mu * mu * (1.0 - cos_i * cos_i)
        if sin2_t <= 1.0:
            cos_t = math.sqrt(1.0 - sin2_t)
            d_t = (d * mu + n_i * (cos_t.real - mu * cos_i)).normalized()
        else:
            cos_t = 1j * math.sqrt(sin2_t - 1.0)

    # Branches: (reflected?, amplitude_s, amplitude_p) in the (e_s, p) frame.
    R = surface.reflectance
    c = surface.coating
    if m_out != OPAQUE and d_t is None and c != "hr":
        r_s, r_p, _, _ = fresnel(n1, n2, cos_i, cos_t)
        branches = [(True, r_s, r_p)]
    elif c == "hr":
        branches = [(True, -math.sqrt(R), math.sqrt(R))]
    elif c == "partial":
        branches = [(True, -math.sqrt(R), math.sqrt(R)),
                    (False, math.sqrt(1.0 - R), math.sqrt(1.0 - R))]
    elif c == "polarizing":
        # Local import: anchor_ops imports the anchor tracer, which imports this.
        from app.optical.anchor_ops.pbs import _extinction_atten

        att_p = _extinction_atten(surface.extinction_pp_db)
        att_s = _extinction_atten(surface.extinction_sp_db)
        branches = [(False, math.sqrt(att_p), math.sqrt(1.0 - att_s)),
                    (True, -math.sqrt(1.0 - att_p), math.sqrt(att_s))]
    elif c == "ar":
        branches = [(False, math.sqrt(1.0 - R), math.sqrt(1.0 - R))]
    elif m_out == OPAQUE:
        branches = [(False, 1.0, 1.0)]
    else:
        _, _, t_s, t_p = fresnel(n1, n2, cos_i, cos_t)
        branches = [(False, t_s, t_p)]

    i_in = jones_intensity(jones_f)
    outs: list[Outgoing] = []
    dropped: list[str] = []
    for reflected, a_s, a_p in branches:
        jones_out = (a_s * jones_f[0], a_p * jones_f[1])
        power = ray.power_mw * (jones_intensity(jones_out) / i_in if i_in > 1e-30 else 0.0)
        if power <= 0.0:     # e.g. the empty port of an ideal polarizing split
            continue
        if not reflected and m_out == OPAQUE:
            outs.append(Outgoing(ray.replaced(origin=hit.point, power_mw=power), OPAQUE))
            continue
        if reflected:
            d2, n_out, medium = (d - n_i * (2.0 * cos_i)).normalized(), n1, m_in
        else:
            d2, n_out, medium = d_t, n2, m_out
        a1 = e_t.dot(cross(d, e_s))
        a2 = e_t.dot(cross(d2, e_s))
        if abs(a2) < 1e-9:
            dropped.append(f"surface {surface.id!r}: grazing exit")
            continue
        delta = n_out * n_i.dot(d2) - n1 * cos_i
        es = (e_s.dot(hit.e1), e_s.dot(hit.e2))
        et = (e_t.dot(hit.e1), e_t.dot(hit.e2))
        k_ss, k_tt, k_st = _form(k, es, es), _form(k, et, et), _form(k, es, et)
        qi = ray_f.q_matrix.as_mat2().inverse()
        m = Mat2(
            qi.xx - delta * k_ss,
            a1 * qi.xy - delta * k_st,
            a1 * qi.yx - delta * k_st,
            a1 * a1 * qi.yy - delta * k_tt,
        )
        q2 = QMatrix.from_mat2(Mat2(m.xx, m.xy / a2, m.yx / a2, m.yy / (a2 * a2)).inverse())
        s_out, _ = beam_local_sp(d2)
        phi_out = jones_rotation_angle(e_s, s_out, d2)
        out = ray_f.with_q_matrix(q2).replaced(
            origin=hit.point, direction=d2, power_mw=power,
        ).rotated_frame(phi_out)
        outs.append(Outgoing(out.replaced(jones=rotate_jones(jones_out, phi_out)), medium))
    return outs, dropped
