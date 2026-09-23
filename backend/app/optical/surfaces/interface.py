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

Uniaxial media: a ray inside one is an EIGENMODE, "o" or "e", with its own
index (n_o, or n_e(θ) of its own direction). Light going into a uniaxial
medium — transmitted or reflected — splits into an o and an e ray, each
refracted with its own index (the e index depends on the direction it
refracts to, so it is solved iteratively) and carrying the projection of the
field onto its own polarization. ``trace.trace_element`` recombines the o and
e rays that leave parallel and overlapping (a waveplate).

Jones phases follow the existing waveplate op (the slower eigen-axis gains
``e^{+iδ}``), so total internal reflection uses ``cosθₜ = +i·√(sin²θₜ − 1)``.
A high reflector reflects with ``(+√R, −√R)``, the mirror op's convention
(the perfect-conductor Fresnel limit up to a global phase). Power is
``power_mw`` scaled by the Jones intensity ratio, as every anchor op does;
the Jones vector is not renormalised.
"""

from __future__ import annotations

import cmath
import math
from dataclasses import dataclass
from typing import Optional

from app.optical.beam_ray import BeamRay, Mat2, QMatrix, Vec3
from app.optical.jones import beam_local_sp, jones_intensity, jones_rotation_angle, rotate_jones
from app.optical.surfaces.geometry import SurfaceHit
from app.optical.surfaces.model import OPAQUE, Medium, Surface, SurfaceModel, cross, unit_or_none

# A split-off eigenmode carrying less than this fraction of the incident
# power is dropped (a waveplate lit exactly along one axis, cross-talk of a
# crossed compound plate).
MODE_POWER_FLOOR = 1e-20


@dataclass(frozen=True)
class Outgoing:
    ray: BeamRay
    medium: str               # the medium the ray is now in (OPAQUE = absorbed)
    mode: Optional[str] = None    # "o" / "e" inside a uniaxial medium


@dataclass(frozen=True)
class _Mode:
    mode: Optional[str]
    direction: Vec3
    n: float
    cos: complex              # cos of the angle to the normal (for Fresnel)
    pol: Optional[Vec3]       # eigen-polarization; None = keep the whole field


def refractive_index(model: SurfaceModel, medium_id: str, wavelength_nm: float) -> float:
    """n, or n_o for a uniaxial medium."""
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


def _direction(d: Vec3, n_i: Vec3, cos_i: float, mu: float, reflected: bool
               ) -> tuple[Optional[Vec3], complex]:
    """Outgoing direction for index ratio ``mu = n_in/n_out``, on the far
    side (refraction) or the near side (reflection; mu ≠ 1 = mode
    conversion). The tangential wave vector is conserved. None past the
    critical angle, with ``cos = +i·√(sin² − 1)``."""
    sin2 = mu * mu * (1.0 - cos_i * cos_i)
    if sin2 > 1.0:
        return None, 1j * math.sqrt(sin2 - 1.0)
    cos_o = math.sqrt(1.0 - sin2)
    tang = (d - n_i * cos_i) * mu
    return (tang + n_i * (-cos_o if reflected else cos_o)).normalized(), cos_o


def _modes(medium: Medium, d: Vec3, n_i: Vec3, cos_i: float, n1: float, wl: float,
           reflected: bool) -> list[_Mode]:
    """The eigenmodes light excites going into ``medium``: one for an
    isotropic medium, o and e for a uniaxial one (just o along its optic
    axis, where the two coincide). A mode past its critical angle is left out."""
    n_o, n_e = medium.indices(wl)
    d_o, c_o = _direction(d, n_i, cos_i, n1 / n_o, reflected)
    if n_e is None:
        return [_Mode(None, d_o, n_o, c_o, None)] if d_o is not None else []
    axis = medium.optic_axis
    out: list[_Mode] = []
    if d_o is not None:
        pol_o = unit_or_none(cross(d_o, axis))
        if pol_o is None:                   # along the optic axis: no birefringence
            return [_Mode("o", d_o, n_o, c_o, None)]
        out.append(_Mode("o", d_o, n_o, c_o, pol_o))
    n = n_o
    d_e, c_e = None, 0j
    for _ in range(60):
        d_e, c_e = _direction(d, n_i, cos_i, n1 / n, reflected)
        if d_e is None:
            break
        n_new = medium.mode_index("e", d_e, wl)
        converged = abs(n_new - n) < 1e-15
        n = n_new
        if converged:
            break
    if d_e is not None:
        perp = unit_or_none(cross(d_e, axis))
        if perp is not None:
            out.append(_Mode("e", d_e, n, c_e, cross(d_e, perp)))
    return out


def interact(
    ray: BeamRay, hit: SurfaceHit, surface: Surface, model: SurfaceModel,
    mode_in: Optional[str] = None,
) -> tuple[list[Outgoing], list[str]]:
    """Apply one surface to a ray arriving in eigenmode ``mode_in``. Returns
    the outgoing rays and the reasons for any branch that had to be dropped.
    The reflected fraction at a transmissive surface is not traced (no
    multiple reflections in v1)."""
    d = ray.direction
    dn = d.dot(hit.normal)
    forward = dn > 0.0
    n_i = hit.normal if forward else hit.normal * -1.0
    k = hit.k if forward else (-hit.k[0], -hit.k[1], -hit.k[2])
    m_in, m_out = (surface.back, surface.front) if forward else (surface.front, surface.back)
    cos_i = abs(dn)
    wl = ray.wavelength_nm
    n1 = model.medium(m_in).mode_index(mode_in, d, wl)

    s_canon, _ = beam_local_sp(d)
    e_s = unit_or_none(cross(d, n_i)) or s_canon
    e_t = cross(n_i, e_s)
    phi_in = jones_rotation_angle(s_canon, e_s, d)
    ray_f = ray.rotated_frame(phi_in)
    jones_f = rotate_jones(ray.jones, phi_in)

    transmit = [] if m_out == OPAQUE else _modes(model.medium(m_out), d, n_i, cos_i, n1, wl, False)
    tir = m_out != OPAQUE and not transmit

    def reflect(a_s: complex, a_p: complex) -> tuple:
        return (a_s, a_p, _modes(model.medium(m_in), d, n_i, cos_i, n1, wl, True), m_in)

    def through(a_s: complex, a_p: complex) -> tuple:
        return (a_s, a_p, transmit, m_out)

    # Channels: (a_s, a_p, modes, medium). Uncoated transmission is Fresnel
    # per mode (its own index), so it is resolved in the loop below.
    R = surface.reflectance
    c = surface.coating
    fresnel_t = False
    if tir and c != "hr":
        n2 = refractive_index(model, m_out, wl)
        sin2 = (n1 / n2) ** 2 * (1.0 - cos_i * cos_i)
        r_s, r_p, _, _ = fresnel(n1, n2, cos_i, 1j * math.sqrt(sin2 - 1.0))
        channels = [reflect(r_s, r_p)]
    elif c == "hr":
        channels = [reflect(math.sqrt(R), -math.sqrt(R))]
    elif c == "partial":
        channels = [reflect(math.sqrt(R), -math.sqrt(R)),
                    through(math.sqrt(1.0 - R), math.sqrt(1.0 - R))]
    elif c == "polarizing":
        # Local import: anchor_ops imports the anchor tracer, which imports this.
        from app.optical.anchor_ops.pbs import _extinction_atten

        att_p = _extinction_atten(surface.extinction_pp_db)
        att_s = _extinction_atten(surface.extinction_sp_db)
        channels = [through(math.sqrt(att_p), math.sqrt(1.0 - att_s)),
                    reflect(math.sqrt(1.0 - att_p), -math.sqrt(att_s))]
    elif c == "ar":
        channels = [through(math.sqrt(1.0 - R), math.sqrt(1.0 - R))]
    elif m_out == OPAQUE:
        channels = []
    else:
        channels = [through(None, None)]
        fresnel_t = True

    i_in = jones_intensity(jones_f)
    outs: list[Outgoing] = []
    dropped: list[str] = []
    if m_out == OPAQUE and c in ("uncoated", "ar", "hr", "partial"):
        # What the coating lets through is absorbed by the opaque body.
        kept = 1.0 - R if c in ("ar", "hr", "partial") else 1.0
        outs.append(Outgoing(ray.replaced(origin=hit.point, power_mw=ray.power_mw * kept), OPAQUE))
    for a_s, a_p, modes, medium in channels:
        for m in modes:
            if fresnel_t:
                _, _, a_s, a_p = fresnel(n1, m.n, cos_i, m.cos)
            d2 = m.direction
            p_out = cross(d2, e_s)
            jones_out = (a_s * jones_f[0], a_p * jones_f[1])
            if m.pol is not None:
                # Project the field onto this eigenmode's polarization.
                amp = (jones_out[0] * m.pol.dot(e_s) + jones_out[1] * m.pol.dot(p_out))
                jones_out = (amp * m.pol.dot(e_s), amp * m.pol.dot(p_out))
            frac = jones_intensity(jones_out) / i_in if i_in > 1e-30 else 0.0
            if frac <= MODE_POWER_FLOOR:
                continue
            a1 = e_t.dot(cross(d, e_s))
            a2 = e_t.dot(p_out)
            if abs(a2) < 1e-9:
                dropped.append(f"surface {surface.id!r}: grazing exit")
                continue
            delta = m.n * n_i.dot(d2) - n1 * cos_i
            es = (e_s.dot(hit.e1), e_s.dot(hit.e2))
            et = (e_t.dot(hit.e1), e_t.dot(hit.e2))
            k_ss, k_tt, k_st = _form(k, es, es), _form(k, et, et), _form(k, es, et)
            qi = ray_f.q_matrix.as_mat2().inverse()
            mq = Mat2(
                qi.xx - delta * k_ss,
                a1 * qi.xy - delta * k_st,
                a1 * qi.yx - delta * k_st,
                a1 * a1 * qi.yy - delta * k_tt,
            )
            q2 = QMatrix.from_mat2(Mat2(mq.xx, mq.xy / a2, mq.yx / a2, mq.yy / (a2 * a2)).inverse())
            s_out, _ = beam_local_sp(d2)
            phi_out = jones_rotation_angle(e_s, s_out, d2)
            out = ray_f.with_q_matrix(q2).replaced(
                origin=hit.point, direction=d2, power_mw=ray.power_mw * frac,
            ).rotated_frame(phi_out)
            outs.append(Outgoing(out.replaced(jones=rotate_jones(jones_out, phi_out)), medium, m.mode))
    return outs, dropped
