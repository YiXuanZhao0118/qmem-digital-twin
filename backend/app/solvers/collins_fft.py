"""Generalized 5x5 Collins-Wolf diffraction integral via FFT — the
'precision mode' (Tier 3) propagator.

When a beam profile is genuinely non-Gaussian (top-hat, super-Gauss, lab
camera image) AND we care about hard-edge truncation or full Fresnel
diffraction, the parametric (q-only) Tier 1 and HG-bank Tier 2 stop being
sufficient. The Collins integral evolves the full complex field E(x, y)
through ANY 5x5 augmented ABCD matrix in two FFTs plus three phase
multiplications.

Usage pattern:
    1. Build the system matrix M_total by composing per-element 5x5 ops
       (free-space, lens, mirror, plate) from app.solvers.generalized_abcd.
    2. Apply aperture masks IN BETWEEN elements (one mask per truncating
       optic). Cascaded masks force the algorithm to break the chain into
       segments — each segment uses its own composed M.
    3. Call collins_5x5_fft(E, x, y, M, lam) per segment.

Units: lengths in mm, wavelength in nm.

References: Yura & Hanson 1987; Siegman §20.4 + §17.5; the user-supplied
spec doc (see generalized_abcd.py docstring).
"""

from __future__ import annotations

import numpy as np
import numpy.typing as npt


B_DEGENERATE_THRESHOLD_MM = 1e-9


def collins_5x5_fft(
    field: npt.NDArray[np.complex128],
    x_grid_mm: npt.NDArray[np.float64],
    y_grid_mm: npt.NDArray[np.float64],
    M: npt.NDArray[np.float64],
    wavelength_nm: float,
) -> tuple[npt.NDArray[np.complex128], npt.NDArray[np.float64], npt.NDArray[np.float64]]:
    """Propagate `field` through 5x5 augmented ABCD operator `M` using the
    generalized Collins-Wolf FFT.

    Inputs (all mm):
        field       (N, N) complex amplitude E(x, y)
        x_grid_mm   (N, N) or (N,) input transverse x coordinates
        y_grid_mm   (N, N) or (N,) input transverse y coordinates
        M           5x5 augmented ABCD operator (numpy array)
        wavelength_nm

    Returns:
        E_out       (N, N) complex amplitude at output plane
        x_out_mm    (N, N) output transverse x coordinates
        y_out_mm    (N, N) output transverse y coordinates

    The output sampling pitch scales with λ·|B|/(N·Δx_in), so a tighter
    beam at the output requires a wider input grid (Nyquist trade-off).

    Raises:
        ValueError if |B_x| or |B_y| < B_DEGENERATE_THRESHOLD_MM.
        The B → 0 limit is the imaging plane: M acts as a pure magnifier
        (no diffraction), and Collins-FFT diverges. The caller should
        insert a tiny free-space step or switch to a non-Fresnel imaging
        formula in that case.
    """
    if M.shape != (5, 5):
        raise ValueError(f"operator must be 5x5, got {M.shape}")

    A_x, B_x, D_x = M[0, 0], M[0, 1], M[1, 1]
    A_y, B_y, D_y = M[2, 2], M[2, 3], M[3, 3]
    e_x, f_x = M[0, 4], M[1, 4]  # x-block 5th col: position shift, angle shift
    e_y, f_y = M[2, 4], M[3, 4]

    if abs(B_x) < B_DEGENERATE_THRESHOLD_MM or abs(B_y) < B_DEGENERATE_THRESHOLD_MM:
        raise ValueError(
            f"B element too small for Collins-FFT (B_x={B_x}, B_y={B_y}); "
            f"insert a tiny free-space step or use an imaging formula."
        )

    if x_grid_mm.ndim == 1:
        x_grid_mm, y_grid_mm = np.meshgrid(x_grid_mm, y_grid_mm)
    N = field.shape[0]
    dx = float(x_grid_mm[0, 1] - x_grid_mm[0, 0])
    dy = float(y_grid_mm[1, 0] - y_grid_mm[0, 0])

    lam_mm = wavelength_nm * 1e-6

    # Step 1: pre-FFT phase modulation (input plane)
    phase_in = (
        (A_x * x_grid_mm ** 2) * (np.pi / (lam_mm * B_x))
        + (A_y * y_grid_mm ** 2) * (np.pi / (lam_mm * B_y))
        + 2.0 * np.pi * f_x * x_grid_mm / (lam_mm * B_x)
        + 2.0 * np.pi * f_y * y_grid_mm / (lam_mm * B_y)
    )
    E1 = field * np.exp(1j * phase_in)

    # Step 2: 2D FFT, centred via fftshift on both sides
    E2 = np.fft.fftshift(np.fft.fft2(np.fft.fftshift(E1))) * (dx * dy)

    # Output sampling pitch (scaling law for Collins-FFT)
    dfx = 1.0 / (N * dx)
    dfy = 1.0 / (N * dy)
    x0_1d = np.arange(-N // 2, N // 2) * (lam_mm * abs(B_x) * dfx)
    y0_1d = np.arange(-N // 2, N // 2) * (lam_mm * abs(B_y) * dfy)
    x_out_mm, y_out_mm = np.meshgrid(x0_1d, y0_1d)

    # Step 3: post-FFT phase modulation (output plane)
    phase_out = (
        (D_x * x_out_mm ** 2) * (np.pi / (lam_mm * B_x))
        + (D_y * y_out_mm ** 2) * (np.pi / (lam_mm * B_y))
        - 2.0 * np.pi * e_x * x_out_mm / (lam_mm * B_x)
        - 2.0 * np.pi * e_y * y_out_mm / (lam_mm * B_y)
    )

    amplitude_factor = -1j / (lam_mm * np.sqrt(B_x * B_y))
    E_out = amplitude_factor * E2 * np.exp(1j * phase_out)
    return E_out, x_out_mm, y_out_mm


def aperture_mask(
    x_grid_mm: npt.NDArray[np.float64],
    y_grid_mm: npt.NDArray[np.float64],
    radius_mm: float,
    *,
    centre_x_mm: float = 0.0,
    centre_y_mm: float = 0.0,
) -> npt.NDArray[np.float64]:
    """Hard circular aperture: 1 inside radius, 0 outside.

    For a decentered or tilted aperture, the caller can transform the
    grid first (e.g., (x - δ) / cos(α)) before calling this helper —
    matches the user's reference example.
    """
    if x_grid_mm.ndim == 1:
        x_grid_mm, y_grid_mm = np.meshgrid(x_grid_mm, y_grid_mm)
    r2 = (x_grid_mm - centre_x_mm) ** 2 + (y_grid_mm - centre_y_mm) ** 2
    return (r2 <= radius_mm * radius_mm).astype(np.float64)
