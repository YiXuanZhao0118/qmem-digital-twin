"""Generalized 5x5 ABCD propagation for misaligned optical systems.

Implements the augmented-matrix formalism specified by the user's Lens.docx
plus follow-up notes:

  - q-parameter (Gaussian beam) propagation via 2x2 ABCD sub-blocks
  - chief-ray (x_c, theta_xc, y_c, theta_yc) propagation via FULL 5x5 vector
    multiply, which naturally captures cross-axis coupling introduced by
    rotated cylindrical optics

5x5 state vector: (x, theta_x, y, theta_y, 1)^T
Units: lengths in mm, angles in rad, wavelength in nm.

NOTE on the (1 - 1/f) term inside thin-lens / cylindrical-lens 5th-column
corrections: the spec writes this expression literally; we implement it
with f in mm. If callers intended SI-meter normalisation, divide f
accordingly before constructing the operator.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt


# ---------------------------------------------------------------------------
# 5x5 operator constructors
# ---------------------------------------------------------------------------


def m_free_space(distance_mm: float) -> npt.NDArray[np.float64]:
    """Free-space propagation by `distance_mm`."""
    M = np.eye(5)
    M[0, 1] = distance_mm
    M[2, 3] = distance_mm
    return M


def m_thin_lens(
    focal_mm: float,
    *,
    delta_x_mm: float = 0.0,
    delta_y_mm: float = 0.0,
    alpha_x_rad: float = 0.0,
    alpha_y_rad: float = 0.0,
) -> npt.NDArray[np.float64]:
    """Thin spherical lens with decenter delta and tilt alpha.

        M[1,4] = delta_x/f + alpha_y * (1 - 1/f)
        M[3,4] = delta_y/f + alpha_x * (1 - 1/f)
    """
    if abs(focal_mm) < 1e-12:
        raise ValueError("focal length must be non-zero")
    inv_f = 1.0 / focal_mm
    one_minus_inv_f = 1.0 - inv_f

    M = np.eye(5)
    M[1, 0] = -inv_f
    M[3, 2] = -inv_f
    M[1, 4] = delta_x_mm * inv_f + alpha_y_rad * one_minus_inv_f
    M[3, 4] = delta_y_mm * inv_f + alpha_x_rad * one_minus_inv_f
    return M


def m_cylindrical_standard(
    focal_mm: float,
    *,
    axis: str = "x",
    thickness_mm: float = 0.0,
    refractive_index: float = 1.0,
    delta_x_mm: float = 0.0,
    delta_y_mm: float = 0.0,
    alpha_x_rad: float = 0.0,
    alpha_y_rad: float = 0.0,
) -> npt.NDArray[np.float64]:
    """Cylindrical lens focusing in one axis only.

    The focusing axis behaves like a thin lens. The non-focusing axis acts
    as a glass plate of thickness `thickness_mm` and index `refractive_index`
    (per spec: the cyl lens body has finite thickness and refractive index
    along its un-curved direction).

    `axis` selects the focusing axis ("x" or "y"). Default thickness=0,
    n=1.0 collapses the plate term to identity for back-compat.
    """
    if abs(focal_mm) < 1e-12:
        raise ValueError("focal length must be non-zero")
    if refractive_index <= 0:
        raise ValueError("refractive index must be positive")
    inv_f = 1.0 / focal_mm
    one_minus_inv_f = 1.0 - inv_f
    d_over_n = thickness_mm / refractive_index
    plate_shift = thickness_mm * (1.0 - 1.0 / refractive_index)

    M = np.eye(5)
    if axis == "x":
        # Focus in x
        M[1, 0] = -inv_f
        M[1, 4] = delta_x_mm * inv_f + alpha_y_rad * one_minus_inv_f
        # Glass plate in y
        M[2, 3] = d_over_n
        M[2, 4] = alpha_x_rad * plate_shift
    elif axis == "y":
        # Glass plate in x
        M[0, 1] = d_over_n
        M[0, 4] = alpha_y_rad * plate_shift
        # Focus in y
        M[3, 2] = -inv_f
        M[3, 4] = delta_y_mm * inv_f + alpha_x_rad * one_minus_inv_f
    else:
        raise ValueError(f"axis must be 'x' or 'y', got {axis!r}")
    return M


def m_rotation(theta_rad: float) -> npt.NDArray[np.float64]:
    """5x5 rotation about propagation axis (couples x<->y, theta_x<->theta_y)."""
    c, s = math.cos(theta_rad), math.sin(theta_rad)
    M = np.eye(5)
    M[0, 0] = c
    M[0, 2] = s
    M[1, 1] = c
    M[1, 3] = s
    M[2, 0] = -s
    M[2, 2] = c
    M[3, 1] = -s
    M[3, 3] = c
    return M


def m_cylindrical_rotated(
    focal_mm: float,
    theta_rot_rad: float,
    *,
    axis: str = "x",
    thickness_mm: float = 0.0,
    refractive_index: float = 1.0,
    delta_x_mm: float = 0.0,
    delta_y_mm: float = 0.0,
    alpha_x_rad: float = 0.0,
    alpha_y_rad: float = 0.0,
) -> npt.NDArray[np.float64]:
    """Cylindrical lens rotated by theta_rot around propagation axis.

        M_rotated = R(-theta) * M_standard * R(theta)
    """
    M_cyl = m_cylindrical_standard(
        focal_mm,
        axis=axis,
        thickness_mm=thickness_mm,
        refractive_index=refractive_index,
        delta_x_mm=delta_x_mm,
        delta_y_mm=delta_y_mm,
        alpha_x_rad=alpha_x_rad,
        alpha_y_rad=alpha_y_rad,
    )
    return m_rotation(-theta_rot_rad) @ M_cyl @ m_rotation(theta_rot_rad)


def m_flat_mirror(
    *,
    alpha_x_rad: float = 0.0,
    alpha_y_rad: float = 0.0,
) -> npt.NDArray[np.float64]:
    """Flat mirror with tilt alpha. No decenter term: translating the mirror
    does not deflect the reflected ray; only tilting it does."""
    M = np.eye(5)
    M[1, 1] = -1.0
    M[3, 3] = -1.0
    M[1, 4] = 2.0 * alpha_y_rad
    M[3, 4] = 2.0 * alpha_x_rad
    return M


def m_curved_mirror(
    radius_mm: float,
    *,
    delta_x_mm: float = 0.0,
    delta_y_mm: float = 0.0,
    alpha_x_rad: float = 0.0,
    alpha_y_rad: float = 0.0,
) -> npt.NDArray[np.float64]:
    """Curved mirror: f = R/2 (concave R>0, convex R<0). Combines flat-mirror
    reflection with thin-lens focusing."""
    if abs(radius_mm) < 1e-12:
        raise ValueError("radius of curvature must be non-zero")
    f_mm = radius_mm / 2.0
    inv_f = 1.0 / f_mm

    M = np.eye(5)
    M[1, 0] = -inv_f
    M[1, 1] = -1.0
    M[3, 2] = -inv_f
    M[3, 3] = -1.0
    M[1, 4] = delta_x_mm * inv_f + 2.0 * alpha_y_rad
    M[3, 4] = delta_y_mm * inv_f + 2.0 * alpha_x_rad
    return M


def m_glass_plate(
    thickness_mm: float,
    refractive_index: float,
    *,
    alpha_x_rad: float = 0.0,
    alpha_y_rad: float = 0.0,
) -> npt.NDArray[np.float64]:
    """Snell-reduced glass plate. Covers windows, AR-coated slabs, the
    transmitted arm of a PBS, the body of a waveplate, isolator transmission."""
    if refractive_index <= 0:
        raise ValueError("refractive index must be positive")
    d_over_n = thickness_mm / refractive_index
    plate_shift = thickness_mm * (1.0 - 1.0 / refractive_index)

    M = np.eye(5)
    M[0, 1] = d_over_n
    M[2, 3] = d_over_n
    M[0, 4] = alpha_y_rad * plate_shift
    M[2, 4] = alpha_x_rad * plate_shift
    return M


def m_pbs_reflected(
    *,
    alpha_x_rad: float = 0.0,
    alpha_y_rad: float = 0.0,
) -> npt.NDArray[np.float64]:
    """PBS reflected arm (s-polarisation). Same as flat mirror per spec."""
    return m_flat_mirror(alpha_x_rad=alpha_x_rad, alpha_y_rad=alpha_y_rad)


def m_pbs_transmitted(
    cube_size_mm: float,
    refractive_index: float,
    *,
    alpha_x_rad: float = 0.0,
    alpha_y_rad: float = 0.0,
) -> npt.NDArray[np.float64]:
    """PBS transmitted arm (p-polarisation). Equivalent to a glass plate of
    thickness D (cube edge length)."""
    return m_glass_plate(
        cube_size_mm,
        refractive_index,
        alpha_x_rad=alpha_x_rad,
        alpha_y_rad=alpha_y_rad,
    )


def compose(*matrices: npt.NDArray[np.float64]) -> npt.NDArray[np.float64]:
    """Cascade operators in BEAM ORDER (first encountered first).

    compose(M_lens, M_space) returns M_space @ M_lens — the standard
    right-to-left convention.
    """
    result = np.eye(5)
    for M in matrices:
        result = M @ result
    return result


# ---------------------------------------------------------------------------
# Beam state
# ---------------------------------------------------------------------------


@dataclass
class BeamMisaligned:
    """Generalized Gaussian beam with chief-ray drift and tilt.

    Per-axis q-parameters (q.real is z-from-waist in mm, q.imag is z_R in mm)
    plus chief-ray state (x_c, y_c in mm; theta_xc, theta_yc in rad).
    """

    q_x: complex
    q_y: complex
    x_c_mm: float = 0.0
    y_c_mm: float = 0.0
    theta_xc_rad: float = 0.0
    theta_yc_rad: float = 0.0
    wavelength_nm: float = 780.241


# ---------------------------------------------------------------------------
# q-parameter constructors & derived quantities
# ---------------------------------------------------------------------------


def q_from_waist(
    waist_um: float,
    waist_z_offset_mm: float,
    wavelength_nm: float,
    m_squared: float = 1.0,
) -> complex:
    """Build q at z=0 given waist at z = waist_z_offset_mm.

        z_R = pi * w0^2 / (M^2 * lambda)
        q   = (z - z_w) + i * z_R
    """
    w0_mm = waist_um * 1e-3
    lam_mm = wavelength_nm * 1e-6
    z_R_mm = math.pi * w0_mm * w0_mm / (max(m_squared, 1e-9) * lam_mm)
    return complex(-waist_z_offset_mm, z_R_mm)


def waist_um_from_q(
    q: complex,
    wavelength_nm: float,
    m_squared: float = 1.0,
) -> float:
    """Beam-waist radius w0 (um)."""
    z_R_mm = max(q.imag, 1e-12)
    lam_mm = wavelength_nm * 1e-6
    w0_mm = math.sqrt(z_R_mm * lam_mm * max(m_squared, 1e-9) / math.pi)
    return w0_mm * 1000.0


def spot_radius_um(
    q: complex,
    wavelength_nm: float,
    m_squared: float = 1.0,
) -> float:
    """Beam radius w(z) at q's current z position (um).

        w(z) = sqrt(-lambda / (pi * Im(1/q)))   per spec.
    """
    mag2 = q.real * q.real + q.imag * q.imag
    if mag2 < 1e-30:
        return 0.0
    inv_q_im = -q.imag / mag2
    lam_mm = wavelength_nm * 1e-6
    if abs(inv_q_im) < 1e-30:
        return math.inf
    w_mm = math.sqrt(-lam_mm / (math.pi * inv_q_im) * max(m_squared, 1e-9))
    return w_mm * 1000.0


def radius_of_curvature_mm(q: complex) -> float:
    """Wavefront radius R(z) = 1 / Re(1/q). +inf at the waist."""
    mag2 = q.real * q.real + q.imag * q.imag
    if mag2 < 1e-30:
        return math.inf
    inv_q_re = q.real / mag2
    if abs(inv_q_re) < 1e-30:
        return math.inf
    return 1.0 / inv_q_re


# ---------------------------------------------------------------------------
# Generalized ABCD propagation
# ---------------------------------------------------------------------------


def apply_operator(beam: BeamMisaligned, M: npt.NDArray[np.float64]) -> BeamMisaligned:
    """Propagate a BeamMisaligned through a 5x5 augmented ABCD operator.

    Two parallel updates per spec:

      1. q-ABCD law (wavefront curvature + spot size):
           q_x_out = (A_x * q_x + B_x) / (C_x * q_x + D_x)   using x-block
           q_y_out = (A_y * q_y + B_y) / (C_y * q_y + D_y)   using y-block

      2. Chief-ray 5x5 vector multiply (center + tilt):
           v_out = M * v_in  where v = [x_c, theta_xc, y_c, theta_yc, 1]^T
           — the FULL 5x5 multiply handles cross-axis coupling that arises
           from rotated cylindrical optics.

    Cross-axis coupling on the q-parameter (when off-diagonal A_x, B_x, ...
    are nonzero) is NOT modelled here. The per-axis scalar-q split is exact
    for x/y-decoupled operators and approximate for rotated cylindrical
    optics unless the input beam is rotationally symmetric (q_x = q_y).
    """
    if M.shape != (5, 5):
        raise ValueError(f"operator must be 5x5, got {M.shape}")

    A_x, B_x = M[0, 0], M[0, 1]
    C_x, D_x = M[1, 0], M[1, 1]
    A_y, B_y = M[2, 2], M[2, 3]
    C_y, D_y = M[3, 2], M[3, 3]

    denom_x = C_x * beam.q_x + D_x
    denom_y = C_y * beam.q_y + D_y
    if abs(denom_x) < 1e-30 or abs(denom_y) < 1e-30:
        raise ValueError("ABCD denominator vanished — degenerate operator/beam")
    q_x_out = (A_x * beam.q_x + B_x) / denom_x
    q_y_out = (A_y * beam.q_y + B_y) / denom_y

    v_in = np.array(
        [
            beam.x_c_mm,
            beam.theta_xc_rad,
            beam.y_c_mm,
            beam.theta_yc_rad,
            1.0,
        ],
        dtype=np.float64,
    )
    v_out = M @ v_in

    return BeamMisaligned(
        q_x=q_x_out,
        q_y=q_y_out,
        x_c_mm=float(v_out[0]),
        theta_xc_rad=float(v_out[1]),
        y_c_mm=float(v_out[2]),
        theta_yc_rad=float(v_out[3]),
        wavelength_nm=beam.wavelength_nm,
    )
