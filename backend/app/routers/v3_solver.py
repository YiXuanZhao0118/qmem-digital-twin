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
from app.optical.db_scene_loader import load_scene_from_db
from app.optical.ray_tracer import (
    TraceOptions,
    V3AssetSnapshot,
    V3ComponentBinding,
    V3ComponentSnapshot,
    V3Scene,
    V3SceneObject,
    V3TransitionDescriptor,
)
from app.optical.pose import V3Pose
from app.optical.registry import Face
from app.optical.solver import solve_v3_scene
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


class FaceIn(CamelModel):
    id: str
    position_mm_body_local: Vec3In
    normal_body_local: Optional[Vec3In] = None
    aperture_mm: float = 0.0
    aperture_shape: str = "rectangle"


class TransitionIn(CamelModel):
    in_face: str = Field(alias="in")
    via: Optional[list[str]] = None
    out_face: str | list[str] = Field(alias="out")
    op: str
    params: Optional[dict] = None
    matrix5x5: Optional[list[list[float]]] = None
    abcd: Optional[list[list[float]]] = None


class AssetIn(CamelModel):
    catalog_id: str
    kind: str
    faces: list[FaceIn]
    transitions: list[TransitionIn]
    default_params: dict = Field(default_factory=dict)


class BindingIn(CamelModel):
    binding_id: str
    asset: AssetIn
    local_pose: "PoseIn"


class ComponentIn(CamelModel):
    catalog_id: str
    bindings: list[BindingIn]


class PoseIn(CamelModel):
    x_mm: float = 0
    y_mm: float = 0
    z_mm: float = 0
    rx_deg: float = 0
    ry_deg: float = 0
    rz_deg: float = 0


class SceneObjectIn(CamelModel):
    id: str
    pose: PoseIn
    asset: Optional[AssetIn] = None
    component: Optional[ComponentIn] = None
    dynamic_sources: dict = Field(default_factory=dict)


class SceneIn(CamelModel):
    objects: list[SceneObjectIn]


class RayIn(CamelModel):
    origin: Vec3In
    direction: Vec3In
    wavelength_nm: float
    waist_radius_mm: float = 0.5
    power_mw: float = 1.0
    jones: Optional[list[ComplexIn]] = None


class TraceOptionsIn(CamelModel):
    max_steps: int = 32
    power_threshold_mw: float = 1e-9


class SolverRunRequest(CamelModel):
    scene: SceneIn
    initial_rays: list[RayIn] = Field(default_factory=list)
    options: Optional[TraceOptionsIn] = None


# Resolve forward reference
BindingIn.model_rebuild()


# ---------------------------------------------------------------------------
# Conversion helpers — Pydantic → solver dataclasses
# ---------------------------------------------------------------------------

def _to_vec3(v: Vec3In) -> Vec3:
    return Vec3(v.x, v.y, v.z)


def _to_face(f: FaceIn) -> Face:
    return Face(
        id=f.id,
        position_mm_body_local=_to_vec3(f.position_mm_body_local),
        normal_body_local=_to_vec3(f.normal_body_local) if f.normal_body_local else None,
        aperture_mm=f.aperture_mm,
        aperture_shape=f.aperture_shape,
    )


def _to_transition(t: TransitionIn) -> V3TransitionDescriptor:
    return V3TransitionDescriptor(
        in_face=t.in_face,
        out_face=t.out_face,
        op=t.op,
        params=t.params,
        matrix5x5=t.matrix5x5,
        abcd=t.abcd,
        via=tuple(t.via or ()),
    )


def _to_asset(a: AssetIn) -> V3AssetSnapshot:
    return V3AssetSnapshot(
        catalog_id=a.catalog_id,
        kind=a.kind,
        faces=[_to_face(f) for f in a.faces],
        transitions=[_to_transition(t) for t in a.transitions],
        default_params=a.default_params or {},
    )


def _to_pose(p: PoseIn) -> V3Pose:
    return V3Pose(
        x_mm=p.x_mm, y_mm=p.y_mm, z_mm=p.z_mm,
        rx_deg=p.rx_deg, ry_deg=p.ry_deg, rz_deg=p.rz_deg,
    )


def _to_component(c: ComponentIn) -> V3ComponentSnapshot:
    return V3ComponentSnapshot(
        catalog_id=c.catalog_id,
        bindings=[
            V3ComponentBinding(
                binding_id=b.binding_id,
                asset=_to_asset(b.asset),
                local_pose=_to_pose(b.local_pose),
            )
            for b in c.bindings
        ],
    )


def _to_scene_object(so: SceneObjectIn) -> V3SceneObject:
    return V3SceneObject(
        id=so.id,
        pose=_to_pose(so.pose),
        asset=_to_asset(so.asset) if so.asset else None,
        component=_to_component(so.component) if so.component else None,
        dynamic_sources=so.dynamic_sources or None,
    )


def _to_scene(s: SceneIn) -> V3Scene:
    return V3Scene(objects=[_to_scene_object(o) for o in s.objects])


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

