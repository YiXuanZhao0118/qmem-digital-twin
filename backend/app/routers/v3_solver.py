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


class SolverRunFromComponentRequest(CamelModel):
    """Trace a probe ray through ONE component's binding assembly, in
    component frame. Powers the PHY Editor COMPONENT preview: the component's
    bindings/assets come from DB (by ``componentId``), but no SceneObject
    placement is needed. ``initialRays`` carries the probe (origin/direction
    in component frame, optional Jones for polarization)."""
    component_id: str
    initial_rays: list[RayIn] = Field(default_factory=list)
    options: Optional[TraceOptionsIn] = None


@router.post("/run-from-component")
async def run_v3_solver_from_component(
    request: SolverRunFromComponentRequest,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Trace a probe ray through one Component's assembly in component frame.

    Same anchor tracer + SolverResult schema as ``run-from-db`` (segments,
    labSegments, finalRays with per-segment Jones), so the COMPONENT preview
    draws per-asset polarization exactly like the Lab optical link — and it
    reflects the authoritative physics (e.g. the non-reciprocal Faraday
    rotator) instead of the legacy frontend face probe."""
    import uuid

    from app.optical import anchor_ops  # noqa: F401
    from app.optical.anchor_tracer import AnchorTraceOptions
    from app.optical.db_scene_loader import load_anchor_scene_from_component
    from app.optical.solver import solve_anchor_scene

    try:
        component_uuid = uuid.UUID(request.component_id)
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"componentId is not a valid UUID: {request.component_id!r}",
        )
    scene = await load_anchor_scene_from_component(session, component_uuid)
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


# ---------------------------------------------------------------------------
# Mode matching — shape the DBR seed into the TA (POST /api/v3/solver/mode-match)
# ---------------------------------------------------------------------------

class ModeMatchRequest(CamelModel):
    """Optimize the shaping lenses so the seed couples into the TA.

    Object ids are SceneObject ids (str(uuid)). ``movableIds`` are the shaping
    lenses in path order; ``endpointId`` (e.g. MIRROR5) is the section-end
    mirror, locked by default. ``focalInventory`` maps an object id to the
    focal lengths available for it (Stage-2 swap search)."""
    seed_emitter_id: str
    ta_object_id: str
    movable_ids: list[str] = []
    start_id: Optional[str] = None
    endpoint_id: Optional[str] = None
    endpoint_locked: bool = True
    axial_mm: float = 20.0
    # Transverse decenter is OFF by default — decentering a lens steers the
    # chief ray (a pointing error the mode-overlap objective doesn't penalize).
    # Opt in with decenter_mm > 0 only if you accept the beam walking off-centre.
    decenter_mm: float = 0.0
    roll_deg: float = 90.0
    eta_target: Optional[float] = None
    l_max_mm: Optional[float] = None
    focal_inventory: Optional[dict[str, list[float]]] = None
    wavelength_nm: float = 852.0
    dynamic_overrides: Optional[dict] = None
    scrub_time_ns: Optional[float] = None


@router.post("/mode-match")
async def mode_match(
    request: ModeMatchRequest,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Load the DB scene, trace the seed once, and optimize the shaping lenses
    to maximize seed→TA mode coupling under the length / η targets. Returns an
    applyable plan (per-lens world-space move + focal, expected η, length,
    feasibility) — see ``mode_match_service.run_mode_match``."""
    from sqlalchemy import select

    from app.optical import anchor_ops  # noqa: F401  (register ops)
    from app.optical.db_scene_loader import load_anchor_scene_from_db
    from app.optical.mode_match_service import run_mode_match
    from app.optical.solver import solve_anchor_scene
    from app.models.scene import SceneObject

    scene = await load_anchor_scene_from_db(
        session, request.dynamic_overrides, scrub_time_ns=request.scrub_time_ns,
    )
    forward = solve_anchor_scene(scene)
    rows = (await session.execute(select(SceneObject.id, SceneObject.name))).all()
    names = {str(i): n for i, n in rows}

    try:
        return run_mode_match(
            scene, forward,
            seed_emitter_id=request.seed_emitter_id,
            ta_object_id=request.ta_object_id,
            movable_ids=request.movable_ids,
            start_id=request.start_id,
            endpoint_id=request.endpoint_id,
            endpoint_locked=request.endpoint_locked,
            axial_mm=request.axial_mm,
            decenter_mm=request.decenter_mm,
            roll_deg=request.roll_deg,
            eta_target=request.eta_target,
            l_max_mm=request.l_max_mm,
            focal_inventory=request.focal_inventory,
            wavelength_nm=request.wavelength_nm,
            object_names=names,
        )
    except (ValueError, KeyError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        )
