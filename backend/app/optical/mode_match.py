"""Mode-matching core — Gaussian mode overlap and (later) the shaping-lens
optimizer that drives two beams' transverse modes to coincide.

Phase 1 (this file, for now): the closed-form POWER overlap between two
general-astigmatic Gaussian modes at a common plane, same wavelength, same
propagation axis.

Physics
-------
A Gaussian transverse field is ``E(r) ~ exp(-i (k/2) rᵀ P r)`` with the
complex symmetric curvature matrix ``P = Q⁻¹`` (Q is the beam matrix carried
on every :class:`~app.optical.beam_ray.BeamRay` as ``QMatrix``). The power
coupling of two such modes is the normalized squared overlap integral
``η = |⟨E₁|E₂⟩|² / (⟨E₁|E₁⟩⟨E₂|E₂⟩)``. Carrying out the two Gaussian
integrals gives the closed form

    η = √( det(-2·Im P₁) · det(-2·Im P₂) ) / |det(P₁* - P₂)|
      = 4·√( det(Im P₁)·det(Im P₂) ) / |det(P₁* - P₂)|

which for a physical beam (Im P negative-definite, so det(Im P) > 0) is real
and lies in [0, 1]. It is 1 exactly when ``P₁ == P₂`` (identical q, including
astigmatism magnitude AND axis), and factorizes into the two 1-D per-axis
overlaps ``η_x·η_y`` whenever both beams are diagonal in the same frame — so
it is a strict generalization of the scalar formula, valid for the rotated,
cross-term astigmatism a tapered amplifier produces.

This is the same η the future fiber couple wants: η = 1 ⇔ the two beams have
the same spot everywhere along the axis, which is the mode-matching goal.

Frame note: ``P₁`` and ``P₂`` must be expressed in the SAME transverse basis.
:func:`gaussian_mode_overlap` takes two :class:`QMatrix` and assumes they
already share a frame (the caller rotates one onto the other's frame with
``q_rotate`` when they don't — every beam the tracer builds today shares the
lab-referenced beam frame at a common plane).
"""

from __future__ import annotations

from app.optical.beam_ray import QMatrix

# Below this |det Q| a beam is treated as degenerate (collapsed / no envelope)
# and the overlap is reported as 0 rather than dividing through a near-zero.
_DET_EPS = 1e-30


def _inv_symmetric(q: QMatrix) -> tuple[complex, complex, complex] | None:
    """P = Q⁻¹ for a symmetric 2×2, returned as ``(Pxx, Pyy, Pxy)``.

    ``None`` when Q is singular (degenerate beam)."""
    det = q.xx * q.yy - q.xy * q.xy
    if abs(det) < _DET_EPS:
        return None
    return q.yy / det, q.xx / det, -q.xy / det


def _det_imag(pxx: complex, pyy: complex, pxy: complex) -> float:
    """det of the imaginary part of a symmetric 2×2 curvature matrix."""
    a, c, b = pxx.imag, pyy.imag, pxy.imag
    return a * c - b * b


def gaussian_mode_overlap(q1: QMatrix, q2: QMatrix) -> float:
    """Power coupling η ∈ [0, 1] between two general-astigmatic Gaussian modes
    (same wavelength, same axis, same transverse frame, evaluated at one plane).

    η = 1 iff the two beams have identical q (waist size, waist location, and
    astigmatism orientation). Returns 0.0 for a degenerate input beam.
    """
    p1 = _inv_symmetric(q1)
    p2 = _inv_symmetric(q2)
    if p1 is None or p2 is None:
        return 0.0
    p1xx, p1yy, p1xy = p1
    p2xx, p2yy, p2xy = p2

    det_im1 = _det_imag(p1xx, p1yy, p1xy)
    det_im2 = _det_imag(p2xx, p2yy, p2xy)
    # Im P is negative-definite for a physical beam ⇒ det(Im P) > 0; a
    # non-positive value means a degenerate / non-physical input.
    if det_im1 <= 0.0 or det_im2 <= 0.0:
        return 0.0

    # D = P₁* - P₂ (element-wise conjugate on beam 1), then det(D).
    dxx = p1xx.conjugate() - p2xx
    dyy = p1yy.conjugate() - p2yy
    dxy = p1xy.conjugate() - p2xy
    det_d = dxx * dyy - dxy * dxy
    denom = abs(det_d)
    if denom < _DET_EPS:
        return 0.0

    eta = 4.0 * (det_im1 * det_im2) ** 0.5 / denom
    # Clamp rounding excursions just past 1.0 at perfect match.
    return min(eta, 1.0)
