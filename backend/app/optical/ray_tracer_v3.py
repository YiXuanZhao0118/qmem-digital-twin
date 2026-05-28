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
    binding_pose_to_transform,
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
class LabSegment:
    """One straight beam segment between hits, in LAB frame coords.

    Built by ``trace_ray_scene`` for rendering: each dequeued ray's
    origin → its nearest face hit (or escape point) becomes one
    segment. Carries enough metadata for the viewer to colour by
    wavelength + opacity by power, and to look up which asset/face the
    segment terminated on.

    Phase 7.1: also carries the SceneObject IDs of the emitter
    (laser_source / TA) and source (previously-hit asset that fired
    this ray) so the OpticalLinkViewerPanel can adapt v3 segments to
    its TraceSegment shape without recomputing chains.
    """
    start: Vec3
    end: Vec3
    wavelength_nm: float
    power_mw: float
    scene_object_id: str | None       # which SceneObject the segment ends on (None on escape)
    binding_id: str | None
    asset_catalog_id: str | None
    face_in_id: str | None
    op: str | None                    # op fired at the hit face (None on escape)
    is_terminal: bool                 # True = escape, sink-absorption, or zero-power continuation
    # Phase 7.1: chain provenance.
    emitter_scene_object_id: str | None = None  # original laser_source / TA that started this branch
    source_scene_object_id: str | None = None   # asset that fired the ray carrying this segment
    jones_re_x: float = 1.0   # Polarisation at segment start: Re(E_x)
    jones_im_x: float = 0.0
    jones_re_y: float = 0.0
    jones_im_y: float = 0.0
    qx_re_at_start: float = 0.0
    qx_im_at_start: float = 0.0
    qy_re_at_start: float = 0.0
    qy_im_at_start: float = 0.0
    path_length_mm_at_start: float = 0.0


@dataclass
class TraceResult:
    final_rays: list[BeamRay]
    steps: list[TraceStep]
    terminated: str   # 'escaped' | 'max_steps' | 'power_threshold'
    lab_segments: list[LabSegment] = field(default_factory=list)


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
    lab_segments: list[LabSegment] = []
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

    return TraceResult(
        final_rays=final_rays, steps=steps,
        terminated=terminated, lab_segments=lab_segments,
    )


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
                # Binding pose uses the RAW XYZ rotation, not the object
                # pose's YXZ lab->three remap — see binding_pose_to_transform
                # + db_scene_loader.load_anchor_scene_from_db. (This V3Scene
                # face path is currently unused — load_scene_from_db has no
                # caller — but kept consistent with the live anchor path.)
                t_b = binding_pose_to_transform(b.local_pose)
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
    """Emit rays from all laser_source scene objects (legacy variant).

    Kept for back-compat; new code should call
    :func:`emit_scene_source_rays_with_provenance` to also receive the
    emitting SceneObject id (needed for chain rendering in v3 panels).
    """
    return [r for r, _emitter, _source in emit_scene_source_rays_with_provenance(scene)]


def emit_scene_source_rays_with_provenance(
    scene: V3Scene,
) -> list[tuple[BeamRay, str, str]]:
    """Emit rays from all laser_source / TA scene objects, paired with
    their (emitter_scene_object_id, source_scene_object_id).

    For a fresh emit both ids equal the emitter slot's scene_object_id;
    they diverge later as the chain propagates (emitter stays constant,
    source becomes the last-hit slot).
    """
    out: list[tuple[BeamRay, str, str]] = []
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
                    ray_lab = ray_body.replaced(
                        origin=point_body_to_lab_t(ray_body.origin, slot.effective_transform),
                        direction=out_dir_lab,
                        jones=jones_lab,
                        exclude_face_key=_encode_exclude_slot(
                            slot.scene_object_id, slot.binding_id, ctx.face_out.id,
                        ),
                    )
                    out.append((ray_lab, slot.scene_object_id, slot.scene_object_id))
    return out


