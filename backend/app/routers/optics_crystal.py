"""Nonlinear-crystal calculator router — Phase Optics-Crystal.

Stateless: each computation is sub-millisecond, so no SimulationRun
row, no WS progress events. Four endpoints, one each:

  POST /catalog      → list available crystals + metadata
  POST /dispersion   → n(λ) curve over a wavelength range
  POST /phase-match  → QPM period (or BPM angle, future) at a single λ
  POST /spdc-tuning  → signal/idler vs temperature for given Λ
  POST /shg          → plane-wave SHG efficiency at a single λ

`kind` is the χ⁽²⁾ interaction type: ``type0_eee`` (default for PPKTP /
PPLN), ``type1_ooe``, ``type2_oeo``, ``type2_eoe``.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import Field

from app.schemas import CamelModel
from app.solvers.optics_crystal import (
    CRYSTALS,
    NLKind,
    PrincipalAxis,
    qpm_period,
    refractive_index,
    shg_efficiency_plane_wave,
    spdc_tuning,
)


router = APIRouter()


# ---- Schemas --------------------------------------------------------------


class CrystalSummary(CamelModel):
    id: str
    full_name: str
    is_biaxial: bool
    is_qpm: bool
    axes: list[str]
    kinds: list[str]
    description: str


class CrystalCatalogOut(CamelModel):
    crystals: list[CrystalSummary]


class DispersionRequest(CamelModel):
    crystal_id: str
    axis: PrincipalAxis = "z"
    t_C: float = 25.0
    wavelength_min_nm: float = Field(default=400.0, gt=0.0)
    wavelength_max_nm: float = Field(default=1700.0, gt=0.0)
    points: int = Field(default=201, ge=11, le=2001)


class DispersionOut(CamelModel):
    wavelength_nm: list[float]
    n: list[float]
    t_C: float
    axis: str


class PhaseMatchRequest(CamelModel):
    crystal_id: str
    kind: NLKind = "type0_eee"
    pump_nm: float = Field(..., gt=0.0)
    signal_nm: float = Field(..., gt=0.0)
    t_C: float = 25.0


class PhaseMatchOut(CamelModel):
    poling_period_um: float | None
    idler_nm: float
    delta_k_bulk_per_mm: float
    n_pump: float
    n_signal: float
    n_idler: float
    method: str  # "qpm" or "bpm"
    warnings: list[str]


class SpdcTuningRequest(CamelModel):
    crystal_id: str
    kind: NLKind = "type0_eee"
    pump_nm: float = Field(..., gt=0.0)
    poling_um: float | None = None
    t_min_C: float = 10.0
    t_max_C: float = 90.0
    t_points: int = Field(default=41, ge=2, le=201)


class SpdcTuningRow(CamelModel):
    t_C: float
    signal_nm: float | None
    idler_nm: float | None
    delta_k_bulk_per_mm: float | None


class SpdcTuningOut(CamelModel):
    rows: list[SpdcTuningRow]
    auto_poling_um: float | None


class ShgRequest(CamelModel):
    crystal_id: str
    kind: NLKind = "type0_eee"
    fundamental_nm: float = Field(..., gt=0.0)
    p_pump_w: float = Field(..., gt=0.0)
    crystal_length_mm: float = Field(..., gt=0.0)
    beam_waist_um: float = Field(default=50.0, gt=0.0)
    t_C: float = 25.0
    poling_um: float | None = None


class ShgOut(CamelModel):
    fundamental_nm: float
    second_harmonic_nm: float
    n_fundamental: float
    n_second_harmonic: float
    d_eff_pm_per_v: float
    poling_um: float | None
    delta_k_bulk_per_mm: float
    delta_k_effective_per_mm: float
    intensity_w_per_m2: float
    eta: float
    p_sh_w: float
    sinc_factor: float


# ---- Endpoints ------------------------------------------------------------


@router.get("/catalog", response_model=CrystalCatalogOut)
async def catalog() -> CrystalCatalogOut:
    items: list[CrystalSummary] = []
    for crystal in CRYSTALS.values():
        axes = []
        if crystal.is_biaxial:
            if crystal.sellmeier_x:
                axes.append("x")
            if crystal.sellmeier_y:
                axes.append("y")
            if crystal.sellmeier_z:
                axes.append("z")
        else:
            if crystal.sellmeier_x:
                axes.append("o")
            if crystal.sellmeier_z:
                axes.append("e")
        items.append(
            CrystalSummary(
                id=crystal.id,
                full_name=crystal.full_name,
                is_biaxial=crystal.is_biaxial,
                is_qpm=crystal.is_qpm,
                axes=axes,
                kinds=list(crystal.d_eff_pm_per_V.keys()),
                description=crystal.description,
            )
        )
    return CrystalCatalogOut(crystals=items)


@router.post("/dispersion", response_model=DispersionOut)
async def dispersion(payload: DispersionRequest) -> DispersionOut:
    if payload.crystal_id not in CRYSTALS:
        raise HTTPException(status_code=404, detail=f"unknown crystal {payload.crystal_id!r}")
    lo, hi = payload.wavelength_min_nm, payload.wavelength_max_nm
    if lo >= hi:
        raise HTTPException(status_code=400, detail="wavelength_min must be < wavelength_max")
    n_pts = payload.points
    step = (hi - lo) / (n_pts - 1)
    wavelengths: list[float] = []
    indices: list[float] = []
    for i in range(n_pts):
        lam_nm = lo + step * i
        try:
            n = refractive_index(payload.crystal_id, lam_nm, payload.axis, payload.t_C)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        wavelengths.append(lam_nm)
        indices.append(n)
    return DispersionOut(
        wavelength_nm=wavelengths, n=indices, t_C=payload.t_C, axis=payload.axis
    )


@router.post("/phase-match", response_model=PhaseMatchOut)
async def phase_match(payload: PhaseMatchRequest) -> PhaseMatchOut:
    if payload.crystal_id not in CRYSTALS:
        raise HTTPException(status_code=404, detail=f"unknown crystal {payload.crystal_id!r}")
    crystal = CRYSTALS[payload.crystal_id]
    warnings: list[str] = []
    method = "qpm" if crystal.is_qpm else "bpm"
    try:
        idler_nm = 1.0 / (1.0 / payload.pump_nm - 1.0 / payload.signal_nm)
    except ZeroDivisionError:
        raise HTTPException(status_code=400, detail="degenerate energy conservation singularity") from None
    if idler_nm <= 0:
        raise HTTPException(
            status_code=400,
            detail=(
                f"unphysical: 1/{payload.pump_nm} − 1/{payload.signal_nm} ≤ 0 "
                "(signal must be longer than pump)"
            ),
        )

    if crystal.is_qpm:
        try:
            period_um = qpm_period(
                payload.crystal_id, payload.kind, payload.pump_nm, payload.signal_nm, payload.t_C
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    else:
        period_um = None
        warnings.append(
            f"{crystal.full_name} is not periodically poled — birefringent phase matching "
            "(angle θ) not yet implemented in this Phase. Showing Δk_bulk only."
        )

    from app.solvers.optics_crystal import _axes_for_kind, _delta_k_bulk

    a_p, a_s, a_i = _axes_for_kind(payload.kind)
    n_pump = refractive_index(payload.crystal_id, payload.pump_nm, a_p, payload.t_C)
    n_signal = refractive_index(payload.crystal_id, payload.signal_nm, a_s, payload.t_C)
    n_idler = refractive_index(payload.crystal_id, idler_nm, a_i, payload.t_C)
    dk_bulk = _delta_k_bulk(
        payload.crystal_id,
        payload.kind,
        payload.pump_nm,
        payload.signal_nm,
        idler_nm,
        payload.t_C,
    )

    return PhaseMatchOut(
        poling_period_um=period_um,
        idler_nm=idler_nm,
        delta_k_bulk_per_mm=dk_bulk * 1e-3,
        n_pump=n_pump,
        n_signal=n_signal,
        n_idler=n_idler,
        method=method,
        warnings=warnings,
    )


@router.post("/spdc-tuning", response_model=SpdcTuningOut)
async def spdc_tuning_route(payload: SpdcTuningRequest) -> SpdcTuningOut:
    if payload.crystal_id not in CRYSTALS:
        raise HTTPException(status_code=404, detail=f"unknown crystal {payload.crystal_id!r}")
    crystal = CRYSTALS[payload.crystal_id]
    poling_um = payload.poling_um
    auto_poling_um: float | None = None
    if crystal.is_qpm and poling_um is None:
        # Auto-pick the QPM period that makes 2λ_p phase-match at the
        # midpoint temperature, so the sweep is centered on degenerate.
        t_mid = 0.5 * (payload.t_min_C + payload.t_max_C)
        try:
            poling_um = qpm_period(
                payload.crystal_id, payload.kind, payload.pump_nm, 2.0 * payload.pump_nm, t_mid
            )
            auto_poling_um = poling_um
        except ValueError:
            poling_um = None

    rows = spdc_tuning(
        payload.crystal_id,
        payload.kind,
        pump_nm=payload.pump_nm,
        poling_um=poling_um,
        t_min_C=payload.t_min_C,
        t_max_C=payload.t_max_C,
        t_points=payload.t_points,
    )
    return SpdcTuningOut(
        rows=[
            SpdcTuningRow(
                t_C=r["t_C"],
                signal_nm=r["signal_nm"],
                idler_nm=r["idler_nm"],
                delta_k_bulk_per_mm=r["delta_k_bulk_per_mm"],
            )
            for r in rows
        ],
        auto_poling_um=auto_poling_um,
    )


@router.post("/shg", response_model=ShgOut)
async def shg(payload: ShgRequest) -> ShgOut:
    if payload.crystal_id not in CRYSTALS:
        raise HTTPException(status_code=404, detail=f"unknown crystal {payload.crystal_id!r}")
    try:
        res = shg_efficiency_plane_wave(
            payload.crystal_id,
            payload.kind,
            payload.fundamental_nm,
            payload.p_pump_w,
            payload.crystal_length_mm,
            payload.beam_waist_um,
            payload.t_C,
            payload.poling_um,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ShgOut(**res)
