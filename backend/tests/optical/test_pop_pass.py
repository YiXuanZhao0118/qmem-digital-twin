"""POP pass — lens focal-plane Airy payload (Stage 2).

Exercises the q-channel → field-engine bridge: given the beam width at a lens,
its aperture and focal length, produce the focal-plane diffraction pattern the
beam-scope renders. Flagship numbers are the Thorlabs A230TM-B (f=4.51mm,
clearAperture 4.95mm → radius 2.475mm).
"""

import math

import numpy as np
import pytest

from app.optical.aperture import gaussian_circular_aperture_fraction
from app.optical.pop_pass import lens_focal_airy_pattern


def _grid(payload) -> np.ndarray:
    n = payload["size"]
    return np.array(payload["intensity"], dtype=float).reshape(n, n)


def test_a230_overfilled_is_airy_with_rings():
    # Beam radius == aperture radius ⇒ strong truncation ⇒ pronounced rings.
    a = 2.475
    payload = lens_focal_airy_pattern(
        w_at_lens_mm=a, aperture_mm=a, f_mm=4.51, wavelength_nm=850.0,
        grid_n=1024, out_n=128,
    )
    g = _grid(payload)
    assert payload["size"] == 128
    assert len(payload["intensity"]) == 128 * 128
    assert g.max() == pytest.approx(1.0, abs=1e-6)        # peak-normalized

    c = 128 // 2
    # Central Airy disc: the peak is at the centre.
    peak_idx = np.unravel_index(np.argmax(g), g.shape)
    assert abs(peak_idx[0] - c) <= 2 and abs(peak_idx[1] - c) <= 2

    # A horizontal cut from the centre must be NON-monotonic — dip to a null
    # then rise into the first bright ring (the signature of diffraction).
    cut = g[c, c:]
    # find first local minimum then a subsequent higher value
    dipped = False
    ring_after_dip = False
    for i in range(1, len(cut) - 1):
        if not dipped and cut[i] < cut[i - 1] and cut[i] <= cut[i + 1]:
            dipped = True
            null_val = cut[i]
            continue
        if dipped and cut[i] > null_val * 1.5:
            ring_after_dip = True
            break
    assert dipped and ring_after_dip


def test_clip_fraction_matches_stage1():
    a = 2.475
    payload = lens_focal_airy_pattern(
        w_at_lens_mm=a, aperture_mm=a, f_mm=4.51, wavelength_nm=850.0,
    )
    assert payload["clipFraction"] == pytest.approx(
        gaussian_circular_aperture_fraction(a, a), rel=0.03
    )
    assert payload["diffractionLimited"] is True


def test_first_null_scaling():
    a, f, lam_nm = 2.475, 4.51, 850.0
    payload = lens_focal_airy_pattern(
        w_at_lens_mm=a, aperture_mm=a, f_mm=f, wavelength_nm=lam_nm,
    )
    expected_um = 1.22 * (lam_nm * 1e-6) * f / (2.0 * a) * 1000.0
    assert payload["firstNullUm"] == pytest.approx(expected_um, rel=1e-6)


def test_small_beam_not_diffraction_limited():
    # Beam much smaller than the aperture ⇒ negligible clipping.
    payload = lens_focal_airy_pattern(
        w_at_lens_mm=0.2, aperture_mm=2.475, f_mm=4.51, wavelength_nm=850.0,
    )
    assert payload["clipFraction"] == pytest.approx(1.0, abs=1e-3)
    assert payload["diffractionLimited"] is False
