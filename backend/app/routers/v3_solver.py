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

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.optical.beam_ray import BeamRay, Vec3, make_beam_ray
from app.optical.ray_tracer_v3 import (
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
from app.optical.solver_v3 import solve_v3_scene
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

@router.post("/run")
async def run_v3_solver(request: SolverRunRequest) -> dict:
    """Run v3 ray tracer on caller-supplied scene + initial rays.

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
