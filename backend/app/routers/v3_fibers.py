"""Patch-cable ends — ``POST /api/v3/fibers/...``.

Backend ports of the web store's fibre-end flows (``store/sceneStore.ts``:
``findFiberAlignmentCandidates``, ``applyFiberAlignmentCandidate``,
``clearFiberEndpointLink``, ``resnapFibersLinkedTo``), so a second client (the
qmem-blender add-on) plugs a cable into an instrument, parks an end on a beam
and re-snaps plugged ends without re-implementing any of it.

* ``/{id}/candidates`` — compute-only, the picker list.
* ``/{id}/connect`` — plug one end into a fibre receptacle (a female fibre
  ``connectorType``): the ``fiberEndpoints`` link, the spline node, and the
  write-through to the fibre PE's ``kindParams.endA/endB`` that the solver
  actually reads. ``/{id}/apply`` does the same for a receptacle OR a beam
  (a beam placement clears the end's link).
* ``/{id}/disconnect`` — drop one end's link, leaving the cable where it is.
* ``/resnap`` — re-derive every plugged end whose instrument moved.

Every write endpoint runs one transaction and broadcasts the ``/ws/scene``
events the ordinary routers send (``object.updated``,
``physics_element.updated``). Pure maths + flows: ``app/optical/fibers/``.
Shapes: ``docs/introduce/api.md``.
"""

from __future__ import annotations

import math
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field, field_validator, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import SceneObject
from app.optical.fibers.persist import PersistError, broadcast_persisted, persist_writes
from app.optical.fibers.scene import load_fiber_scene, norm_id
from app.optical.fibers.service import (
    DEFAULT_TOLERANCE_MM,
    FiberError,
    Writes,
    fiber_apply_candidate,
    fiber_candidates,
    fiber_clear_link,
    fiber_resnap,
    fiber_target_candidate,
    require_fiber,
)
from app.routers.objects import object_payload
from app.routers.physics_elements import element_payload
from app.schemas import CamelModel


router = APIRouter(prefix="/v3/fibers", tags=["v3-fibers"])

End = Literal["A", "B"]


def _finite3(v: tuple[float, float, float]) -> tuple[float, float, float]:
    if not all(math.isfinite(x) for x in v):
        raise ValueError("must be three finite numbers")
    return v


class BeamSegmentIn(CamelModel):
    """One traced beam segment in LAB mm — the web's ``BeamSegmentLab``, as
    ``sceneStore.collectBeamSegmentsLab`` builds it from the live trace.
    ``beamId`` is the dedup identity (the web uses
    ``trace:<emitter8>:o<order|x>:<source8>``; every ``trace:`` segment of one
    emitter / order / branch collapses to the closest). ``sourceObjectId`` —
    the object that emitted this segment — lets the server skip segments a
    part emitted itself, as the web does."""

    beam_id: str = Field(min_length=1)
    a_mm: tuple[float, float, float]
    b_mm: tuple[float, float, float]
    display_label: Optional[str] = None
    emitter_object_id: Optional[str] = None
    aom_order: Optional[float] = None
    branch: Optional[str] = None
    wavelength_nm: Optional[float] = None
    source_object_id: Optional[str] = None

    _a = field_validator("a_mm")(_finite3)
    _b = field_validator("b_mm")(_finite3)

    @field_validator("source_object_id")
    @classmethod
    def _source_id(cls, v: Optional[str]) -> Optional[str]:
        return None if v is None else norm_id(v)

    def as_lab(self) -> dict:
        out: dict = {"beamId": self.beam_id, "aMm": list(self.a_mm), "bMm": list(self.b_mm)}
        for key, value in (
            ("displayLabel", self.display_label),
            ("emitterObjectId", self.emitter_object_id),
            ("branch", self.branch),
            ("wavelengthNm", self.wavelength_nm),
            ("sourceObjectId", self.source_object_id),
        ):
            if value is not None:
                out[key] = value
        if self.aom_order is not None:
            out["aomOrder"] = int(self.aom_order) if float(self.aom_order).is_integer() else self.aom_order
        return out


class PortTargetIn(CamelModel):
    """A fibre receptacle: the object, and its anchor's ``name ?? id`` (the
    identity a link stores). ``anchorId`` disambiguates two anchors sharing a
    name."""

    object_id: str
    anchor_name: str
    anchor_id: Optional[str] = None

    _id = field_validator("object_id")(norm_id)


class TargetIn(CamelModel):
    """A receptacle (``objectId`` + ``anchorName`` [+ ``anchorId``]) or a beam
    segment (``beam``) — exactly one."""

    object_id: Optional[str] = None
    anchor_name: Optional[str] = None
    anchor_id: Optional[str] = None
    beam: Optional[BeamSegmentIn] = None

    @field_validator("object_id")
    @classmethod
    def _id(cls, v: Optional[str]) -> Optional[str]:
        return None if v is None else norm_id(v)

    @model_validator(mode="after")
    def _one_kind(self) -> "TargetIn":
        is_port = self.object_id is not None or self.anchor_name is not None
        if self.beam is not None and is_port:
            raise ValueError("target is either a port (objectId + anchorName) or a beam, not both")
        if self.beam is None and (self.object_id is None or self.anchor_name is None):
            raise ValueError("target needs objectId + anchorName (a port) or beam (a segment)")
        return self

    def as_dict(self) -> dict:
        if self.beam is not None:
            return {"beam": self.beam.as_lab()}
        out = {"objectId": self.object_id, "anchorName": self.anchor_name}
        if self.anchor_id is not None:
            out["anchorId"] = self.anchor_id
        return out


