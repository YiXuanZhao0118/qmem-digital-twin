"""Ray Tracer v3 — face-based dispatch (Python mirror of frontend ray-tracer-v3.ts).

Supports single-asset tracing (Phase 3a) and scene-level tracing with
lab↔body transforms (Phase 3b).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional

from app.optical.beam_ray import BeamRay, Vec3, make_beam_ray, vec3_distance
from app.optical.jones import jones_body_to_lab, jones_lab_to_body
from app.optical.pose import (
    V3Pose,
    V3Transform,
    compose_transforms,
    dir_body_to_lab,
    dir_body_to_lab_t,
    dir_lab_to_body,
    dir_lab_to_body_t,
    point_body_to_lab,
    point_body_to_lab_t,
    point_lab_to_body,
    point_lab_to_body_t,
    pose_to_transform,
)
from app.optical.registry import Face, PhysicsOpContext, get_op


# ---------------------------------------------------------------------------
# Asset snapshot
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class V3TransitionDescriptor:
    in_face: str
    out_face: str | list[str]
    op: str
    params: Optional[dict] = None
    matrix5x5: Optional[list[list[float]]] = None
    abcd: Optional[list[list[float]]] = None
    # Multi-hop reflective chain (see asset-physics-model.md §3.3). Tuple
    # of face ids the beam traverses between ``in_face`` and ``out_face``.
    # Empty = 2-port slab; non-empty for PBS / BS / Glan-Laser / dichroic.
    via: tuple[str, ...] = ()


@dataclass(frozen=True)
class V3AssetSnapshot:
    catalog_id: str
    kind: str
    faces: list[Face]
    transitions: list[V3TransitionDescriptor]
    default_params: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Face hit
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class FaceHit:
    face: Face
    t: float
    point: Vec3


def intersect_face(
    origin: Vec3, direction: Vec3, face: Face,
    *, t_min: float = 1e-9, exclude_face_id: Optional[str] = None,
) -> Optional[FaceHit]:
    if exclude_face_id == face.id:
        return None
    n = face.normal_body_local or Vec3(0, 0, 1)
    denom = direction.dot(n)
    if abs(denom) < 1e-12:
        return None
    diff = face.position_mm_body_local - origin
    t = diff.dot(n) / denom
    if t < t_min:
        return None
    hit = origin + direction * t

    offset = hit - face.position_mm_body_local
    off_dot = offset.dot(n)
    off_perp = offset - n * off_dot
    r = math.sqrt(off_perp.dot(off_perp))
    if r > face.aperture_mm + 1e-9:
        return None

    return FaceHit(face=face, t=t, point=hit)


def nearest_face_hit(
    ray: BeamRay, asset: V3AssetSnapshot, exclude_face_id: Optional[str] = None,
) -> Optional[FaceHit]:
    best: Optional[FaceHit] = None
    for face in asset.faces:
        hit = intersect_face(
            ray.origin, ray.direction, face, exclude_face_id=exclude_face_id
        )
        if hit and (best is None or hit.t < best.t):
            best = hit
    return best


# ---------------------------------------------------------------------------
# Transition dispatch helpers
# ---------------------------------------------------------------------------

def _build_contexts(
    asset: V3AssetSnapshot, transition: V3TransitionDescriptor, face_in: Face,
) -> list[PhysicsOpContext]:
    out_ids = transition.out_face if isinstance(transition.out_face, list) else [transition.out_face]
    merged = {**asset.default_params, **(transition.params or {})}
    via_faces: list[Face] = []
    for via_id in transition.via:
        f = next((f for f in asset.faces if f.id == via_id), None)
        if f is None:
            raise ValueError(
                f'transition references unknown via face id "{via_id}" '
                f'on asset "{asset.catalog_id}"'
            )
        via_faces.append(f)
    contexts: list[PhysicsOpContext] = []
    for out_id in out_ids:
        face_out = next((f for f in asset.faces if f.id == out_id), None)
        if face_out is None:
            raise ValueError(
                f'transition references unknown face id "{out_id}" '
                f'on asset "{asset.catalog_id}"'
            )
        contexts.append(PhysicsOpContext(
            face_in=face_in,
            face_out=face_out,
            params=merged,
            face_via=tuple(via_faces),
        ))
    return contexts


def _find_transition_contexts(
    asset: V3AssetSnapshot, face_in: Face,
) -> list[tuple[str, PhysicsOpContext]]:
    matches: list[tuple[str, PhysicsOpContext]] = []
    for t in asset.transitions:
        if t.in_face != face_in.id:
            continue
        for ctx in _build_contexts(asset, t, face_in):
            matches.append((t.op, ctx))
    return matches


# ---------------------------------------------------------------------------
# Trace results
# ---------------------------------------------------------------------------

@dataclass
class TraceStep:
    asset: V3AssetSnapshot
    face_in: Face
    ray_in: BeamRay
    out_rays: list[BeamRay]
    op: str


@dataclass
class TraceResult:
    final_rays: list[BeamRay]
    steps: list[TraceStep]
    terminated: str   # 'escaped' | 'max_steps' | 'power_threshold'


@dataclass(frozen=True)
class TraceOptions:
    max_steps: int = 32
    power_threshold_mw: float = 1e-9


# ---------------------------------------------------------------------------
# Single-asset trace (Phase 3a)
# ---------------------------------------------------------------------------

def trace_ray_through_asset(
    initial_ray: BeamRay,
    asset: V3AssetSnapshot,
    options: TraceOptions = TraceOptions(),
) -> TraceResult:
    final_rays: list[BeamRay] = []
    steps: list[TraceStep] = []
    queue: list[BeamRay] = [initial_ray]
    total_steps = 0
    terminated = "escaped"

    while queue:
        if total_steps >= options.max_steps:
            terminated = "max_steps"
            final_rays.extend(queue)
            break

        ray = queue.pop(0)
        if ray.power_mw < options.power_threshold_mw:
            terminated = "power_threshold"
            continue

        hit = nearest_face_hit(ray, asset, ray.exclude_face_key)
        if hit is None:
            final_rays.append(ray)
            continue

        matches = _find_transition_contexts(asset, hit.face)
        if not matches:
            final_rays.append(ray.replaced(power_mw=0))
            continue

        # Free-space q propagation: q' = q + L (the [[1, L], [0, 1]] ABCD).
        ray_at_face = ray.replaced(
            origin=hit.point,
            qx=complex(ray.qx.real + hit.t, ray.qx.imag),
            qy=complex(ray.qy.real + hit.t, ray.qy.imag),
            path_length_mm=ray.path_length_mm + hit.t,
        )

        step_out_rays: list[BeamRay] = []
        for op_name, ctx in matches:
            op = get_op(asset.kind, op_name)
            for out_ray in op(ray_at_face, ctx):
                step_out_rays.append(out_ray)
                tagged = out_ray.replaced(exclude_face_key=ctx.face_out.id)
                if tagged.power_mw < options.power_threshold_mw:
                    final_rays.append(tagged)
                else:
                    queue.append(tagged)

        steps.append(TraceStep(
            asset=asset, face_in=hit.face,
            ray_in=ray_at_face, out_rays=step_out_rays,
            op=matches[0][0],
        ))
        total_steps += 1

    return TraceResult(final_rays=final_rays, steps=steps, terminated=terminated)


# ---------------------------------------------------------------------------
# Scene-level trace (Phase 3b)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class V3ComponentBinding:
    binding_id: str
    asset: V3AssetSnapshot
    local_pose: V3Pose


@dataclass(frozen=True)
class V3ComponentSnapshot:
    catalog_id: str
    bindings: list[V3ComponentBinding]


@dataclass(frozen=True)
class V3SceneObject:
    id: str
    pose: V3Pose
    asset: Optional[V3AssetSnapshot] = None
    component: Optional[V3ComponentSnapshot] = None
    dynamic_sources: Optional[dict] = None


@dataclass(frozen=True)
class V3Scene:
    objects: list[V3SceneObject]


@dataclass(frozen=True)
class V3BindingSlot:
    scene_object_id: str
    binding_id: str               # "" for single-asset SceneObjects
    asset: V3AssetSnapshot
    effective_transform: V3Transform
    dynamic_sources: Optional[dict] = None


def flatten_scene(scene: V3Scene) -> list[V3BindingSlot]:
    slots: list[V3BindingSlot] = []
    for so in scene.objects:
        t_so = pose_to_transform(so.pose)
        if so.asset is not None:
            slots.append(V3BindingSlot(
                scene_object_id=so.id, binding_id="",
                asset=so.asset, effective_transform=t_so,
                dynamic_sources=so.dynamic_sources,
            ))
        if so.component is not None:
            for b in so.component.bindings:
                t_b = pose_to_transform(b.local_pose)
                slots.append(V3BindingSlot(
                    scene_object_id=so.id, binding_id=b.binding_id,
                    asset=b.asset,
                    effective_transform=compose_transforms(t_so, t_b),
                    dynamic_sources=so.dynamic_sources,
                ))
    return slots


@dataclass
class _SceneHit:
    slot: V3BindingSlot
    face: Face
    t_lab: float
    hit_body: Vec3


def _encode_exclude_slot(scene_object_id: str, binding_id: str, face_id: str) -> str:
    return f"{scene_object_id}/{binding_id}/{face_id}"


def _decode_exclude_for_slot(
    key: Optional[str], scene_object_id: str, binding_id: str,
) -> Optional[str]:
    if not key:
        return None
    prefix = f"{scene_object_id}/{binding_id}/"
    return key[len(prefix):] if key.startswith(prefix) else None


def _nearest_scene_hit(
    ray_lab: BeamRay, slots: list[V3BindingSlot],
) -> Optional[_SceneHit]:
    best: Optional[_SceneHit] = None
    for slot in slots:
        origin_body = point_lab_to_body_t(ray_lab.origin, slot.effective_transform)
        dir_body = dir_lab_to_body_t(ray_lab.direction, slot.effective_transform)
        exclude = _decode_exclude_for_slot(
            ray_lab.exclude_face_key, slot.scene_object_id, slot.binding_id,
        )
        for face in slot.asset.faces:
            hit = intersect_face(
                origin_body, dir_body, face, exclude_face_id=exclude,
            )
            if hit is None:
                continue
            if best is None or hit.t < best.t_lab:
                best = _SceneHit(
                    slot=slot, face=face,
                    t_lab=hit.t, hit_body=hit.point,
                )
    return best


def _source_dummy_ray(ctx: PhysicsOpContext) -> BeamRay:
    wavelength_nm = (
        (ctx.dynamic or {}).get("centerWavelengthNm")
        if isinstance((ctx.dynamic or {}).get("centerWavelengthNm"), (int, float))
        else ctx.params.get("centerWavelengthNm")
        if isinstance(ctx.params.get("centerWavelengthNm"), (int, float))
        else 780.241
    )
    return make_beam_ray(
        origin=ctx.face_in.position_mm_body_local,
        direction=ctx.face_out.normal_body_local or Vec3(0, 0, 1),
        wavelength_nm=float(wavelength_nm),
        power_mw=0.0,
    )


def emit_scene_source_rays(scene: V3Scene) -> list[BeamRay]:
    """Emit rays from all laser_source scene objects.

    Source assets are emitters, so they do not wait for an incoming ray to
    intersect a face.
    """
    rays: list[BeamRay] = []
    for slot in flatten_scene(scene):
        if slot.asset.kind != "laser_source":
            continue
        for face in slot.asset.faces:
            matches = [
                (op_name, ctx)
                for op_name, ctx in _find_transition_contexts(slot.asset, face)
                if op_name == "emit_laser_source"
            ]
            for op_name, ctx in matches:
                op = get_op(slot.asset.kind, op_name)
                ctx_with_dynamic = ctx
                if slot.dynamic_sources:
                    ctx_with_dynamic = PhysicsOpContext(
                        face_in=ctx.face_in,
                        face_out=ctx.face_out,
                        params=ctx.params,
                        dynamic={**(ctx.dynamic or {}), **slot.dynamic_sources},
                    )
                for ray_body in op(_source_dummy_ray(ctx_with_dynamic), ctx_with_dynamic):
                    out_dir_lab = dir_body_to_lab_t(ray_body.direction, slot.effective_transform)
                    jones_lab = jones_body_to_lab(
                        ray_body.jones, ray_body.direction, out_dir_lab,
                        lambda v: dir_body_to_lab_t(v, slot.effective_transform),
                    )
                    rays.append(ray_body.replaced(
                        origin=point_body_to_lab_t(ray_body.origin, slot.effective_transform),
                        direction=out_dir_lab,
                        jones=jones_lab,
                        exclude_face_key=_encode_exclude_slot(
                            slot.scene_object_id, slot.binding_id, ctx.face_out.id,
                        ),
                    ))
    return rays


def trace_ray_scene(
    initial_ray: BeamRay,
    scene: V3Scene,
    options: TraceOptions = TraceOptions(),
) -> TraceResult:
    slots = flatten_scene(scene)
    final_rays: list[BeamRay] = []
    steps: list[TraceStep] = []
    queue: list[BeamRay] = [initial_ray]
    total_steps = 0
    terminated = "escaped"

    while queue:
        if total_steps >= options.max_steps:
            terminated = "max_steps"
            final_rays.extend(queue)
            break

        ray = queue.pop(0)
        if ray.power_mw < options.power_threshold_mw:
            terminated = "power_threshold"
            continue

        hit = _nearest_scene_hit(ray, slots)
        if hit is None:
            final_rays.append(ray)
            continue

        slot = hit.slot
        dir_body = dir_lab_to_body_t(ray.direction, slot.effective_transform)
        # Free-space q propagation: q' = q + L
        # Jones basis lab → body (Phase 4c).
        jones_body = jones_lab_to_body(
            ray.jones, ray.direction, dir_body,
            lambda v: dir_lab_to_body_t(v, slot.effective_transform),
        )
        ray_at_face_body = ray.replaced(
            origin=hit.hit_body,
            direction=dir_body,
            jones=jones_body,
            qx=complex(ray.qx.real + hit.t_lab, ray.qx.imag),
            qy=complex(ray.qy.real + hit.t_lab, ray.qy.imag),
            path_length_mm=ray.path_length_mm + hit.t_lab,
        )

        matches = _find_transition_contexts(slot.asset, hit.face)
        if not matches:
            final_rays.append(ray.replaced(power_mw=0))
            continue

        step_out_rays: list[BeamRay] = []
        for op_name, ctx in matches:
            op = get_op(slot.asset.kind, op_name)
            ctx_with_dynamic = ctx
            if slot.dynamic_sources:
                merged_dynamic = {**(ctx.dynamic or {}), **slot.dynamic_sources}
                ctx_with_dynamic = PhysicsOpContext(
                    face_in=ctx.face_in,
                    face_out=ctx.face_out,
                    params=ctx.params,
                    dynamic=merged_dynamic,
                )
            for out_ray_body in op(ray_at_face_body, ctx_with_dynamic):
                step_out_rays.append(out_ray_body)
                out_dir_lab = dir_body_to_lab_t(out_ray_body.direction, slot.effective_transform)
                jones_lab = jones_body_to_lab(
                    out_ray_body.jones, out_ray_body.direction, out_dir_lab,
                    lambda v: dir_body_to_lab_t(v, slot.effective_transform),
                )
                out_ray_lab = out_ray_body.replaced(
                    origin=point_body_to_lab_t(out_ray_body.origin, slot.effective_transform),
                    direction=out_dir_lab,
                    jones=jones_lab,
                    exclude_face_key=_encode_exclude_slot(
                        slot.scene_object_id, slot.binding_id, ctx.face_out.id,
                    ),
                )
                if out_ray_lab.power_mw < options.power_threshold_mw:
                    final_rays.append(out_ray_lab)
                else:
                    queue.append(out_ray_lab)

        steps.append(TraceStep(
            asset=slot.asset, face_in=hit.face,
            ray_in=ray_at_face_body, out_rays=step_out_rays,
            op=matches[0][0],
        ))
        total_steps += 1

    return TraceResult(final_rays=final_rays, steps=steps, terminated=terminated)
