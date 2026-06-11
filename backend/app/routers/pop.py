"""POP (physical-optics propagation) REST endpoint — POST /api/v3/pop.

On-demand only: NEVER part of the live /api/v3/solver trace. The frontend
calls this when the beam-scope probes a beam downstream of a finite-aperture
lens, supplying the beam width at the lens (which the q-channel already
tracks) + the lens aperture/focal. Returns the focal-plane intensity (Airy)
grid for rendering the diffraction rings. See app/optical/pop_pass.py and
docs/introduce/optics.md.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.optical.pop_pass import lens_focal_airy_pattern
from app.schemas import CamelModel

router = APIRouter(prefix="/v3", tags=["pop"])


class PopLensFocalRequest(CamelModel):
    """Inputs for a single lens's focal-plane diffraction pattern. All
    geometry is sourced from the q-channel (the caller already has it)."""
    w_at_lens_um: float          # beam 1/e² radius at the lens (µm)
    aperture_mm: float           # lens clear-aperture RADIUS (anchor apertureMm)
    focal_length_mm: float
    wavelength_nm: float = 780.0
    grid_n: int = 1024           # internal field grid (power-of-two)
    out_n: int = 128             # wire grid cap


@router.post("/pop")
def pop_lens_focal(req: PopLensFocalRequest) -> dict:
    """Focal-plane Airy pattern of a Gaussian beam truncated by the lens
    clear aperture. On-demand; returns a peak-normalized intensity grid."""
    return lens_focal_airy_pattern(
        w_at_lens_mm=req.w_at_lens_um / 1000.0,
        aperture_mm=req.aperture_mm,
        f_mm=req.focal_length_mm,
        wavelength_nm=req.wavelength_nm,
        grid_n=max(256, min(req.grid_n, 2048)),
        out_n=max(32, min(req.out_n, 256)),
    )