def trace_ray_scene(
    initial_ray: BeamRay,
    scene: V3Scene,
    options: TraceOptions = TraceOptions(),
    *,
    escape_distance_mm: float = 1000.0,
    emitter_scene_object_id: str | None = None,
    source_scene_object_id: str | None = None,
) -> TraceResult:
    """Trace one initial ray through the scene; build TraceResult.

    Phase 7.1: ``emitter_scene_object_id`` / ``source_scene_object_id``
    are threaded through the BFS queue so each LabSegment carries the
    chain provenance. Callers that have the emitter id (e.g.
    ``solve_v3_scene`` using ``emit_scene_source_rays_with_provenance``)
    pass it in; callers with arbitrary rays leave them None.
    """
    slots = flatten_scene(scene)
    final_rays: list[BeamRay] = []
    steps: list[TraceStep] = []
    lab_segments: list[LabSegment] = []
    # Queue items: (ray, source_obj_id, emitter_obj_id). source updates
    # to the last-hit slot as the chain propagates; emitter is constant.
    queue: list[tuple[BeamRay, str | None, str | None]] = [
        (initial_ray, source_scene_object_id, emitter_scene_object_id),
    ]
    total_steps = 0
    terminated = "escaped"

    while queue:
        if total_steps >= options.max_steps:
            terminated = "max_steps"
            final_rays.extend(r for r, _s, _e in queue)
            break

        ray, source_obj_id, emitter_obj_id = queue.pop(0)
        if ray.power_mw < options.power_threshold_mw:
            terminated = "power_threshold"
            continue

        hit = _nearest_scene_hit(ray, slots)
        if hit is None:
            # Escape: render a tail of `escape_distance_mm` so the user
            # sees where the beam was heading even without a target.
            tail_end = Vec3(
                ray.origin.x + ray.direction.x * escape_distance_mm,
                ray.origin.y + ray.direction.y * escape_distance_mm,
                ray.origin.z + ray.direction.z * escape_distance_mm,
            )
            lab_segments.append(LabSegment(
                start=ray.origin, end=tail_end,
                wavelength_nm=ray.wavelength_nm, power_mw=ray.power_mw,
                scene_object_id=None, binding_id=None,
                asset_catalog_id=None, face_in_id=None, op=None,
                is_terminal=True,
                emitter_scene_object_id=emitter_obj_id,
                source_scene_object_id=source_obj_id,
                jones_re_x=ray.jones[0].real, jones_im_x=ray.jones[0].imag,
                jones_re_y=ray.jones[1].real, jones_im_y=ray.jones[1].imag,
                qx_re_at_start=ray.qx.real, qx_im_at_start=ray.qx.imag,
                qy_re_at_start=ray.qy.real, qy_im_at_start=ray.qy.imag,
                path_length_mm_at_start=ray.path_length_mm,
            ))
            final_rays.append(ray)
            continue

        slot = hit.slot
        # Lab-frame hit point (for rendering — needed before we go body-side).
        hit_lab = point_body_to_lab_t(hit.hit_body, slot.effective_transform)

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
            # Sink: ray reached a face with no defined transition (e.g.
            # detector / beam_dump). Render this leg, then terminate.
            lab_segments.append(LabSegment(
                start=ray.origin, end=hit_lab,
                wavelength_nm=ray.wavelength_nm, power_mw=ray.power_mw,
                scene_object_id=slot.scene_object_id,
                binding_id=slot.binding_id,
                asset_catalog_id=slot.asset.catalog_id,
                face_in_id=hit.face.id,
                op=None,
                is_terminal=True,
                emitter_scene_object_id=emitter_obj_id,
                source_scene_object_id=source_obj_id,
                jones_re_x=ray.jones[0].real, jones_im_x=ray.jones[0].imag,
                jones_re_y=ray.jones[1].real, jones_im_y=ray.jones[1].imag,
                qx_re_at_start=ray.qx.real, qx_im_at_start=ray.qx.imag,
                qy_re_at_start=ray.qy.real, qy_im_at_start=ray.qy.imag,
                path_length_mm_at_start=ray.path_length_mm,
            ))
            final_rays.append(ray.replaced(power_mw=0))
            continue

        # Render the segment that brought us to this hit. Subsequent
        # out_rays will spawn their own segments when they're dequeued.
        lab_segments.append(LabSegment(
            start=ray.origin, end=hit_lab,
            wavelength_nm=ray.wavelength_nm, power_mw=ray.power_mw,
            scene_object_id=slot.scene_object_id,
            binding_id=slot.binding_id,
            asset_catalog_id=slot.asset.catalog_id,
            face_in_id=hit.face.id,
            op=matches[0][0],
            is_terminal=False,
            emitter_scene_object_id=emitter_obj_id,
            source_scene_object_id=source_obj_id,
            jones_re_x=ray.jones[0].real, jones_im_x=ray.jones[0].imag,
            jones_re_y=ray.jones[1].real, jones_im_y=ray.jones[1].imag,
            qx_re_at_start=ray.qx.real, qx_im_at_start=ray.qx.imag,
            qy_re_at_start=ray.qy.real, qy_im_at_start=ray.qy.imag,
            path_length_mm_at_start=ray.path_length_mm,
        ))

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
                    # Source for the next segment = the slot we just
                    # passed through; emitter unchanged.
                    queue.append((out_ray_lab, slot.scene_object_id, emitter_obj_id))

        steps.append(TraceStep(
            asset=slot.asset, face_in=hit.face,
            ray_in=ray_at_face_body, out_rays=step_out_rays,
            op=matches[0][0],
        ))
        total_steps += 1

    return TraceResult(
        final_rays=final_rays, steps=steps,
        terminated=terminated, lab_segments=lab_segments,
    )
