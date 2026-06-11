"""Physical-optics propagation (POP) field engine — Stage 2.

A scalar 2D complex field ``E(x,y)`` on a square grid, propagated by the
**angular-spectrum method** (free space) and Fourier-transformed by a lens to
its **focal plane** (Fraunhofer). This is the channel that turns a beam
truncated by a finite clear aperture into a real **Airy diffraction pattern**
— the rings the q-channel cannot represent.

Architectural contract (see docs/introduce/optics.md): this rides ALONGSIDE
the Gaussian-q chief-ray tracer. It borrows the geometric path (distances +
each optic's aperture/focal) the q-tracer establishes (``pop_pass.py``); it
does NOT re-derive geometry, polarization, AOM sidebands, or fiber coupling.

Units: lengths in mm. ``field`` is dimensionless complex amplitude; intensity
is ``|E|²`` in the same arbitrary units (POP cares about the *pattern* and
relative power, not absolute irradiance — absolute power stays on the
q-channel's ``power_mw``).

Conventions: the grid is N×N, centred on the optical axis, pixel pitch
``pitch_mm``. The field array is stored "natural" (index [0,0] = top-left,
i.e. (x=-L/2, y=-L/2)); FFTs use ``ifftshift``/``fftshift`` to move between
natural (centred) and FFT (corner-origin) orderings.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class PopField:
    """A sampled scalar complex field on a square grid."""

    field: np.ndarray            # complex (N, N)
    pitch_mm: float              # pixel pitch
    wavelength_mm: float

    @property
    def n(self) -> int:
        return self.field.shape[0]

    @property
    def extent_mm(self) -> float:
        """Full physical width of the grid (N · pitch)."""
        return self.n * self.pitch_mm

    @property
    def half_extent_mm(self) -> float:
        return 0.5 * self.extent_mm

    def intensity(self) -> np.ndarray:
        return np.abs(self.field) ** 2

    def power(self) -> float:
        """Total power = Σ|E|²·pitch² (arbitrary units; used for ratios)."""
        return float(self.intensity().sum() * self.pitch_mm * self.pitch_mm)

    def axes_mm(self) -> np.ndarray:
        """1-D coordinate axis (centred): length N, from −L/2 to +L/2−pitch."""
        n = self.n
        return (np.arange(n) - n // 2) * self.pitch_mm


# ── seeding ────────────────────────────────────────────────────────────────

def _coord_grids(n: int, pitch_mm: float) -> tuple[np.ndarray, np.ndarray]:
    ax = (np.arange(n) - n // 2) * pitch_mm
    x, y = np.meshgrid(ax, ax)
    return x, y


def seed_plane_wave(
    n: int, pitch_mm: float, wavelength_mm: float, amplitude: float = 1.0,
) -> PopField:
    """Uniform unit-amplitude field (a collimated plane wave)."""
    return PopField(
        field=np.full((n, n), amplitude, dtype=np.complex128),
        pitch_mm=pitch_mm,
        wavelength_mm=wavelength_mm,
    )


def seed_gaussian(
    n: int, pitch_mm: float, wavelength_mm: float,
    w0x_mm: float, w0y_mm: float, amplitude: float = 1.0,
) -> PopField:
    """Gaussian at its waist (flat phase): E = exp(−x²/w0x² − y²/w0y²)
    (1/e² intensity radius = w0). Astigmatic when w0x ≠ w0y."""
    x, y = _coord_grids(n, pitch_mm)
    e = amplitude * np.exp(-(x * x) / (w0x_mm * w0x_mm) - (y * y) / (w0y_mm * w0y_mm))
    return PopField(field=e.astype(np.complex128), pitch_mm=pitch_mm,
                    wavelength_mm=wavelength_mm)


# ── element operators (in-place-style, return new PopField) ────────────────

def apply_circular_aperture(
    pf: PopField, radius_mm: float, cx_mm: float = 0.0, cy_mm: float = 0.0,
) -> PopField:
    """Hard circular aperture: zero the field outside ``radius_mm`` (centre
    offset ``cx/cy``). This truncation is what seeds the diffraction rings."""
    if radius_mm <= 0:
        return pf
    x, y = _coord_grids(pf.n, pf.pitch_mm)
    mask = ((x - cx_mm) ** 2 + (y - cy_mm) ** 2) <= radius_mm * radius_mm
    return PopField(field=pf.field * mask, pitch_mm=pf.pitch_mm,
                    wavelength_mm=pf.wavelength_mm)


def apply_thin_lens(pf: PopField, f_mm: float) -> PopField:
    """Thin-lens quadratic phase: E·exp(−i k r²/(2f)), k = 2π/λ."""
    if f_mm == 0:
        return pf
    x, y = _coord_grids(pf.n, pf.pitch_mm)
    k = 2.0 * np.pi / pf.wavelength_mm
    phase = np.exp(-1j * k * (x * x + y * y) / (2.0 * f_mm))
    return PopField(field=pf.field * phase, pitch_mm=pf.pitch_mm,
                    wavelength_mm=pf.wavelength_mm)


# ── propagation ────────────────────────────────────────────────────────────

def propagate_asm(pf: PopField, dz_mm: float) -> PopField:
    """Angular-spectrum free-space propagation by ``dz_mm``.

    E(z+dz) = IFFT{ FFT{E} · exp(i k dz √(1 − (λfx)² − (λfy)²)) }.
    Evanescent components (radical < 0) are zeroed. Exact (within sampling)
    in the near and far field — produces diffraction rings naturally.
    """
    if dz_mm == 0:
        return pf
    n = pf.n
    lam = pf.wavelength_mm
    fx = np.fft.fftfreq(n, d=pf.pitch_mm)
    fxx, fyy = np.meshgrid(fx, fx)
    arg = 1.0 - (lam * fxx) ** 2 - (lam * fyy) ** 2
    evanescent = arg < 0
    arg_clipped = np.where(evanescent, 0.0, arg)
    h = np.exp(1j * 2.0 * np.pi / lam * dz_mm * np.sqrt(arg_clipped))
    h[evanescent] = 0.0
    spectrum = np.fft.fft2(pf.field)
    out = np.fft.ifft2(spectrum * h)
    return PopField(field=out, pitch_mm=pf.pitch_mm, wavelength_mm=lam)


def focal_plane(pf_at_lens: PopField, f_mm: float) -> PopField:
    """Field at the back focal plane of a lens of focal length ``f_mm``,
    given the field *immediately after* the aperture (and before/without the
    lens phase — a lens performs an exact optical Fourier transform from its
    front to its back focal plane).

    Output pixel pitch = λ·f / (N·pitch_in) (the Fraunhofer scaling). For a
    uniform circular aperture this returns the Airy pattern with first null
    at 1.22·λ·f / D.
    """
    n = pf_at_lens.n
    lam = pf_at_lens.wavelength_mm
    # Centred FT: ifftshift → fft2 → fftshift keeps the optical axis centred.
    spectrum = np.fft.fftshift(np.fft.fft2(np.fft.ifftshift(pf_at_lens.field)))
    out_pitch = lam * f_mm / (n * pf_at_lens.pitch_mm)
    # Energy-preserving FFT scale (Parseval); absolute scale is irrelevant for
    # the pattern but keeps power() comparisons sane.
    spectrum = spectrum * (pf_at_lens.pitch_mm / out_pitch) / n
    return PopField(field=spectrum, pitch_mm=out_pitch, wavelength_mm=lam)


# ── readout helpers ────────────────────────────────────────────────────────

def radial_profile(pf: PopField) -> tuple[np.ndarray, np.ndarray]:
    """Azimuthally-averaged intensity vs radius. Returns (radius_mm, I).
    Radius bins are one pixel wide out to the half-extent."""
    n = pf.n
    x, y = _coord_grids(n, pf.pitch_mm)
    r = np.sqrt(x * x + y * y)
    inten = pf.intensity()
    r_bin = np.round(r / pf.pitch_mm).astype(int)
    nbins = r_bin.max() + 1
    sums = np.bincount(r_bin.ravel(), weights=inten.ravel(), minlength=nbins)
    counts = np.bincount(r_bin.ravel(), minlength=nbins)
    prof = sums / np.maximum(counts, 1)
    radii = np.arange(nbins) * pf.pitch_mm
    return radii, prof


def downsample_intensity(pf: PopField, out_n: int = 128) -> np.ndarray:
    """Resample the intensity grid to ``out_n`` × ``out_n`` (wire payload cap),
    CENTRED and peak-normalized. Returns a float32 (out_n, out_n).

    Centre-crops to the largest ``k·out_n`` block (k ≥ 1) around the optical
    axis before block-averaging, so the axis stays at the output centre (a
    corner crop would shift the Airy peak off-centre)."""
    inten = pf.intensity()
    n = inten.shape[0]
    if n < out_n:
        # Smaller than the wire grid: embed centred into an out_n canvas.
        out = np.zeros((out_n, out_n), dtype=inten.dtype)
        off = (out_n - n) // 2
        out[off:off + n, off:off + n] = inten
    else:
        k = n // out_n
        m = k * out_n
        off = (n - m) // 2
        cropped = inten[off:off + m, off:off + m]
        out = cropped.reshape(out_n, k, out_n, k).mean(axis=(1, 3))
    peak = out.max()
    if peak > 0:
        out = out / peak
    return out.astype(np.float32)
