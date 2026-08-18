"""CRUD for the ``devices`` table (alembic 0123).

A *device* is one concrete instrument: a mesh + a named-anchor layout +
its default params, pinned to ONE behavioural kind. Until 0123 a device
was a TypeScript file under ``frontend/src/devices/``, so adding the 40th
instrument meant editing two files, re-running ``npm run export:kinds``
and restarting the backend. Devices are DB rows now and this router is
the only write path.

The IRON RULE from the original design still holds: the dependency runs
``device -> behavioural kind``, never the reverse. ``behavioral_kind``
must be an ElementKind the solver already dispatches on (validated below
against the same manifest set ``kinds.py`` uses), or NULL for render-only
mechanical fixtures.

See docs/introduce/asset.md and docs/introduce/rf.md.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.db import get_session
from app.kinds_manifest import element_kinds, load_manifest
from app.lock_guard import assert_delete_allowed, assert_update_allowed
from app.models import Asset3D, Device


router = APIRouter()


def _behavioral_kind_choices() -> set[str]:
    """ElementKinds a device may pin itself to.

    Physics kinds come from the manifest's ``element_kinds``; passive
    plugin ids are included because the render-only mechanical fixtures
    (posts / clamps / chassis) are catalogued the same way. Mirrors
    ``kinds._registered_op_set_names``.
    """
    manifest = load_manifest()
    passive_ids = {
        plugin["id"]
        for plugin in manifest.get("passive_plugins", [])
        if isinstance(plugin, dict) and isinstance(plugin.get("id"), str)
    }
    return set(element_kinds()) | passive_ids


def _assert_behavioral_kind(behavioral_kind: str | None) -> None:
    if behavioral_kind is None:
        return
    choices = _behavioral_kind_choices()
    if behavioral_kind not in choices:
        raise HTTPException(
            status_code=400,
            detail=(
                f"behavioral_kind {behavioral_kind!r} is not a registered "
                "ElementKind. Pick one of: "
                f"{sorted(choices)}, or null for a render-only device."
            ),
        )


async def _usage_counts(
    session: AsyncSession, slugs: list[str]
) -> dict[str, int]:
    """How many Asset3D rows point at each slug.

    One grouped query for the whole list — the editor renders the count on
    every row, and a per-row COUNT would be 39 round-trips on page load.
    """
    if not slugs:
        return {}
    rows = await session.execute(
        select(Asset3D.device_id, func.count())
        .where(Asset3D.device_id.in_(slugs))
        .group_by(Asset3D.device_id)
    )
    return {slug: count for slug, count in rows.all() if slug is not None}


def _device_out(device: Device, usage_count: int) -> schemas.DeviceOut:
    out = schemas.DeviceOut.model_validate(device)
    out.usage_count = usage_count
    return out


@router.get("", response_model=list[schemas.DeviceOut])
async def list_devices(
    behavioral_kind: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> list[schemas.DeviceOut]:
    stmt = select(Device).order_by(Device.slug)
    if behavioral_kind is not None:
        stmt = stmt.where(Device.behavioral_kind == behavioral_kind)
    devices = list((await session.scalars(stmt)).all())
    usage = await _usage_counts(session, [d.slug for d in devices])
    return [_device_out(d, usage.get(d.slug, 0)) for d in devices]


@router.get("/behavioral-kinds", response_model=list[str])
async def list_behavioral_kinds() -> list[str]:
    """Every ElementKind a device may pin itself to.

    Declared BEFORE ``/{device_id}`` so FastAPI matches the literal path
    first — ``device_id`` is a UUID and would otherwise 422 here.
    """
    return sorted(_behavioral_kind_choices())


@router.get("/{device_id}", response_model=schemas.DeviceOut)
async def get_device(
    device_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> schemas.DeviceOut:
    device = await session.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail=f"Device {device_id} not found")
    usage = await _usage_counts(session, [device.slug])
    return _device_out(device, usage.get(device.slug, 0))


@router.post("", response_model=schemas.DeviceOut, status_code=status.HTTP_201_CREATED)
async def create_device(
    payload: schemas.DeviceCreate,
    session: AsyncSession = Depends(get_session),
) -> schemas.DeviceOut:
    _assert_behavioral_kind(payload.behavioral_kind)
    data = payload.model_dump()
    data["anchors"] = [
        a.model_dump(by_alias=False, exclude_none=True) for a in payload.anchors
    ]
    device = Device(**data)
    session.add(device)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=409,
            detail=(
                f"Device with slug {payload.slug!r} already exists. "
                "Slugs are unique."
            ),
        ) from exc
    await session.refresh(device)
    return _device_out(device, 0)


@router.patch("/{device_id}", response_model=schemas.DeviceOut)
async def update_device(
    device_id: uuid.UUID,
    payload: schemas.DeviceUpdate,
    session: AsyncSession = Depends(get_session),
) -> schemas.DeviceOut:
    device = await session.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail=f"Device {device_id} not found")
    updates = payload.model_dump(exclude_unset=True)
    assert_update_allowed(
        locked=device.locked,
        changed_fields=updates.keys(),
        label=f"Device {device.slug!r}",
    )
    if "behavioral_kind" in updates:
        _assert_behavioral_kind(updates["behavioral_kind"])
    if "anchors" in updates and payload.anchors is not None:
        # Whole-list overwrite — the editor always sends the full layout.
        # Stored in the snake_case shape `device_seed` reads.
        updates["anchors"] = [
            a.model_dump(by_alias=False, exclude_none=True) for a in payload.anchors
        ]
    for field, value in updates.items():
        setattr(device, field, value)
    await session.commit()
    await session.refresh(device)
    usage = await _usage_counts(session, [device.slug])
    return _device_out(device, usage.get(device.slug, 0))


@router.delete("/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_device(
    device_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Response:
    device = await session.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail=f"Device {device_id} not found")
    assert_delete_allowed(locked=device.locked, label=f"Device {device.slug!r}")
    usage = await _usage_counts(session, [device.slug])
    in_use = usage.get(device.slug, 0)
    if in_use:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Device {device.slug!r} is still referenced by {in_use} "
                "Asset3D row(s). Repoint or clear those assets first."
            ),
        )
    await session.delete(device)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
