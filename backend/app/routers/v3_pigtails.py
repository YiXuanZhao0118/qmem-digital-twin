"""Pigtail ends of a fibre-pigtailed instrument — ``POST /api/v3/pigtails/...``.

Backend ports of the web store's per-END pigtail align
(``store/sceneStore.ts``: ``findPigtailAlignmentCandidates``,
``applyPigtailAlignmentCandidate``, ``clearPigtailEndpointLink``,
``resnapPigtailsLinkedTo``). A pigtailed part (the EOSpace EOM) aligns per
end: the port IS the ``fiber_connector`` bound at it
(``binding.properties.portAnchor``), so what moves is that connector — as an
``ObjectBinding`` delta, never the catalog ComponentBinding — while the
housing stays where it was bolted down. End A is the ``intercept_in``
connector, End B the ``intercept_out`` one.

Every write endpoint runs one transaction and broadcasts the ``/ws/scene``
events the ordinary routers send (``object_binding.created`` / ``.updated``,
``object.updated``). Shapes: ``docs/introduce/api.md``.
"""

from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import SceneObject
from app.optical.fibers.persist import PersistError, broadcast_persisted, persist_writes
from app.optical.fibers.scene import load_fiber_scene, norm_id
from app.optical.fibers.service import (
    DEFAULT_TOLERANCE_MM,
    FiberError,
    Writes,
    pigtail_apply_candidate,
    pigtail_candidates,
    pigtail_clear_link,
    pigtail_port,
    pigtail_resnap,
    pigtail_target_candidate,
    require_pigtail,
)
from app.routers.object_bindings import binding_payload
from app.routers.objects import object_payload
from app.routers.v3_fibers import BeamSegmentIn, End, EndIn, ResnapIn, TargetIn
from app.schemas import CamelModel


router = APIRouter(prefix="/v3/pigtails", tags=["v3-pigtails"])


class CandidatesIn(CamelModel):
    end: End
    tolerance_mm: Optional[float] = Field(default=DEFAULT_TOLERANCE_MM, gt=0)
    beam_segments: list[BeamSegmentIn] = Field(default_factory=list)


class ApplyIn(CamelModel):
    end: End
    target: TargetIn
    # null (default) = no distance check: the caller named the target.
    tolerance_mm: Optional[float] = Field(default=None, gt=0)


def _http(err: FiberError) -> HTTPException:
    return HTTPException(status_code=err.status, detail=err.detail)


@router.post("/{object_id}/candidates")
async def candidates(
    object_id: str, payload: CandidatesIn, session: AsyncSession = Depends(get_session),
) -> dict:
    """``findPigtailAlignmentCandidates``: beams and fibre receptacles within
    ``toleranceMm`` of the port connector's face, one entry per beam chain,
    closest first. Writes nothing."""
    object_id = norm_id(object_id)
    scene = await load_fiber_scene(session)
    try:
        obj, ref, port_lab = require_pigtail(scene, object_id, payload.end)
    except FiberError as err:
        raise _http(err) from err
    return {
        "objectId": obj.id,
        "name": obj.name,
        "locked": bool(obj.locked),
        "end": payload.end,
        "portAnchor": ref.port_anchor,
        "bindingId": ref.binding.id,
        "portLab": port_lab,
        "toleranceMm": payload.tolerance_mm,
        "candidates": pigtail_candidates(
            scene, object_id, payload.end, payload.tolerance_mm,
            [s.as_lab() for s in payload.beam_segments],
        ),
    }


@router.post("/{object_id}/apply")
async def apply(
    object_id: str, payload: ApplyIn, session: AsyncSession = Depends(get_session),
) -> dict:
    """``applyPigtailAlignmentCandidate`` for a receptacle (sets
    ``pigtailEndpoints[portAnchor]``) or a beam segment (clears it)."""
    object_id = norm_id(object_id)
    scene = await load_fiber_scene(session)
    try:
        candidate = pigtail_target_candidate(
            scene, object_id, payload.end, payload.target.as_dict(), payload.tolerance_mm,
        )
    except FiberError as err:
        raise _http(err) from err
    writes = Writes()
    if not pigtail_apply_candidate(scene, writes, object_id, payload.end, candidate):
        raise HTTPException(status_code=422, detail="The connector's face cannot be aligned.")
    try:
        persisted = await persist_writes(session, scene, writes)
    except PersistError as err:
        raise HTTPException(status_code=422, detail=err.detail) from err
    await broadcast_persisted(persisted)
    return {
        "object": object_payload(persisted.objects[0]),
        "objectBinding": binding_payload(persisted.object_bindings[0][0]),
        "candidate": candidate,
    }


@router.post("/{object_id}/disconnect")
async def disconnect(
    object_id: str, payload: EndIn, session: AsyncSession = Depends(get_session),
) -> dict:
    """``clearPigtailEndpointLink``: drop one end's link without moving the
    connector. ``changed`` is false (nothing written) when there was none."""
    object_id = norm_id(object_id)
    scene = await load_fiber_scene(session)
    obj = scene.objects.get(object_id)
    if obj is None:
        raise HTTPException(status_code=404, detail=f"SceneObject {object_id} not found.")
    # Only the port has to exist — a face without an axis triad can still be
    # unplugged.
    if pigtail_port(scene, obj, payload.end) is None:
        raise HTTPException(status_code=422, detail=f"{obj.name} has no pigtail connector for End {payload.end}.")
    writes = Writes()
    if not pigtail_clear_link(scene, writes, object_id, payload.end):
        row = await session.get(SceneObject, uuid.UUID(object_id))
        return {"object": object_payload(row), "changed": False}
    persisted = await persist_writes(session, scene, writes)
    await broadcast_persisted(persisted)
    return {"object": object_payload(persisted.objects[0]), "changed": True}


@router.post("/resnap")
async def resnap(payload: ResnapIn, session: AsyncSession = Depends(get_session)) -> dict:
    """``resnapPigtailsLinkedTo``: re-mate every pigtail end plugged into a
    receptacle on one of ``movedObjectIds``. Unresolvable links are left as
    they are."""
    scene = await load_fiber_scene(session)
    writes = Writes()
    done = pigtail_resnap(scene, writes, payload.moved_object_ids)
    try:
        persisted = await persist_writes(session, scene, writes)
    except PersistError as err:
        raise HTTPException(status_code=422, detail=err.detail) from err
    await broadcast_persisted(persisted)
    return {
        "resnapped": done,
        "updated": [object_payload(o) for o in persisted.objects],
        "objectBindings": [binding_payload(row) for row, _ in persisted.object_bindings],
    }
