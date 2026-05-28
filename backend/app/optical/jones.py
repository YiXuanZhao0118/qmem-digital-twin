"""Jones vector helpers — Python mirror of frontend/src/optical/jones.ts.

Convention:
  Jones = (E_s, E_p) in beam-local s/p frame where:
    +z_beam = beam.direction
    +s_beam = projection of GLOBAL_UP onto plane perpendicular to z_beam
    +p_beam = z_beam × s_beam     (right-handed)

NOTE (parity / 2026-05-28): the frontend mirror
(frontend/src/optical/jones.ts) was re-anchored so +s_beam = up × z_beam
(in-table horizontal ⇒ 0° = horizontal) to fix the optical-link Pol angle
display. This backend copy still uses the vertical-anchored s, so the two
now DIVERGE by 90° in the absolute polarization-angle reference. Matching
the backend is a deliberate follow-up — note tests/optical/
test_solver_v3_isolator.py already fails forward-pass at 0.5 power
(pre-existing frontend↔backend tracer divergence in how element
body-rotations compose with the s-frame), so backend parity must fix that
too, not just copy the one-line re-anchor.

Reflection / refraction change beam direction → s/p basis must be
rotated to express the same physical polarization in the new frame.
"""

from __future__ import annotations

import math

from .beam_ray import Vec3


GLOBAL_UP = Vec3(0.0, 0.0, 1.0)
FALLBACK_UP = Vec3(1.0, 0.0, 0.0)


def beam_local_sp(direction: Vec3) -> tuple[Vec3, Vec3]:
    """Return (s, p) unit vectors for beam_local frame given direction."""
    d = direction.normalized()
    dot_up = d.dot(GLOBAL_UP)
    up = FALLBACK_UP if abs(dot_up) > 0.999 else GLOBAL_UP
    # s = up - (up·d)·d, normalized
    s_unnorm = up - d * up.dot(d)
    s = s_unnorm.normalized()
    # p = d × s
    p = Vec3(
        d.y * s.z - d.z * s.y,
        d.z * s.x - d.x * s.z,
        d.x * s.y - d.y * s.x,
    )
    return s, p


def rotate_jones(
    jones: tuple[complex, complex], phi_rad: float
) -> tuple[complex, complex]:
    """Rotate Jones from old s/p basis into new (rotated by phi_rad about
    +direction). Matrix form:
        [E_s']   [ c   s] [E_s]
        [E_p'] = [-s   c] [E_p]
    """
    c = math.cos(phi_rad)
    s = math.sin(phi_rad)
    e_s, e_p = jones
    e_s_new = c * e_s + s * e_p
    e_p_new = -s * e_s + c * e_p
    return (e_s_new, e_p_new)


def jones_rotation_angle(s_old: Vec3, s_new: Vec3, direction: Vec3) -> float:
    """Signed angle from s_old to s_new about +direction."""
    cos_phi = s_old.dot(s_new)
    cross = Vec3(
        s_old.y * s_new.z - s_old.z * s_new.y,
        s_old.z * s_new.x - s_old.x * s_new.z,
        s_old.x * s_new.y - s_old.y * s_new.x,
    )
    sin_phi = cross.dot(direction)
    return math.atan2(sin_phi, cos_phi)


def rotate_jones_into_new_frame(
    jones: tuple[complex, complex],
    old_direction: Vec3,
    new_direction: Vec3,
) -> tuple[complex, complex]:
    s_old, _ = beam_local_sp(old_direction)
    s_new, _ = beam_local_sp(new_direction)
    phi = jones_rotation_angle(s_old, s_new, new_direction)
    return rotate_jones(jones, phi)


def jones_intensity(jones: tuple[complex, complex]) -> float:
    e_s, e_p = jones
    return (e_s.real * e_s.real + e_s.imag * e_s.imag
            + e_p.real * e_p.real + e_p.imag * e_p.imag)


# ---------------------------------------------------------------------------
# Lab ↔ body Jones basis transformation (Phase 4c).
# ---------------------------------------------------------------------------

from typing import Callable  # noqa: E402  (placed here to keep imports tight)


def jones_lab_to_body(
    jones: tuple[complex, complex],
    dir_lab: Vec3,
    dir_body: Vec3,
    dir_to_body: Callable[[Vec3], Vec3],
) -> tuple[complex, complex]:
    s_lab, _ = beam_local_sp(dir_lab)
    s_body, _ = beam_local_sp(dir_body)
    s_lab_in_body = dir_to_body(s_lab)
    phi = jones_rotation_angle(s_lab_in_body, s_body, dir_body)
    return rotate_jones(jones, phi)


def jones_body_to_lab(
    jones: tuple[complex, complex],
    dir_body: Vec3,
    dir_lab: Vec3,
    dir_to_lab: Callable[[Vec3], Vec3],
) -> tuple[complex, complex]:
    s_lab, _ = beam_local_sp(dir_lab)
    s_body, _ = beam_local_sp(dir_body)
    s_body_in_lab = dir_to_lab(s_body)
    phi = jones_rotation_angle(s_body_in_lab, s_lab, dir_lab)
    return rotate_jones(jones, phi)
