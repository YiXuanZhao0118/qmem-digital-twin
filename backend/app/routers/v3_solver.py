"""v3 solver REST endpoint — POST /api/v3/solver/run.

Accepts a serialized V3Scene + initial rays, runs the v3 ray tracer,
returns SolverResult JSON. Stateless (no DB writes) — caller supplies
the scene snapshot directly.

DB-backed entry point (POST /api/v3/solver/run/{scene_id}) is a
follow-up: it would load a V3Scene from existing assets_3d / components
/ objects rows.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.optical.beam_ray import BeamRay, Vec3, make_beam_ray
from app.schemas import CamelModel


router = APIRouter(prefix="/v3/solver", tags=["v3-solver"])


# ---------------------------------------------------------------------------
# Pydantic request models — JSON-friendly shape, deserialized into the
# strongly-typed dataclasses the solver consumes.
# ---------------------------------------------------------------------------

class Vec3In(CamelModel):
    x: float
    y: float
    z: float


class ComplexIn(CamelModel):
    re: float
    im: float = 0.0


class RayIn(CamelModel):
    origin: Vec3In
    direction: Vec3In
    wavelength_nm: float
    waist_radius_mm: float = 0.5
    power_mw: float = 1.0
    jones: Optional[list[ComplexIn]] = None


class TraceOptionsIn(CamelModel):
    max_steps: int = 96
    power_threshold_mw: float = 1e-9


# ---------------------------------------------------------------------------
# Conversion helpers — Pydantic → solver dataclasses
# ---------------------------------------------------------------------------

def _to_vec3(v: Vec3In) -> Vec3:
    return Vec3(v.x, v.y, v.z)


def _to_beam_ray(r: RayIn) -> BeamRay:
    base = make_beam_ray(
        origin=_to_vec3(r.origin),
        direction=_to_vec3(r.direction),
        wavelength_nm=r.wavelength_nm,
        waist_radius_mm=r.waist_radius_mm,
        power_mw=r.power_mw,
    )
    if r.jones is not None and len(r.jones) == 2:
        jones = (
            complex(r.jones[0].re, r.jones[0].im),
            complex(r.jones[1].re, r.jones[1].im),
        )
        base = base.replaced(jones=jones)
    return base


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

class SolverRunFromDbRequest(CamelModel):
    """Options-only request body — scene is loaded from DB.

    ``dynamic_overrides`` (camelCase ``dynamicOverrides``) maps SceneObject id ->
    dynamic-key dict, merged on top of each object's persisted dynamic_sources.
    The frontend injects the effective AOM RF drive (aomFreqMhz / rfDrivePowerW)
    resolved from the RF link or a manual override.
    """
    options: Optional[TraceOptionsIn] = None
    initial_rays: list[RayIn] = Field(default_factory=list)
    dynamic_overrides: dict[str, dict] = Field(default_factory=dict)
    # Scrub-bar time in ns. The server resolves each AOM's effective RF drive
    # from the cable graph at this instant (None = "scrub stopped" rest snapshot,
    # i.e. PPG restState drives switch routing). dynamic_overrides still wins.
    scrub_time_ns: Optional[float] = None


@router.post("/run-from-db")
async def run_v3_solver_from_db(
    request: SolverRunFromDbRequest = SolverRunFromDbRequest(),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Trace the current DB scene with the v3 ANCHOR tracer (Phase 9.8).

    Loads SceneObject → Component → ComponentBinding → Asset3D from DB,
    builds the anchor-centric V3AnchorScene, runs the anchor tracer
    (single-anchor + offset/tilt → ABCD 5×5 for paraxial elements; v1
    closed-form for AOM / fiber). Returns the same SolverResult JSON
    schema as before (segments, labSegments, finalRays).
    """
    # Eager-load all anchor ops + emitter helper so registry populated.
    from app.optical import anchor_ops  # noqa: F401
    from app.optical.anchor_tracer import AnchorTraceOptions
    from app.optical.db_scene_loader import load_anchor_scene_from_db
    from app.optical.solver import solve_anchor_scene

    scene = await load_anchor_scene_from_db(
        session, request.dynamic_overrides, scrub_time_ns=request.scrub_time_ns,
    )
    rays = [_to_beam_ray(r) for r in request.initial_rays]
    opts = AnchorTraceOptions()
    if request.options:
        opts = AnchorTraceOptions(
            max_steps=request.options.max_steps,
            power_threshold_mw=request.options.power_threshold_mw,
        )
    result = solve_anchor_scene(scene, rays, opts)
    return result.to_dict()


