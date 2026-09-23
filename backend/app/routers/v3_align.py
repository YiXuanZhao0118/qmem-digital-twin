"""Align solvers — POST /api/v3/align/{mirror-coupling,isolator,aom-bragg}.

Compute-only: each endpoint reads the DB scene, solves, and returns PROPOSED
poses. Nothing is written; applying a pose is an ordinary
``PATCH /api/objects/{id}`` by the caller (who also owns the locked-object
refusal, as the web app's store does).

These are the only copy of solvers that used to live in the web app's
TypeScript (see ``app/optical/align/__init__.py``): a second client (the
qmem-blender add-on) calls the backend instead of growing a third copy, and
since 2026-09-23 the web app calls them too (``frontend/src/api/align.ts``)
with its TypeScript copies deleted.
Request / response shapes: ``docs/introduce/api.md``.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.optical.align.mirror_coupling import Ray
from app.optical.align.service import (
    AlignError,
    aom_bragg_align,
    isolator_align,
    load_align_scene,
    mirror_coupling_align,
    rf_link_freq_mhz,
)
from app.optical.align.ts_compat import V
from app.optical.rf_resolve import load_rf_inputs
from app.schemas import CamelModel


router = APIRouter(prefix="/v3/align", tags=["v3-align"])


class Vec3In(CamelModel):
    x: float
    y: float
    z: float

    def v(self) -> V:
        return V(self.x, self.y, self.z)


def _nonzero(v: Vec3In) -> Vec3In:
    if v.x == 0 and v.y == 0 and v.z == 0:
        raise ValueError("direction must be non-zero")
    return v


class RayIn(CamelModel):
    """A beam line in lab mm — e.g. the traced segment that ends on mirror A
    (``origin`` = its start, ``dir`` = its propagation direction)."""

    origin: Vec3In
    dir: Vec3In

    _check_dir = field_validator("dir")(_nonzero)


class BeamIn(CamelModel):
    """The beam to align to: its propagation direction and any point on it
    (lab mm), plus its wavelength for the AOM's Bragg angle."""

    dir: Vec3In
    ref: Vec3In
    wavelength_nm: Optional[float] = None

    _check_dir = field_validator("dir")(_nonzero)


class TargetIn(CamelModel):
    """The destination port: an ``intercept_in`` / ``fiber_in`` / ``seed``
    anchor of a third object. ``anchorName`` picks among same-id anchors."""

    object_id: str
    anchor_id: str
    anchor_name: Optional[str] = None


class MirrorCouplingRequest(CamelModel):
    mirror_a_id: str  # the mirror the seed reaches first
    mirror_b_id: str
    in_ray: RayIn
    target: TargetIn
    # The free DOF of the collinear (U-turn / periscope) branch, mm along the
    # seed from ``inRay.origin``; null = least total travel. Ignored when the
    # solution is unique.
    fold_mm: Optional[float] = None
    # Optics between mirror B and the port to re-centre on the new axis
    # (translate only). Locked objects are skipped and reported.
    pass_through_object_ids: list[str] = Field(default_factory=list)


class IsolatorAlignRequest(CamelModel):
    object_id: str
    beam: BeamIn
    # null = the object's stored choice (properties.alignReverse / alignRollDeg).
    reverse: Optional[bool] = None
    roll_deg: Optional[float] = None


class AomBraggRequest(CamelModel):
    object_id: str
    beam: BeamIn
    # null = the object's / asset's stored value (see docs/introduce/api.md).
    order: Optional[int] = None
    fine_tune_mrad: Optional[float] = None
    reverse: Optional[bool] = None
    roll_deg: Optional[float] = None
    # RF drive frequency; null = the RF link at scrubTimeNs, else the stored one.
    freq_mhz: Optional[float] = None
    scrub_time_ns: Optional[float] = None
    # Also return the rotation-stage nudge of the CURRENT pose by this much.
    nudge_mrad: Optional[float] = None


def _raise(err: AlignError) -> None:
    raise HTTPException(status_code=err.status, detail=err.detail) from err


@router.post("/mirror-coupling")
async def mirror_coupling(
    request: MirrorCouplingRequest,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Two 45 deg mirrors that put the seed on the port's axis
    (was ``utils/mirrorCoupling.ts``). ``plan`` is null (with ``error``) when no
    pair exists; the web app refuses to apply unless ``touch.ok``."""
    scene = await load_align_scene(session)
    try:
        return mirror_coupling_align(
            scene,
            mirror_a_id=request.mirror_a_id,
            mirror_b_id=request.mirror_b_id,
            in_ray=Ray(origin=request.in_ray.origin.v(), dir=request.in_ray.dir.v()),
            target_object_id=request.target.object_id,
            target_anchor_id=request.target.anchor_id,
            target_anchor_name=request.target.anchor_name,
            fold_mm=request.fold_mm,
            pass_through_object_ids=request.pass_through_object_ids,
        )
    except AlignError as err:
        _raise(err)


@router.post("/isolator")
async def isolator(
    request: IsolatorAlignRequest,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Point + direction align onto a beam (was ``utils/isolatorAlign.ts``) — the
    isolator's front/back bore, or any optic's alignSpec / entry anchor."""
    scene = await load_align_scene(session)
    try:
        return isolator_align(
            scene,
            object_id=request.object_id,
            beam_dir=request.beam.dir.v(),
            beam_ref=request.beam.ref.v(),
            reverse=request.reverse,
            roll_deg=request.roll_deg,
        )
    except AlignError as err:
        _raise(err)


@router.post("/aom-bragg")
async def aom_bragg(
    request: AomBraggRequest,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Two-stage AOM Bragg align for the selected order (was ``utils/aomAlign.ts``)."""
    scene = await load_align_scene(session)
    rf_freq = None
    if request.freq_mhz is None:
        rf_freq = rf_link_freq_mhz(
            await load_rf_inputs(session), request.object_id, request.scrub_time_ns,
        )
    try:
        return aom_bragg_align(
            scene,
            object_id=request.object_id,
            beam_dir=request.beam.dir.v(),
            beam_ref=request.beam.ref.v(),
            wavelength_nm=request.beam.wavelength_nm,
            order=request.order,
            fine_tune_mrad=request.fine_tune_mrad,
            reverse=request.reverse,
            roll_deg=request.roll_deg,
            freq_mhz=request.freq_mhz,
            rf_freq_mhz=rf_freq,
            nudge_mrad=request.nudge_mrad,
        )
    except AlignError as err:
        _raise(err)
