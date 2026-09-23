"""Scene objects — ``POST /api/v3/objects/delete``.

What ``sceneStore.deleteObjects`` calls (wave 3b) and what the qmem-blender
add-on calls: delete a set of SceneObjects together with everything the
cascade takes along — the rf_cables linked to them, the PPGs plugged into
them, legacy PPGs left without a live cable, and those PPGs' TimingPrograms —
in ONE transaction, broadcasting the same ``/ws/scene`` events as ``DELETE
/api/objects/{id}``. ``dryRun`` computes the same answer and deletes nothing.

A ``locked`` object that was asked for is skipped and listed in ``refused``;
a cascade that would reach one is refused whole: 409 with ``detail``
``"locked: <message>"``. The rules, and where they depart from the cascade
the browser used to run: ``app/services/object_delete.py``;
``backend/tests/fixtures/delete/`` are the goldens the TypeScript wrote
before it was deleted.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.optical.rf_cables.flows import RuleError
from app.routers.v3_rf_cables import rule_http_error
from app.schemas import CamelModel
from app.services import object_delete


router = APIRouter(prefix="/v3/objects", tags=["v3-objects"])


class DeleteObjectsRequest(CamelModel):
    object_ids: list[uuid.UUID]
    # Compute the answer, delete nothing (for a confirmation dialog).
    dry_run: bool = False


class RefusedOut(CamelModel):
    object_id: str
    # "locked" — the only reason today.
    reason: str


class DeleteObjectsResponse(CamelModel):
    # Doomed objects in the web's DELETE order (requested, then the cascade),
    # then any requested id that was already gone.
    deleted_object_ids: list[str]
    deleted_timing_program_ids: list[str]
    refused: list[RefusedOut]


@router.post("/delete", response_model=DeleteObjectsResponse)
async def delete_objects(
    request: DeleteObjectsRequest, session: AsyncSession = Depends(get_session),
) -> DeleteObjectsResponse:
    """Delete objects with the web's cascade (see the module docstring)."""
    try:
        outcome = await object_delete.delete_objects(
            session, [str(i) for i in request.object_ids], dry_run=request.dry_run,
        )
    except RuleError as err:
        raise rule_http_error(err) from err
    return DeleteObjectsResponse(
        deleted_object_ids=outcome.deleted_object_ids,
        deleted_timing_program_ids=outcome.deleted_timing_program_ids,
        refused=[RefusedOut(object_id=r.object_id, reason=r.reason) for r in outcome.refused],
    )
