"""POP pass — turn a beam truncated by a lens clear aperture into the
focal-plane diffraction (Airy) pattern (Stage 2).

This is the bridge between the q-channel and the field engine. The geometry
that defines the pattern —

  - ``w_at_lens_mm``  : the Gaussian 1/e² radius of the beam AT the lens,
                        which the q-channel already tracks (``qx``/``qy`` →
                        ``gaussian_width_mm``; the frontend computes the same
                        for its cone),
  - ``aperture_mm``   : the lens clear-aperture RADIUS (anchor ``apertureMm``),
  - ``f_mm``          : ``default_params.focalLengthMm``,

— is sourced from the q-trace, NOT recomputed here. We seed a Gaussian of
that width at the lens, hard-truncate it at the aperture, and Fourier-transform
to the focal plane (a lens images its front focal plane to its back focal
plane). A sub-aperture beam (w ≳ a) develops the classic Airy rings.

v1 limitations (documented in docs/introduce/optics.md):
  - flat incoming phase (collimated-at-lens assumption); incoming wavefront
    curvature is ignored — the dominant ring-forming effect is the aperture
    truncation, not the curvature.
  - single lens, focal-plane view only (not an arbitrary downstream plane).
"""

from __future__ import annotations

import numpy as np

from app.optical.pop_field import (
    PopField,
    apply_circular_aperture,
    downsample_intensity,
    focal_plane,
    seed_gaussian,
)

# Grid: aperture radius spans GRID_N/2/APERTURE_SPAN_FACTOR pixels, i.e. the
# aperture occupies 1/APERTURE_SPAN_FACTOR of the grid half-width — enough
# zero-padding around it for a clean Fraunhofer FT, while sampling the
# aperture edge finely.
_DEFAULT_GRID_N = 1024
_APERTURE_HALF_SPAN = 16     # aperture radius = (N/2)/16 = N/32 px
_AIRY_RADII_IN_VIEW = 6.0    # crop the focal plane to ±6 Airy nulls


def lens_focal_airy_pattern(
    w_at_lens_mm: float,
    aperture_mm: float,
    f_mm: float,
    wavelength_nm: float,
    *,
    grid_n: int = _DEFAULT_GRID_N,
    out_n: int = 128,
) -> dict:
    """Compute the focal-plane intensity (Airy) pattern of a Gaussian beam of
    radius ``w_at_lens_mm`` truncated by a circular aperture of radius
    ``aperture_mm`` and focused by ``f_mm``. Returns a JSON-safe payload:

        {
          "size": out_n,
          "halfExtentUm": <focal-plane half-width shown, µm>,
          "pitchUm": <focal-plane pixel pitch after crop+downsample, µm>,
          "firstNullUm": <1.22 λ f / D>,
          "clipFraction": <power kept by the aperture, 0..1>,
          "intensity": [out_n*out_n floats, row-major, peak-normalized 0..1],
          "diffractionLimited": <bool: aperture truncates the beam>,
        }
    """
    lam_mm = wavelength_nm * 1e-6
    a = max(aperture_mm, 1e-9)
    pitch = a / (grid_n / 2.0 / _APERTURE_HALF_SPAN)

    pf = seed_gaussian(grid_n, pitch, lam_mm, w_at_lens_mm, w_at_lens_mm)
    p_before = pf.power()
    pf = apply_circular_aperture(pf, a)
    p_after = pf.power()
    clip_fraction = p_after / p_before if p_before > 0 else 1.0

    foc = focal_plane(pf, f_mm)

    # Crop the (mostly-dark) focal plane to a few Airy radii so the rings fill
    # the view, then downsample to the wire grid.
    first_null_mm = 1.22 * lam_mm * f_mm / (2.0 * a)
    half_window_mm = _AIRY_RADII_IN_VIEW * first_null_mm
    foc_cropped = _crop_centered(foc, half_window_mm)
    grid = downsample_intensity(foc_cropped, out_n)

    return {
        "size": out_n,
        "halfExtentUm": foc_cropped.half_extent_mm * 1000.0,
        "pitchUm": (foc_cropped.extent_mm / out_n) * 1000.0,
        "firstNullUm": first_null_mm * 1000.0,
        "clipFraction": float(clip_fraction),
        "intensity": grid.flatten().astype(float).tolist(),
        "diffractionLimited": w_at_lens_mm >= a,
    }


def _crop_centered(pf: PopField, half_window_mm: float) -> PopField:
    """Crop to the central ±half_window_mm (clamped to the grid). Returns the
    field unchanged if the window covers the whole grid."""
    half_px = int(round(half_window_mm / pf.pitch_mm))
    half_px = max(8, min(half_px, pf.n // 2))
    c = pf.n // 2
    lo, hi = c - half_px, c + half_px
    return PopField(
        field=pf.field[lo:hi, lo:hi].copy(),
        pitch_mm=pf.pitch_mm,
        wavelength_mm=pf.wavelength_mm,
    )
