"""Programmable Pulse Generators — ``POST /api/v3/ppg/*``.

Backend ports of the RF Link panel's PPG lifecycle, the only one the web app
permits (``docs/introduce/timing.md``):

* ``/attach`` — ``createPpgAtPort`` + ``createProgrammablePulseGenerator``
  behind ``canSpawnPpgHere``: a new PPG plugged straight into an empty
  ``ttl_in`` / ``trigger_in`` (``properties.ppgAttachment``, no cable), with
  its own TimingProgram, standing at its mounted pose
  (``utils/ppgMounting.ts``);
* ``/{id}/detach`` — the panel's "Disconnect" on a PPG: the PPG is deleted,
  its TimingProgram with it, through the web's delete cascade.

One transaction each (so a failed attach leaves no program / object /
element behind), the usual ``/ws/scene`` events, 4xx ``detail`` =
``"<code>: <message>"``. Pure logic: ``app/optical/rf_cables/``.
"""

from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.db import get_session
from app.optical.rf_cables import service
from app.optical.rf_cables.flows import RuleError
from app.routers.v3_rf_cables import PortRefIn, rule_http_error
from app.schemas import CamelModel


router = APIRouter(prefix="/v3/ppg", tags=["v3-ppg"])


class PpgAttachRequest(CamelModel):
    target: PortRefIn
    # As on /rf-cables/connect: default the master collection.
    collection_id: Optional[uuid.UUID] = None


class PpgAttachResponse(CamelModel):
    object: schemas.SceneObjectOut
    timing_program: schemas.TimingProgramOut
    # False when the mount did not resolve (the target port is not on its
    # object's primary asset); the PPG then stands at the target's pose.
    mounted: bool


class PpgDetachResponse(CamelModel):
    deleted_object_ids: list[str]
    deleted_timing_program_ids: list[str]


@router.post("/attach", response_model=PpgAttachResponse)
async def attach(request: PpgAttachRequest, session: AsyncSession = Depends(get_session)) -> PpgAttachResponse:
    """Plug a new PPG (+ TimingProgram) into a gate input."""
    try:
        attached = await service.ppg_attach(session, request.target.ref(), request.collection_id)
    except RuleError as err:
        raise rule_http_error(err) from err
    return PpgAttachResponse(
        object=schemas.SceneObjectOut.model_validate(attached.scene_object),
        timing_program=schemas.TimingProgramOut.model_validate(attached.timing_program),
        mounted=attached.mounted,
    )


@router.post("/{ppg_id}/detach", response_model=PpgDetachResponse)
async def detach(ppg_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> PpgDetachResponse:
    """Remove a PPG and its TimingProgram."""
    try:
        deleted = await service.ppg_detach(session, str(ppg_id))
    except RuleError as err:
        raise rule_http_error(err) from err
    return PpgDetachResponse(
        deleted_object_ids=deleted.object_ids, deleted_timing_program_ids=deleted.timing_program_ids,
    )