@router.post("/run", deprecated=True)
async def run_v3_solver(request: SolverRunRequest) -> dict:
    """⚠️  DEPRECATED — kept for tests / parity checks only.

    Run the **legacy face-based** v3 ray tracer on a caller-supplied
    scene + initial rays. The production path is ``POST /run-from-db``,
    which loads the live SceneObject / Component / ComponentBinding
    graph from the DB and uses the **anchor-based** tracer
    (``solve_anchor_scene``, Phase 9.8+).

    Why this still exists:
    * ``backend/tests/optical/test_solver_v3*.py`` exercises the
      face-based orchestrator end-to-end; the test suite would lose
      coverage if this endpoint were removed.
    * The face-based code is the reference for parity checks against
      the anchor-based path (see ``docs/asset-physics-model.md``).

    Frontend consumers should NEVER call this endpoint; ``api/client.ts``
    only references ``/run-from-db``. New tooling / integrations should
    also target ``/run-from-db``. See ``docs/frame-anchor-architecture.md``
    §16.1 for the deprecation plan around the legacy tracer.

    Returns:
        SolverResult JSON (segments, finalRays, errors, warnings).
    """
    try:
        scene = _to_scene(request.scene)
        rays = [_to_beam_ray(r) for r in request.initial_rays]
    except (ValueError, KeyError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"invalid v3 solver payload: {exc!r}",
        )

    opts = TraceOptions()
    if request.options:
        opts = TraceOptions(
            max_steps=request.options.max_steps,
            power_threshold_mw=request.options.power_threshold_mw,
        )

    # Ensure all v3 ops are registered (eager-import the kinds package).
    from app.optical import kinds  # noqa: F401

    result = solve_v3_scene(scene, rays, opts)
    return result.to_dict()


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

    scene = await load_anchor_scene_from_db(session, request.dynamic_overrides)
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
    the drawn beams, and the trace all use one model (aom_sideband.py)."""
    wavelength_nm: float = 780.0
    center_freq_mhz: float = 80.0
    acoustic_velocity_mps: float = 4200.0
    refractive_index: float = 2.26
    base_efficiency: Optional[float] = 0.85
    figure_of_merit_m2: Optional[float] = None
    rf_drive_power_w: Optional[float] = None
    crystal_length_mm: Optional[float] = None
    acoustic_beam_width_mm: Optional[float] = None
    requires_rf_drive: bool = False
    selected_order: int = 1
    max_diffraction_order: int = 3
    sideband_visibility_threshold: float = 0.01


@router.post("/aom-sidebands")
async def aom_sidebands(req: AomSidebandRequest) -> dict:
    """Per-order AOM sideband table (single source of truth = aom_sideband.py)."""
    import math

    from app.optical.aom_physics import first_order_efficiency
    from app.optical.aom_sideband import (
        phase_modulation_depth,
        sideband_intensities_on_bragg,
    )

    lam = req.wavelength_nm * 1e-9
    f_hz = req.center_freq_mhz * 1e6
    v = req.acoustic_velocity_mps
    theta_b = (
        math.asin(max(-1.0, min(1.0, (lam * f_hz) / (2.0 * v))))
        if (v > 0 and f_hz > 0) else 0.0
    )
    m2 = req.figure_of_merit_m2 if (req.figure_of_merit_m2 and req.figure_of_merit_m2 > 0) else None
    w = req.acoustic_beam_width_mm if (req.acoustic_beam_width_mm and req.acoustic_beam_width_mm > 0) else None
    eta = first_order_efficiency(
        req.wavelength_nm, theta_b,
        rf_power_w=req.rf_drive_power_w,
        m2=m2, l_mm=req.crystal_length_mm, w_mm=w,
        base_efficiency=req.base_efficiency if req.base_efficiency is not None else 0.85,
        requires_rf_drive=req.requires_rf_drive,
    )
    max_order = max(1, min(10, int(req.max_diffraction_order)))
    selected = max(-1, min(1, int(req.selected_order)))
    threshold = max(0.0, min(1.0, req.sideband_visibility_threshold))
    v_depth = phase_modulation_depth(
        figure_of_merit_m2=m2, rf_drive_power_w=req.rf_drive_power_w,
        crystal_length_mm=req.crystal_length_mm, acoustic_beam_width_mm=w,
        wavelength_nm=req.wavelength_nm, theta_b_rad=theta_b, fallback_efficiency=eta,
    )
    intens = sideband_intensities_on_bragg(selected, eta, v_depth, max_order)
    carrier_thz = (299_792_458.0 / lam) / 1e12 if lam > 0 else 0.0
    sidebands = [
        {
            "order": m,
            "angleMrad": m * 2.0 * theta_b * 1e3,
            "frequencyOffsetMhz": m * req.center_freq_mhz,
            "centerFrequencyThz": carrier_thz + m * req.center_freq_mhz * 1e-6,
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
