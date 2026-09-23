"""``POST /api/v3/objects/delete`` — deleting objects with the whole cascade,
for every client, the web app's ``sceneStore.deleteObjects`` included.

The web app used to work the cascade out in the browser from its scene
snapshot and fire one ``DELETE /api/objects/{id}`` per row; wave 3b pointed it
at this endpoint and deleted that code. The cascade runs over the DB scene, in
one transaction:

1. the requested objects, de-duplicated, minus the ``locked`` ones (the web
   skips those silently; here they come back in ``refused``);
2. every object whose ``properties.rfCableEndpoints`` A or B names a doomed
   object (a cable is deleted, not unlinked: "a cable either joins two ports
   or does not exist");
3. every PPG plugged into a doomed object (``properties.ppgAttachment``);
4. every LEGACY PPG (one still wired through rf_cables) whose rf_cables are
   all doomed — skipped when it has none (the ``cables.length === 0`` guard,
   ``docs/introduce/rf.md`` §7) — steps 2-4 run to a FIXPOINT, so the answer
   does not depend on the order the rows come back in
   (:func:`flows.plan_delete_objects`);
5. through ``remove_scene_object`` (``routers/objects.py``, what ``DELETE
   /api/objects/{id}`` runs): each object's PhysicsElement, and a PPG's
   bound TimingProgram; the database's FK cascades take its ObjectBindings,
   collection membership, assembly relations, device state and links.

Steps 1-4 are ``flows.plan_delete_objects`` (``app/optical/rf_cables/
flows.py``), the one implementation of the cascade, which the RF-cable
disconnect and PPG detach endpoints use too. ``backend/tests/fixtures/
delete/`` are the golden fixtures the real TypeScript wrote before wave 3b
deleted it: a change to the cascade must be a deliberate fixture update.

Not touched: fibres and pigtails linked to a doomed object keep their (now
dangling) ``fiberEndpoints`` / ``pigtailEndpoints`` link; nothing is gated by
kind — an rf_cable or PPG is deleted when the cascade reaches it, or when it
is asked for by name (RF Link's Disconnect does exactly that), even though
the web hides both from the Outliner and from the Delete key.

Where this departs from the cascade the browser used to run, because it is
one transaction and that was N parallel DELETEs:

* a doomed object that is ``locked`` but was not skipped as a request (a
  cable, PPG, ... the cascade reaches) made the browser's DELETE for it 409
  AFTER the others went through; here the whole request is refused with
  409 and nothing is deleted;
* a requested id with no row is "already gone", which the browser counted as
  success (a 404 is the outcome it wanted): it is listed in
  ``deletedObjectIds`` (after the real ones), nothing cascades from it and
  nothing is broadcast for it (whoever deleted it did).
"""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import TimingProgram
from app.optical.rf_cables import flows
from app.optical.rf_cables.flows import RuleError
from app.optical.rf_cables.ports import RfScene
from app.optical.rf_cables.service import load_rf_scene
from app.routers.objects import (
    bound_timing_program_id,
    broadcast_removed_object,
    remove_scene_object,
)

LOCKED = "locked"


@dataclass(frozen=True)
class Refusal:
    object_id: str
    reason: str


@dataclass(frozen=True)
class DeletePlan:
    # ``deleteObjects``' doomed set, in the order the web issues the DELETEs.
    object_ids: list[str]
    # The TimingPrograms those deletes take along (bound to a doomed PPG and
    # existing), each once.
    timing_program_ids: list[str]
    # Requested objects that stay: the ``locked`` ones, in request order.
    refused: list[Refusal]
    # Requested ids that name no object (already deleted).
    already_gone: list[str]
    # Doomed objects that are ``locked`` — any makes the request a 409.
    locked_in_cascade: list[str]


def plan_delete(
    scene: RfScene, object_ids: list[str], existing_program_ids: Collection[str],
) -> DeletePlan:
    """Pure: what deleting ``object_ids`` does to ``scene``."""
    requested = list(dict.fromkeys(object_ids))
    doomed = flows.plan_delete_objects(scene, requested)
    refused = [
        Refusal(oid, LOCKED)
        for oid in requested
        if oid in scene.object_by_id and scene.object_by_id[oid].locked
    ]
    already_gone = [oid for oid in requested if oid not in scene.object_by_id]
    programs: list[str] = []
    for oid in doomed:
        tp = bound_timing_program_id(scene.pe_by_object.get(oid))
        if tp is not None and str(tp) in existing_program_ids and str(tp) not in programs:
            programs.append(str(tp))
    return DeletePlan(
        object_ids=doomed,
        timing_program_ids=programs,
        refused=refused,
        already_gone=already_gone,
        locked_in_cascade=[oid for oid in doomed if scene.object_by_id[oid].locked],
    )


@dataclass(frozen=True)
class DeleteOutcome:
    deleted_object_ids: list[str]
    deleted_timing_program_ids: list[str]
    refused: list[Refusal]


async def delete_objects(session: AsyncSession, object_ids: list[str], *, dry_run: bool) -> DeleteOutcome:
    """Plan the cascade over the DB scene; refuse it whole (409 ``locked``)
    if it reaches a locked object; unless ``dry_run``, delete every doomed
    row, commit once, then broadcast the ``DELETE /api/objects/{id}``
    events per row. A dry run answers exactly what the real call would."""
    scene = await load_rf_scene(session)
    existing_programs = {str(i) for i in (await session.scalars(select(TimingProgram.id))).all()}
    plan = plan_delete(scene, object_ids, existing_programs)
    if plan.locked_in_cascade:
        names = ", ".join(f"{scene.object_by_id[oid].name} ({oid})" for oid in plan.locked_in_cascade)
        raise RuleError(
            LOCKED,
            f"deleting these would also delete locked object(s) {names}; unlock them first.",
            409,
        )
    if not dry_run and plan.object_ids:
        removed = [await remove_scene_object(session, scene.object_by_id[oid]) for oid in plan.object_ids]
        await session.commit()
        for r in removed:
            await broadcast_removed_object(r)
    return DeleteOutcome(
        deleted_object_ids=plan.object_ids + plan.already_gone,
        deleted_timing_program_ids=plan.timing_program_ids,
        refused=plan.refused,
    )