class AomSidebandRequest(CamelModel):
    """Inputs for the AOM sideband table — the panel sends its effective params
    (RF resolved upstream) and renders exactly what this returns, so the table,
    the drawn beams, and the trace all use one datasheet-calibrated model
    (aom_physics + aom_sideband)."""
    wavelength_nm: float = 780.0
    freq_mhz: float = 80.0                 # actual RF DRIVE frequency
    acoustic_velocity_mps: float = 4200.0
    peak_efficiency: float = 0.85          # datasheet peak (η at rated drive)
    rf_power_w: Optional[float] = None     # actual RF drive power (None = rated)
    rf_power_for_peak_w: float = 2.2
    peak_ref_wavelength_nm: float = 1100.0
    center_freq_mhz: float = 80.0          # DESIGN centre for the bandwidth G(f)
    freq_shift_bandwidth_mhz: float = 15.0
    requires_rf_drive: bool = False
    selected_order: int = 1
    max_diffraction_order: int = 3
    sideband_visibility_threshold: float = 0.01


@router.post("/aom-sidebands")
async def aom_sidebands(req: AomSidebandRequest) -> dict:
    """Per-order AOM sideband table (single source of truth = aom_physics +
    aom_sideband). On-Bragg operating point (no incidence-angle detune)."""
    import math

    from app.optical.aom_physics import first_order_efficiency
    from app.optical.aom_sideband import (
        phase_modulation_depth,
        sideband_intensities_on_bragg,
    )

    lam = req.wavelength_nm * 1e-9
    f_hz = req.freq_mhz * 1e6
    v = req.acoustic_velocity_mps
    theta_b = (
        math.asin(max(-1.0, min(1.0, (lam * f_hz) / (2.0 * v))))
        if (v > 0 and f_hz > 0) else 0.0
    )
    eta = first_order_efficiency(
        wavelength_nm=req.wavelength_nm,
        freq_mhz=req.freq_mhz,
        rf_power_w=req.rf_power_w,
        peak_efficiency=req.peak_efficiency,
        rf_power_for_peak_w=req.rf_power_for_peak_w,
        peak_ref_wavelength_nm=req.peak_ref_wavelength_nm,
        center_freq_mhz=req.center_freq_mhz,
        freq_shift_bandwidth_mhz=req.freq_shift_bandwidth_mhz,
        requires_rf_drive=req.requires_rf_drive,
    )
    max_order = max(1, min(10, int(req.max_diffraction_order)))
    selected = max(-1, min(1, int(req.selected_order)))
    threshold = max(0.0, min(1.0, req.sideband_visibility_threshold))
    v_depth = phase_modulation_depth(first_order_efficiency=eta)
    intens = sideband_intensities_on_bragg(selected, eta, v_depth, max_order)
    carrier_thz = (299_792_458.0 / lam) / 1e12 if lam > 0 else 0.0
    sidebands = [
        {
            "order": m,
            "angleMrad": m * 2.0 * theta_b * 1e3,
            "frequencyOffsetMhz": m * req.freq_mhz,
            "centerFrequencyThz": carrier_thz + m * req.freq_mhz * 1e-6,
            "intensity": intens.get(m, 0.0),
            "visible": (m == 0 or m == selected or intens.get(m, 0.0) >= threshold),
        }
        for m in range(-max_order, max_order + 1)
    ]
    return {
        "thetaBMrad": theta_b * 1e3,
        "efficiency": eta,
        "phaseModDepth": v_depth,
        "sidebands": sidebands,
    }
