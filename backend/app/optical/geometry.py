"""Reflection / refraction helpers shared by reflect_specular,
glan_reject_s, pbs_reflect_s, dichroic_reflect, etc.

All helpers operate on unit vectors in body frame. See
asset-physics-model.md §3.3 for face normal conventions.
"""

from __future__ import annotations

import math

from app.optical.beam_ray import Vec3


def reflect(d_in: Vec3, n: Vec3) -> Vec3:
    """Mirror reflection: d_out = d_in - 2(d_in · n̂) n̂.

    ``n`` is the surface outward normal (any sign — formula is symmetric).
    Returns a unit vector if ``d_in`` was unit.
    """
    dot_dn = d_in.dot(n)
    return d_in - n * (2.0 * dot_dn)


def refract(d_in: Vec3, n_face: Vec3, n_from: float, n_to: float) -> Vec3:
    """Snell refraction across a planar interface.

    Args:
      d_in:    incoming unit direction (in medium `n_from`)
      n_face:  face outward normal (points back toward the incoming-medium
               side). Sign matters: must satisfy `d_in · n_face < 0` (beam
               hitting the face from the outside).
      n_from:  refractive index of incoming medium
      n_to:    refractive index of outgoing medium

    Returns the refracted unit direction in medium `n_to`. Raises
    ValueError on total internal reflection (caller must use ``reflect``
    explicitly instead).
    """
    cos_i = -d_in.dot(n_face)        # incidence angle from face normal
    if cos_i < 0:
        # Caller passed an outward-facing normal but beam goes outward
        # too — flip so the math below is well-defined.
        n_face = Vec3(-n_face.x, -n_face.y, -n_face.z)
        cos_i = -cos_i

    eta = n_from / n_to
    sin2_t = eta * eta * (1.0 - cos_i * cos_i)
    if sin2_t > 1.0:
        raise ValueError(
            f"total internal reflection (sin²θ_t={sin2_t:.4f} > 1) — "
            f"use reflect() instead at this interface"
        )
    cos_t = math.sqrt(1.0 - sin2_t)
    # d_out = eta * d_in + (eta * cos_i - cos_t) * n_face
    return d_in * eta + n_face * (eta * cos_i - cos_t)
