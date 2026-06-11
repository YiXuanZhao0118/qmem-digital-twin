"""Circular-aperture energy clipping for the Gaussian-q channel.

Single source of truth for "how much power survives a finite clear
aperture", shared by the lens op (which attenuates ``power_mw``) and the
tracer (which records a per-segment ``aperture_truncation`` descriptor for
the frontend). Mirrors the frontend ``profileUtils.ts`` gaussian branch so
backend and frontend agree on the fraction.

POP note: this is the *energy* half of the aperture story (Stage 1). The
diffraction *pattern* (Airy rings from the same truncation) is produced by
the separate field channel (``pop_field.py``), not here.
"""

from __future__ import annotations

import math

# Kinds whose anchor op models the clear aperture energetically. Kept here
# (not in lens.py) so the tracer can gate the truncation descriptor without
# importing an op module.
LENS_KINDS = frozenset(
    {"lens", "lens_biconvex", "lens_plano_convex", "lens_cylindrical"}
)


def gaussian_width_mm(q: complex, wavelength_nm: float) -> float:
    """Gaussian 1/e² field radius w from a q-parameter:
    1/q = 1/R − iλ/(πw²) ⇒ w² = λ·|q|²/(π·Im q). Returns 0 for a
    degenerate q (Im ≤ 0). Mirror of frontend ``gaussianWidthMm``."""
    im = q.imag
    if im <= 0.0 or wavelength_nm <= 0.0:
        return 0.0
    lam_mm = wavelength_nm * 1e-6
    w_sq = lam_mm * (q.real * q.real + im * im) / (math.pi * im)
    return math.sqrt(max(w_sq, 0.0))


def gaussian_circular_aperture_fraction(
    w_eff_mm: float, aperture_mm: float, r_c_mm: float = 0.0
) -> float:
    """Fraction (0..1) of a Gaussian's power passing a circular aperture of
    radius ``aperture_mm`` whose centre is offset ``r_c_mm`` from the beam
    centre. On-axis (``r_c=0``) is the exact closed form
    ``1 − exp(−2a²/w²)``; the decentred case is an approximation (no closed
    form) matching the frontend ``calculateProfileClipping`` gaussian branch.

    Returns 1.0 when the aperture or width is unusable (no clipping info).
    """
    a = aperture_mm
    w = w_eff_mm
    if a <= 0.0 or w <= 1e-12:
        return 1.0
    r_c = max(r_c_mm, 0.0)
    if r_c <= 1e-12:
        return _clamp01(1.0 - math.exp(-2.0 * a * a / (w * w)))
    u = r_c / w
    v = a / w
    if u > v + 3.0:
        return 0.0  # beam centre far outside the aperture
    return _clamp01(math.exp(-2.0 * u * u) * (1.0 - math.exp(-2.0 * v * v)))


def _clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x
