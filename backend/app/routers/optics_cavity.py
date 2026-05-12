"""Optical cavity calculator router — Phase Optics-Cavity.

Stateless: the solver is sub-millisecond, so no DB persistence, no
WebSocket progress, no SimulationRun row. Just a single POST that
takes a CavityRequest and returns the bundled metrics + Airy spectrum.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import Field

from app.schemas import CamelModel
from app.solvers.optics_cavity import (
    CavityKind,
    CavityMirror,
    CavityRequest,
    compute,
)


router = APIRouter()


class CavityMirrorIn(CamelModel):
    reflectivity: float = Field(..., ge=0.0, lt=1.0)
    radius_curvature_mm: float | None = None


class CavityComputeIn(CamelModel):
    kind: CavityKind = "linear"
    length_mm: float = Field(..., gt=0.0)
    wavelength_nm: float = Field(..., gt=0.0)
    mirrors: list[CavityMirrorIn]
    intracavity_loss: float = Field(default=0.0, ge=0.0, le=1.0)
    refractive_index: float = Field(default=1.0, gt=0.0)
    spectrum_span_fsr: float = Field(default=4.0, gt=0.0)
    spectrum_points: int = Field(default=401, ge=11, le=2001)


class CavityComputeOut(CamelModel):
    fsr_hz: float
    fsr_mhz: float
    round_trip_length_mm: float
    finesse: float
    linewidth_hz: float
    linewidth_mhz: float
    linewidth_pm: float
    quality_factor: float
    photon_lifetime_ns: float
    resonance_wavelength_nm: float
    resonance_frequency_thz: float
    rt_reflectivity: float
    g1g2: float | None
    stable: bool | None
    waist_um: float | None
    spectrum_freq_offset_mhz: list[float]
    spectrum_transmission: list[float]
    spectrum_reflection: list[float]
    warnings: list[str]


@router.post("/compute", response_model=CavityComputeOut)
async def compute_cavity(payload: CavityComputeIn) -> CavityComputeOut:
    try:
        req = CavityRequest(
            kind=payload.kind,
            length_mm=payload.length_mm,
            wavelength_nm=payload.wavelength_nm,
            mirrors=[
                CavityMirror(
                    reflectivity=m.reflectivity,
                    radius_curvature_mm=m.radius_curvature_mm,
                )
                for m in payload.mirrors
            ],
            intracavity_loss=payload.intracavity_loss,
            refractive_index=payload.refractive_index,
            spectrum_span_fsr=payload.spectrum_span_fsr,
            spectrum_points=payload.spectrum_points,
        )
        result = compute(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return CavityComputeOut(**result.__dict__)
