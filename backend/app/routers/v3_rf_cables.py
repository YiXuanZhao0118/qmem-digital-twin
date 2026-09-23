"""RF coax cables — ``POST /api/v3/rf-cables/*``.

The cable flows for every client: the web app's ``store/sceneStore.ts`` calls
these (wave 3b), the qmem-blender add-on calls these, and there is no other
copy. The store action each one serves:

* ``/connect`` — ``createRfCableBetweenPorts`` behind the RF Link panel's
  drop gate: a new cable between two ports, variant picked from the ports'
  SMA/BNC families, both ends linked (``rfCableEndpoints``) and mated
  (``rfCableNodes``);
* ``/{id}/disconnect`` — ``clearRfCableEndpointLink``: unlinking an end
  removes the cable (a cable either joins two ports or does not exist);
* ``/resnap`` — ``resnapRfCablesLinkedTo`` after objects moved (plus the
  mounted pose of the PPGs plugged into them);
* ``/{id}/align-candidates`` (compute-only) and ``/{id}/align`` —
  ``findRfCableAlignmentCandidates`` / ``applyRfCableAlignmentCandidate``.

Every write runs as ONE transaction and broadcasts the usual ``/ws/scene``
events. A refused rule is a 4xx whose ``detail`` is ``"<code>: <message>"``
(codes in ``docs/introduce/api.md``); the web turns those into the silent
no-op its browser gates used to produce. Pure logic:
``app/optical/rf_cables/``; ``backend/tests/fixtures/rf_cables/`` are the
goldens the TypeScript wrote before it was deleted.
"""

from __future__ import annotations

import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.db import get_session
from app.optical.rf_cables import service
from app.optical.rf_cables.flows import PortRef, RuleError
from app.optical.rf_cables.geometry import DEFAULT_ALIGN_TOLERANCE_MM
from app.schemas import CamelModel


router = APIRouter(prefix="/v3/rf-cables", tags=["v3-rf-cables"])


class PortRefIn(CamelModel):
    """A port: the object plus the anchor's display name (``anchor.name ??
    anchor.id``, e.g. ``CH0``, ``RF1``, ``rf_in``). ``anchorId`` is only
    needed when two of the object's ports share that name."""

    object_id: uuid.UUID
    anchor_name: str
    anchor_id: Optional[str] = None

    def ref(self) -> PortRef:
        return PortRef(object_id=str(self.object_id), anchor_name=self.anchor_name, anchor_id=self.anchor_id)


def rule_http_error(err: RuleError) -> HTTPException:
    return HTTPException(status_code=err.status, detail=str(err))


class ConnectRequest(CamelModel):
    a: PortRefIn
    b: PortRefIn
    # The collection the new cable is filed under (default: the master one,
    # as POST /api/objects; the web passes its active collection).
    collection_id: Optional[uuid.UUID] = None


class ObjectResponse(CamelModel):
    object: schemas.SceneObjectOut


class EndRequest(CamelModel):
    end: Literal["A", "B"]


class DisconnectResponse(CamelModel):
    # The cable when nothing was deleted (that end had no link), else null.
    object: Optional[schemas.SceneObjectOut]
    deleted_object_ids: list[str]
    deleted_timing_program_ids: list[str]


class ResnapRequest(CamelModel):
    moved_object_ids: list[uuid.UUID]


class ResnapResponse(CamelModel):
    # Every object written: re-mated cables and re-mounted PPGs.
    updated: list[schemas.SceneObjectOut]


class AlignCandidatesRequest(CamelModel):
    end: Literal["A", "B"]
    tolerance_mm: float = Field(default=DEFAULT_ALIGN_TOLERANCE_MM, ge=0)


class AlignCandidateOut(CamelModel):
    dist_mm: float
    new_pos_mm_body: list[float]
    new_handle_mm_body: list[float]
    target_name: str
    target_object_id: str
    target_anchor_name: str
    target_anchor_id: str


class AlignCandidatesResponse(CamelModel):
    candidates: list[AlignCandidateOut]


class AlignRequest(CamelModel):
    end: Literal["A", "B"]
    target: PortRefIn
    tolerance_mm: float = Field(default=DEFAULT_ALIGN_TOLERANCE_MM, ge=0)


@router.post("/connect", response_model=ObjectResponse)
async def connect(request: ConnectRequest, session: AsyncSession = Depends(get_session)) -> ObjectResponse:
    """Create a cable between two ports (see the module docstring)."""
    try:
        so = await service.connect(session, request.a.ref(), request.b.ref(), request.collection_id)
    except RuleError as err:
        raise rule_http_error(err) from err
    return ObjectResponse(object=schemas.SceneObjectOut.model_validate(so))


@router.post("/resnap", response_model=ResnapResponse)
async def resnap(request: ResnapRequest, session: AsyncSession = Depends(get_session)) -> ResnapResponse:
    """Re-mate the cable ends (and re-mount the PPGs) linked to moved objects."""
    changed = await service.resnap(session, [str(i) for i in request.moved_object_ids])
    return ResnapResponse(updated=[schemas.SceneObjectOut.model_validate(so) for so in changed])


@router.post("/{cable_id}/disconnect", response_model=DisconnectResponse)
async def disconnect(
    cable_id: uuid.UUID, request: EndRequest, session: AsyncSession = Depends(get_session),
) -> DisconnectResponse:
    """Unlink one end — which removes the cable."""
    try:
        so, deleted = await service.disconnect(session, str(cable_id), request.end)
    except RuleError as err:
        raise rule_http_error(err) from err
    return DisconnectResponse(
        object=schemas.SceneObjectOut.model_validate(so) if so is not None else None,
        deleted_object_ids=deleted.object_ids,
        deleted_timing_program_ids=deleted.timing_program_ids,
    )


@router.post("/{cable_id}/align-candidates", response_model=AlignCandidatesResponse)
async def align_candidates(
    cable_id: uuid.UUID, request: AlignCandidatesRequest, session: AsyncSession = Depends(get_session),
) -> AlignCandidatesResponse:
    """Compute-only: the rf_in / rf_out ports within ``toleranceMm`` of this
    end, nearest first, each with the node + handle that would mate it."""
    try:
        cands = await service.align_candidates(session, str(cable_id), request.end, request.tolerance_mm)
    except RuleError as err:
        raise rule_http_error(err) from err
    return AlignCandidatesResponse(candidates=[AlignCandidateOut(**c.as_json()) for c in cands])


@router.post("/{cable_id}/align", response_model=ObjectResponse)
async def align(
    cable_id: uuid.UUID, request: AlignRequest, session: AsyncSession = Depends(get_session),
) -> ObjectResponse:
    """Snap this end onto ``target`` (one of its align candidates) and link it."""
    try:
        so = await service.align(session, str(cable_id), request.end, request.target.ref(), request.tolerance_mm)
    except RuleError as err:
        raise rule_http_error(err) from err
    return ObjectResponse(object=schemas.SceneObjectOut.model_validate(so))
