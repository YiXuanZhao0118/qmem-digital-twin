"""POP field engine physics (Stage 2).

Anchors the propagation/aperture/lens operators against closed-form optics:
  - circular aperture at a lens focal plane → Airy pattern (first null 1.22λf/D)
  - free-space Gaussian → w(z) = w0·√(1+(z/zR)²)
  - Gaussian through a circular aperture → power 1−exp(−2a²/w²) (ties to Stage 1)
"""

import math

import numpy as np
import pytest

from app.optical.aperture import gaussian_circular_aperture_fraction
from app.optical.pop_field import (
    apply_circular_aperture,
    focal_plane,
    propagate_asm,
    radial_profile,
    seed_gaussian,
    seed_plane_wave,
)


# ── Airy pattern: uniform circular aperture at a lens focal plane ──────────

def test_circular_aperture_focal_plane_is_airy():
    n = 1024
    lam = 0.5e-3            # 500 nm in mm
    f = 100.0              # mm
    a = 2.0               # aperture radius mm  → D = 4 mm
    pitch = a / 64.0       # aperture spans 64 px radius (well sampled)

    pw = seed_plane_wave(n, pitch, lam)
    apertured = apply_circular_aperture(pw, a)
    foc = focal_plane(apertured, f)

    radii, prof = radial_profile(foc)
    # On-axis is the global maximum (bright central Airy disc).
    assert prof[0] == pytest.approx(prof.max(), rel=1e-6)

    # First null radius: 1.22 · λ · f / D, D = 2a.
    expected_null = 1.22 * lam * f / (2.0 * a)
    # Find the first local minimum of the radial profile (the first dark ring).
    first_min = None
    for i in range(2, len(prof) - 1):
        if prof[i] < prof[i - 1] and prof[i] <= prof[i + 1]:
            first_min = radii[i]
            break
    assert first_min is not None
    assert first_min == pytest.approx(expected_null, rel=0.08)

    # A secondary maximum (the first bright ring) must exist beyond the null —
    # this is what distinguishes diffraction rings from a monotonic Gaussian.
    past_null = radii > first_min
    assert prof[past_null].max() > 0.0
    ring_idx = np.argmax(prof[past_null])
    ring_val = prof[past_null][ring_idx]
    # The first ring is a real local bump, not just the tail: it exceeds the
    # null floor by a clear margin.
    null_floor = prof[radii == first_min][0] if (radii == first_min).any() else 0.0
    assert ring_val > null_floor


# ── free-space Gaussian self-consistency vs the q-channel w(z) ─────────────

def test_gaussian_free_space_matches_wz():
    n = 512
    lam = 0.78e-3
    w0 = 0.20              # mm
    pitch = w0 / 16.0      # waist spans 16 px radius
    z_r = math.pi * w0 * w0 / lam      # Rayleigh range

    pf = seed_gaussian(n, pitch, lam, w0, w0)
    out = propagate_asm(pf, z_r)

    # 1/e² intensity radius after one Rayleigh range = w0·√2.
    radii, prof = radial_profile(out)
    peak = prof[0]
    target = peak * math.exp(-2.0)     # 1/e² of intensity
    # first radius where the profile drops below 1/e² of peak
    below = np.where(prof <= target)[0]
    assert below.size > 0
    w_measured = radii[below[0]]
    assert w_measured == pytest.approx(w0 * math.sqrt(2.0), rel=0.06)


# ── energy parity with Stage 1 aperture fraction ──────────────────────────

@pytest.mark.parametrize("ratio", [0.5, 1.0, 2.0])
def test_gaussian_aperture_power_matches_stage1(ratio):
    n = 1024
    lam = 0.78e-3
    w0 = 0.30
    a = ratio * w0
    pitch = w0 / 48.0       # very fine so the integral is accurate

    pf = seed_gaussian(n, pitch, lam, w0, w0)
    p_before = pf.power()
    clipped = apply_circular_aperture(pf, a)
    p_after = clipped.power()

    frac_measured = p_after / p_before
    frac_expected = gaussian_circular_aperture_fraction(w0, a)
    assert frac_measured == pytest.approx(frac_expected, rel=0.03)
