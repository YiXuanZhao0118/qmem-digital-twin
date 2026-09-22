"""The RF-cable / PPG endpoints' DB side: load the scene slice, run a pure
plan from :mod:`.flows`, apply it in ONE transaction, then broadcast the
same ``/ws/scene`` events the generic routers send.

Where the web app issues several requests (create the cable, then PUT end A,
then PUT end B; create the program, the object, the PhysicsElement, then PUT
the attachment), this writes the FINAL state of all of them in one commit,
so a failure anywhere leaves nothing behind — the rollback the web has to
do by hand (``createPpgAtPort``) is the transaction's.

Locks:

* SceneObject ``locked`` means what it means on ``PUT / DELETE
  /api/objects``: the pose is frozen and the row cannot be deleted; its
  ``properties`` stay writable. So re-snapping / aligning a locked cable
  rewrites its nodes (as the web does), a locked PPG is not re-mounted, and
  a delete that reaches a locked object is refused whole (409) — the web
  would silently skip a locked requested object and 409 on a locked
  cascaded one after deleting the rest.
* No flow writes a Kind / Asset3D / Device / Component row, so the
  ``lock_guard`` rows are never touched.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.models import (
    Asset3D,
    Component,
    ComponentBinding,
    PhysicsElement,
    SceneObject,
    TimingProgram,
)
from app.optical.align.frames import AlignPose
from app.optical.rf_cables import flows
from app.optical.rf_cables.flows import PortRef, RuleError
from app.optical.rf_cables.geometry import AlignmentCandidate
from app.optical.rf_cables.ports import PPG_KIND, RfScene
from app.pose_quantize import quantize_deg, quantize_mm
from app.routers.collections import get_master_collection
from app.routers.objects import (
    InsertedObject,
    broadcast_inserted_object,
    broadcast_removed_object,
    insert_scene_object,
    object_payload,
    remove_scene_object,
)
from app.websocket import manager


async def load_rf_scene(session: AsyncSession) -> RfScene:
    """One read of the scene slice (SELECTs only), in ``GET /api/scene``
    order — objects and components unordered like the snapshot the web app
    iterates, archived Components left out, bindings by (component,
    sort_order, created_at)."""
    objects = (await session.scalars(select(SceneObject))).all()
    components = (await session.scalars(
        select(Component).where(Component.archived_at.is_(None))
    )).all()
    bindings = (await session.scalars(
        select(ComponentBinding).order_by(
            ComponentBinding.component_id,
            ComponentBinding.sort_order,
            ComponentBinding.created_at,
        )
    )).all()
    assets = (await session.scalars(select(Asset3D))).all()
    pes = (await session.scalars(select(PhysicsElement))).all()
    return RfScene(
        objects=list(objects), components=list(components), bindings=list(bindings),
        assets=list(assets), physics_elements=list(pes),
    )


async def _commit_and_broadcast_updates(session: AsyncSession, changed: list[SceneObject]) -> None:
    await session.commit()
    for so in changed:
        await session.refresh(so)
        await manager.broadcast("object.updated", object_payload(so))


# ─── cables ─────────────────────────────────────────────────────────────────

async def connect(
    session: AsyncSession, a: PortRef, b: PortRef, collection_id: uuid.UUID | None,
) -> SceneObject:
    """Create the cable between two ports, both ends linked and mated."""
    # Created-if-absent WITH a commit of its own: do it before anything else
    # is flushed, so it can never commit half of this flow.
    await get_master_collection(session)
    scene = await load_rf_scene(session)
    plan = flows.plan_connect(scene, a, b)
    inserted = await insert_scene_object(session, schemas.SceneObjectCreate(
        component_id=uuid.UUID(plan.component_id),
        collection_id=collection_id,
        x_mm=plan.pose.x_mm, y_mm=plan.pose.y_mm, z_mm=plan.pose.z_mm,
        rx_deg=0, ry_deg=0, rz_deg=0,
        visible=True, locked=False,
        properties=plan.properties,
    ))
    await session.commit()
    await session.refresh(inserted.scene_object)
    if inserted.physics_element is not None:
        await session.refresh(inserted.physics_element)
    await broadcast_inserted_object(inserted)
    return inserted.scene_object


async def resnap(session: AsyncSession, moved_object_ids: list[str]) -> list[SceneObject]:
    """Re-mate every cable end linked to a moved object and re-mount every
    PPG plugged into one (or moved itself). Only rows that actually change
    are written and returned."""
    scene = await load_rf_scene(session)
    changed: list[SceneObject] = []
    for cable_id, props in flows.plan_resnap(scene, moved_object_ids).items():
        so = scene.object_by_id[cable_id]
        if so.properties == props:
            continue
        so.properties = props
        changed.append(so)
    for ppg_id, pose in flows.plan_ppg_mounts(scene, moved_object_ids).items():
        so = scene.object_by_id[ppg_id]
        if pose is None or so.locked:
            continue
        target = {
            "x_mm": quantize_mm(pose.x_mm), "y_mm": quantize_mm(pose.y_mm), "z_mm": quantize_mm(pose.z_mm),
            "rx_deg": quantize_deg(pose.rx_deg), "ry_deg": quantize_deg(pose.ry_deg), "rz_deg": quantize_deg(pose.rz_deg),
        }
        if all(getattr(so, k) == v for k, v in target.items()):
            continue
        for k, v in target.items():
            setattr(so, k, v)
        changed.append(so)
    if changed:
        await _commit_and_broadcast_updates(session, changed)
    return changed


async def align_candidates(
    session: AsyncSession, cable_id: str, end: str, tolerance_mm: float,
) -> list[AlignmentCandidate]:
    """Compute-only: the ports this cable end could snap to."""
    scene = await load_rf_scene(session)
    return flows.align_candidates(scene, cable_id, end, tolerance_mm)


async def align(
    session: AsyncSession, cable_id: str, end: str, target: PortRef, tolerance_mm: float,
) -> SceneObject:
    """Snap one cable end onto a port among its candidates and link it."""
    scene = await load_rf_scene(session)
    props = flows.plan_align(scene, cable_id, end, target, tolerance_mm)
    so = scene.object_by_id[cable_id]
    so.properties = props
    await _commit_and_broadcast_updates(session, [so])
    return so


@dataclass
class Deleted:
    object_ids: list[str]
    timing_program_ids: list[str]


async def _delete_cascade(session: AsyncSession, scene: RfScene, object_ids: list[str]) -> Deleted:
    """``deleteObjects`` in one transaction: plan the cascade, refuse it
    whole if any doomed object is locked, delete, commit, broadcast."""
    for oid in object_ids:
        so = scene.object_by_id[oid]
        if so.locked:
            raise RuleError("locked", f"{so.name} is locked. Unlock it before removing it.", 409)
    doomed = flows.plan_delete_objects(scene, object_ids)
    locked = [scene.object_by_id[d].name for d in doomed if scene.object_by_id[d].locked]
    if locked:
        raise RuleError(
            "locked",
            f"Removing it would also delete locked object(s) {', '.join(locked)}; unlock them first.",
            409,
        )
    removed = [await remove_scene_object(session, scene.object_by_id[d]) for d in doomed]
    await session.commit()
    for r in removed:
        await broadcast_removed_object(r)
    return Deleted(
        object_ids=doomed,
        timing_program_ids=[str(r.cascaded_program_id) for r in removed if r.program_deleted],
    )


async def disconnect(session: AsyncSession, cable_id: str, end: str) -> tuple[SceneObject | None, Deleted]:
    """``clearRfCableEndpointLink``: unlinking either end removes the cable
    (and a legacy PPG it orphans). An end with no link is a no-op that
    returns the cable untouched."""
    scene = await load_rf_scene(session)
    if flows.disconnect_link(scene, cable_id, end) is None:
        return scene.object_by_id[cable_id], Deleted([], [])
    return None, await _delete_cascade(session, scene, [cable_id])


# ─── PPGs ───────────────────────────────────────────────────────────────────

async def _write_ppg_element(
    session: AsyncSession, scene_object: SceneObject, existing: PhysicsElement | None, kind_params: dict,
) -> PhysicsElement:
    """What ``updateOpticalElementApi`` (falling back to create) does with
    the PPG's kindParams: the same schema normalisation and TimingProgram
    binding check as ``PUT / POST /api/physics-elements``."""
    from app.routers.physics_elements import _validate_ppg_timing_binding

    if existing is not None:
        merged = schemas.OpticalElementBase(
            element_kind=PPG_KIND,
            wavelength_range_nm=tuple(existing.wavelength_range_nm),
            input_ports=existing.input_ports or [],
            output_ports=existing.output_ports or [],
            kind_params=kind_params,
        )
        existing.element_kind = merged.element_kind
        existing.wavelength_range_nm = list(merged.wavelength_range_nm)
        existing.input_ports = [p.model_dump(by_alias=True) for p in merged.input_ports]
        existing.output_ports = [p.model_dump(by_alias=True) for p in merged.output_ports]
        await _validate_ppg_timing_binding(
            session, object_id=scene_object.id, element_kind=merged.element_kind, kind_params=merged.kind_params,
        )
        existing.kind_params = merged.kind_params
        return existing
    create = schemas.OpticalElementCreate(object_id=scene_object.id, element_kind=PPG_KIND, kind_params=kind_params)
    data = create.model_dump(by_alias=False)
    data["input_ports"] = [p.model_dump(by_alias=True) for p in create.input_ports]
    data["output_ports"] = [p.model_dump(by_alias=True) for p in create.output_ports]
    data["wavelength_range_nm"] = list(create.wavelength_range_nm)
    await _validate_ppg_timing_binding(
        session, object_id=scene_object.id, element_kind=data["element_kind"], kind_params=data["kind_params"],
    )
    element = PhysicsElement(**data)
    session.add(element)
    return element


@dataclass
class Attached:
    scene_object: SceneObject
    timing_program: TimingProgram
    mounted: bool


async def ppg_attach(session: AsyncSession, target: PortRef, collection_id: uuid.UUID | None) -> Attached:
    """``createPpgAtPort``: a new PPG (``CH<n>``) with its own TimingProgram,
    plugged into ``target`` and standing at its mounted pose. When the mount
    does not resolve (the target's port is not on its primary asset — a
    multi-root instrument), the PPG stands at the target object's pose and
    ``mounted`` is false; the web would leave it at the 3D cursor."""
    await get_master_collection(session)  # see connect()
    scene = await load_rf_scene(session)
    plan = flows.plan_ppg_attach(scene, target)
    program = TimingProgram(name=plan.program_name, intervals=[])
    session.add(program)
    await session.flush()

    pose: Any = plan.mounted_pose
    if pose is None:
        target_obj = scene.object_by_id[plan.attachment["targetObjectId"]]
        pose = AlignPose(
            x_mm=target_obj.x_mm, y_mm=target_obj.y_mm, z_mm=target_obj.z_mm,
            rx_deg=target_obj.rx_deg, ry_deg=target_obj.ry_deg, rz_deg=target_obj.rz_deg,
        )
    inserted = await insert_scene_object(session, schemas.SceneObjectCreate(
        name=plan.name,
        component_id=uuid.UUID(plan.component_id),
        collection_id=collection_id,
        x_mm=pose.x_mm, y_mm=pose.y_mm, z_mm=pose.z_mm,
        rx_deg=pose.rx_deg, ry_deg=pose.ry_deg, rz_deg=pose.rz_deg,
        visible=True, locked=False,
        properties={"ppgAttachment": plan.attachment},
    ))
    element = await _write_ppg_element(
        session, inserted.scene_object, inserted.physics_element,
        flows.ppg_kind_params(plan.connector_type, str(program.id)),
    )
    await session.commit()
    await session.refresh(program)
    await session.refresh(inserted.scene_object)
    await session.refresh(element)
    await manager.broadcast(
        "timing_program.updated",
        schemas.TimingProgramOut.model_validate(program).model_dump(mode="json", by_alias=True),
    )
    await broadcast_inserted_object(InsertedObject(inserted.scene_object, inserted.collection_id, element))
    return Attached(inserted.scene_object, program, plan.mounted_pose is not None)


async def ppg_detach(session: AsyncSession, ppg_id: str) -> Deleted:
    """The RF Link panel's "Disconnect" on a PPG: delete it (its
    TimingProgram goes with it), via the web's delete cascade."""
    scene = await load_rf_scene(session)
    ppg = scene.object_by_id.get(ppg_id)
    if ppg is None:
        raise RuleError("object_not_found", f"SceneObject {ppg_id} not found.", 404)
    if scene.kind_of(ppg_id) != PPG_KIND:
        raise RuleError("not_a_ppg", f"{ppg.name} is not a Programmable Pulse Generator.")
    return await _delete_cascade(session, scene, [ppg_id])