class CandidatesIn(CamelModel):
    end: End
    # The web's default window; null = no distance limit.
    tolerance_mm: Optional[float] = Field(default=DEFAULT_TOLERANCE_MM, gt=0)
    beam_segments: list[BeamSegmentIn] = Field(default_factory=list)


class ConnectIn(CamelModel):
    end: End
    target: PortTargetIn
    # null (default) = no distance check: the caller named the port.
    tolerance_mm: Optional[float] = Field(default=None, gt=0)


class ApplyIn(CamelModel):
    end: End
    target: TargetIn
    tolerance_mm: Optional[float] = Field(default=None, gt=0)


class EndIn(CamelModel):
    end: End


class ResnapIn(CamelModel):
    moved_object_ids: list[str]

    @field_validator("moved_object_ids")
    @classmethod
    def _ids(cls, v: list[str]) -> list[str]:
        return [norm_id(x) for x in v]


def _http(err: FiberError) -> HTTPException:
    return HTTPException(status_code=err.status, detail=err.detail)


async def _apply(session: AsyncSession, object_id: str, end: str, target: dict, tolerance_mm) -> dict:
    object_id = norm_id(object_id)
    scene = await load_fiber_scene(session)
    try:
        candidate = fiber_target_candidate(scene, object_id, end, target, tolerance_mm)
    except FiberError as err:
        raise _http(err) from err
    writes = Writes()
    if not fiber_apply_candidate(scene, writes, object_id, end, candidate):
        raise HTTPException(status_code=422, detail="The fibre has no spline to move.")
    try:
        persisted = await persist_writes(session, scene, writes)
    except PersistError as err:
        raise HTTPException(status_code=422, detail=err.detail) from err
    await broadcast_persisted(persisted)
    return {
        "object": object_payload(persisted.objects[0]),
        "physicsElement": element_payload(persisted.physics_elements[0]) if persisted.physics_elements else None,
        "candidate": candidate,
    }


@router.post("/{object_id}/candidates")
async def candidates(
    object_id: str, payload: CandidatesIn, session: AsyncSession = Depends(get_session),
) -> dict:
    """``findFiberAlignmentCandidates``: every beam segment and fibre
    receptacle within ``toleranceMm`` of the end's optical face, one entry per
    beam chain, closest first. Writes nothing."""
    scene = await load_fiber_scene(session)
    try:
        obj, _nodes = require_fiber(scene, object_id)
    except FiberError as err:
        raise _http(err) from err
    return {
        "objectId": obj.id,
        "name": obj.name,
        "locked": bool(obj.locked),
        "end": payload.end,
        "toleranceMm": payload.tolerance_mm,
        "candidates": fiber_candidates(
            scene, object_id, payload.end, payload.tolerance_mm,
            [s.as_lab() for s in payload.beam_segments],
        ),
    }


@router.post("/{object_id}/connect")
async def connect(
    object_id: str, payload: ConnectIn, session: AsyncSession = Depends(get_session),
) -> dict:
    """Plug one end into a fibre receptacle — the store's
    ``applyFiberAlignmentCandidate`` with that port's candidate."""
    return await _apply(
        session, object_id, payload.end,
        TargetIn(
            object_id=payload.target.object_id,
            anchor_name=payload.target.anchor_name,
            anchor_id=payload.target.anchor_id,
        ).as_dict(),
        payload.tolerance_mm,
    )


@router.post("/{object_id}/apply")
async def apply(
    object_id: str, payload: ApplyIn, session: AsyncSession = Depends(get_session),
) -> dict:
    """``applyFiberAlignmentCandidate`` for a receptacle (sets the link) or a
    beam segment (clears it)."""
    return await _apply(session, object_id, payload.end, payload.target.as_dict(), payload.tolerance_mm)


@router.post("/{object_id}/disconnect")
async def disconnect(
    object_id: str, payload: EndIn, session: AsyncSession = Depends(get_session),
) -> dict:
    """``clearFiberEndpointLink``: unplug in place. ``changed`` is false (and
    nothing is written) when that end had no link."""
    object_id = norm_id(object_id)
    scene = await load_fiber_scene(session)
    obj = scene.objects.get(object_id)
    if obj is None:
        raise HTTPException(status_code=404, detail=f"SceneObject {object_id} not found.")
    writes = Writes()
    if not fiber_clear_link(scene, writes, object_id, payload.end):
        row = await session.get(SceneObject, uuid.UUID(object_id))
        return {"object": object_payload(row), "changed": False}
    persisted = await persist_writes(session, scene, writes)
    await broadcast_persisted(persisted)
    return {"object": object_payload(persisted.objects[0]), "changed": True}


@router.post("/resnap")
async def resnap(payload: ResnapIn, session: AsyncSession = Depends(get_session)) -> dict:
    """``resnapFibersLinkedTo``: re-derive every plugged end whose target is
    among ``movedObjectIds`` from the port's live pose, through the normal
    apply path. A link whose target or anchor cannot be resolved is left
    exactly as it is."""
    scene = await load_fiber_scene(session)
    writes = Writes()
    done = fiber_resnap(scene, writes, payload.moved_object_ids)
    try:
        persisted = await persist_writes(session, scene, writes)
    except PersistError as err:
        raise HTTPException(status_code=422, detail=err.detail) from err
    await broadcast_persisted(persisted)
    return {
        "resnapped": done,
        "updated": [object_payload(o) for o in persisted.objects],
        "physicsElements": [element_payload(e) for e in persisted.physics_elements],
    }
