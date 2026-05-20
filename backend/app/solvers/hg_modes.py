"""Hermite-Gauss (HG) mode bank for non-Gaussian beam propagation.

Each HG_mn mode is an eigenmode of the paraxial wave equation and is
mode-preserving under linear ABCD: the same q-parameter evolution applies
to every (m, n) — only the Gouy phase scales with (m + n + 1)/2. So an
arbitrary slowly-varying beam profile decomposed onto HG_mn at one plane
can be propagated through any ABCD chain by reusing the q from
generalized_abcd, without running a single FFT.

This module provides:
  - hermite_h(n, x): Hermite polynomial values (physicists' convention)
  - hg_field_1d(m, x, w, R, lambda): a single HG_m mode in 1D
  - hg_field_2d(m, n, X, Y, q_x, q_y, lambda): 2D mode on a grid
  - decompose_field: numerical projection of a field onto HG_mn basis
  - reconstruct_field: inverse — synth a field from coefficients
  - tophat_field / super_gauss_field: canned non-Gaussian test profiles

Units: lengths in mm internally. q in mm (.real = z-from-waist, .imag = z_R).
Wavelength in nm. Convert at the boundary.
"""

from __future__ import annotations

import math

import numpy as np
import numpy.typing as npt


# ---------------------------------------------------------------------------
# Hermite polynomials (physicists' convention)
# ---------------------------------------------------------------------------


def hermite_h(n: int, x: npt.ArrayLike) -> np.ndarray:
    """Hermite polynomial H_n(x) by stable upward recurrence.

        H_{n+1}(x) = 2·x·H_n(x) − 2·n·H_{n−1}(x)
        H_0 = 1, H_1 = 2x.
    """
    if n < 0:
        raise ValueError("Hermite order must be non-negative")
    xa = np.asarray(x, dtype=np.float64)
    if n == 0:
        return np.ones_like(xa)
    if n == 1:
        return 2.0 * xa
    h_prev = np.ones_like(xa)
    h_curr = 2.0 * xa
    for k in range(1, n):
        h_next = 2.0 * xa * h_curr - 2.0 * k * h_prev
        h_prev, h_curr = h_curr, h_next
    return h_curr


# ---------------------------------------------------------------------------
# HG basis on a grid
# ---------------------------------------------------------------------------


def _w_from_q(q: complex, wavelength_nm: float) -> float:
    """Beam radius w(z) from q at current z (mm)."""
    z_r_mm = max(q.imag, 1e-12)
    lam_mm = wavelength_nm * 1e-6
    w0_mm = math.sqrt(z_r_mm * lam_mm / math.pi)
    return w0_mm * math.sqrt(1.0 + (q.real / z_r_mm) ** 2)


def _R_from_q(q: complex) -> float:
    """Wavefront radius R(z) from q. +inf at waist."""
    mag2 = q.real * q.real + q.imag * q.imag
    if mag2 < 1e-30:
        return math.inf
    inv_re = q.real / mag2
    if abs(inv_re) < 1e-30:
        return math.inf
    return 1.0 / inv_re


def _gouy_from_q(q: complex) -> float:
    """Gouy phase ψ(z) = arctan(z/z_R) for TEM00; HG_mn picks up (m+n+1)·ψ."""
    return math.atan2(q.real, max(q.imag, 1e-12))


def hg_field_1d(
    m: int,
    x_mm: npt.NDArray[np.float64],
    q: complex,
    wavelength_nm: float,
) -> npt.NDArray[np.complex128]:
    """Single Hermite-Gauss mode along 1D axis x_mm.

    Output is L²-normalised so that ∫|HG_m|² dx = 1 (numerical).
    Includes Gaussian envelope, wavefront-curvature phase, and the
    HG-mode Gouy phase contribution (m + 1/2)·ψ.
    """
    w = _w_from_q(q, wavelength_nm)
    R = _R_from_q(q)
    psi = _gouy_from_q(q)
    k = 2.0 * math.pi / (wavelength_nm * 1e-6)  # rad/mm

    norm = (2.0 ** m * math.factorial(m) * math.sqrt(math.pi / 2.0)) ** -0.5 / math.sqrt(w)
    h = hermite_h(m, math.sqrt(2.0) * x_mm / w)
    envelope = np.exp(-(x_mm ** 2) / (w * w))
    curvature_phase = np.exp(-1j * (k / (2.0 * R)) * x_mm ** 2) if math.isfinite(R) else np.ones_like(x_mm, dtype=np.complex128)
    mode_gouy = np.exp(1j * (m + 0.5) * psi)
    return norm * h * envelope * curvature_phase * mode_gouy


def hg_field_2d(
    m: int,
    n: int,
    X_mm: npt.NDArray[np.float64],
    Y_mm: npt.NDArray[np.float64],
    q_x: complex,
    q_y: complex,
    wavelength_nm: float,
) -> npt.NDArray[np.complex128]:
    """HG_mn mode on a 2D grid (X, Y meshgrid coordinates in mm).

    Constructed as the OUTER PRODUCT of two 1D modes:
        HG_mn(x, y) = HG_m(x; q_x) · HG_n(y; q_y) / shared_gouy_correction.

    Because each axis carries its own (m+0.5)·ψ_x and (n+0.5)·ψ_y, the
    combined mode picks up (m+0.5)·ψ_x + (n+0.5)·ψ_y of Gouy phase, which
    matches the standard astigmatic HG mode evolution.
    """
    x1d = X_mm[0, :] if X_mm.ndim == 2 else X_mm
    y1d = Y_mm[:, 0] if Y_mm.ndim == 2 else Y_mm
    hx = hg_field_1d(m, x1d, q_x, wavelength_nm)
    hy = hg_field_1d(n, y1d, q_y, wavelength_nm)
    return np.outer(hy, hx)


# ---------------------------------------------------------------------------
# Decomposition / reconstruction
# ---------------------------------------------------------------------------


def decompose_field(
    field: npt.NDArray[np.complex128],
    x_grid_mm: npt.NDArray[np.float64],
    y_grid_mm: npt.NDArray[np.float64],
    q_x: complex,
    q_y: complex,
    wavelength_nm: float,
    max_m: int,
    max_n: int,
) -> npt.NDArray[np.complex128]:
    """Project `field` (complex 2D) onto HG_mn basis (m=0..max_m, n=0..max_n).

    Returns a (max_m+1, max_n+1) complex coefficient matrix where
        coeffs[m, n] = ∫∫ field(x,y) · HG_mn*(x,y) dx dy   (numerical via Simpson).

    Caller is responsible for choosing a grid large enough that the field +
    enough HG modes fit; clipping artefacts are this method's main caveat.
    """
    x1d = x_grid_mm[0, :] if x_grid_mm.ndim == 2 else x_grid_mm
    y1d = y_grid_mm[:, 0] if y_grid_mm.ndim == 2 else y_grid_mm
    dx = float(x1d[1] - x1d[0])
    dy = float(y1d[1] - y1d[0])

    coeffs = np.zeros((max_m + 1, max_n + 1), dtype=np.complex128)
    for m in range(max_m + 1):
        hx = hg_field_1d(m, x1d, q_x, wavelength_nm)
        for n in range(max_n + 1):
            hy = hg_field_1d(n, y1d, q_y, wavelength_nm)
            basis = np.outer(hy, hx)
            coeffs[m, n] = np.sum(field * np.conj(basis)) * dx * dy
    return coeffs


def reconstruct_field(
    coeffs: npt.NDArray[np.complex128],
    x_grid_mm: npt.NDArray[np.float64],
    y_grid_mm: npt.NDArray[np.float64],
    q_x: complex,
    q_y: complex,
    wavelength_nm: float,
) -> npt.NDArray[np.complex128]:
    """Inverse of decompose_field: sum c_mn · HG_mn(x, y; q_x, q_y) over modes."""
    x1d = x_grid_mm[0, :] if x_grid_mm.ndim == 2 else x_grid_mm
    y1d = y_grid_mm[:, 0] if y_grid_mm.ndim == 2 else y_grid_mm
    max_m_plus_1, max_n_plus_1 = coeffs.shape
    field = np.zeros((y1d.size, x1d.size), dtype=np.complex128)
    for m in range(max_m_plus_1):
        hx = hg_field_1d(m, x1d, q_x, wavelength_nm)
        for n in range(max_n_plus_1):
            if abs(coeffs[m, n]) < 1e-30:
                continue
            hy = hg_field_1d(n, y1d, q_y, wavelength_nm)
            field += coeffs[m, n] * np.outer(hy, hx)
    return field


# ---------------------------------------------------------------------------
# Canned non-Gaussian profiles
# ---------------------------------------------------------------------------


def tophat_field(
    radius_mm: float,
    X_mm: npt.NDArray[np.float64],
    Y_mm: npt.NDArray[np.float64],
) -> npt.NDArray[np.complex128]:
    """Uniform-amplitude circular top-hat of radius `radius_mm`. Power = π·r²·1²."""
    R2 = X_mm ** 2 + Y_mm ** 2
    field = np.where(R2 <= radius_mm * radius_mm, 1.0, 0.0).astype(np.complex128)
    return field


def super_gauss_field(
    radius_mm: float,
    order: int,
    X_mm: npt.NDArray[np.float64],
    Y_mm: npt.NDArray[np.float64],
) -> npt.NDArray[np.complex128]:
    """Super-Gaussian: exp(-(r/r0)^(2·order)). order=1 is a regular Gaussian,
    larger orders approach a top-hat with smoother edges."""
    if order < 1:
        raise ValueError("super-Gaussian order must be >= 1")
    r_over_r0 = np.sqrt((X_mm ** 2 + Y_mm ** 2) / (radius_mm * radius_mm))
    return np.exp(-(r_over_r0 ** (2 * order))).astype(np.complex128)
