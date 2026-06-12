"""CRUD for the ``kinds`` table (alembic 0086).

Each row is one Kind metadata variant. PhysicsOps stay in code; each
row references one via ``op_set_name``. Creating a kind via the UI lets
the user curate metadata variants (different defaults / wavelength
ranges / face templates) without writing TypeScript, but to introduce
genuinely new physics behaviour you still need to register a new op set
in code.

See docs/asset-physics-model.md §6 for the design rationale.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.db import get_session
from app.lock_guard import assert_delete_allowed, assert_update_allowed
from app.kinds_manifest import element_kinds, load_manifest
from app.models import Asset3D, Kind
from app.optical.db_kinds import (
    remove_kind_cache_entry,
    set_kind_cache_entry,
)


router = APIRouter()


def _kind_out(kind: Kind) -> dict:
    return schemas.KindOut.model_validate(kind).model_dump(mode="json", by_alias=True)


def _registered_op_set_names() -> set[str]:
    """All op-set names a Kind row may reference.

    Physics kinds point at code-defined op sets. Passive mechanical
    kinds such as ``optical_table`` are metadata-only, but still need a
    stable op-set slug so the Kinds editor can create and retain them.
    """
    manifest = load_manifest()
    passive_ids = {
        plugin["id"]
        for plugin in manifest.get("passive_plugins", [])
        if isinstance(plugin, dict) and isinstance(plugin.get("id"), str)
    }
    return set(element_kinds()) | passive_ids


@router.get("", response_model=list[schemas.KindOut])
async def list_kinds(
    domain: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> list[Kind]:
    stmt = select(Kind).order_by(Kind.name)
    if domain is not None:
        # Match if the requested domain is one of the kind's domains, so a
        # multi-domain part (e.g. AOM = optical+rf) shows up under each.
        stmt = stmt.where(Kind.domains.any(domain))
    return list((await session.scalars(stmt)).all())


@router.get("/{kind_id}", response_model=schemas.KindOut)
async def get_kind(
    kind_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Kind:
    kind = await session.get(Kind, kind_id)
    if kind is None:
        raise HTTPException(status_code=404, detail=f"Kind {kind_id} not found")
    return kind


@router.post("", response_model=schemas.KindOut, status_code=status.HTTP_201_CREATED)
async def create_kind(
    payload: schemas.KindCreate,
    session: AsyncSession = Depends(get_session),
) -> Kind:
    op_set_names = _registered_op_set_names()
    if payload.op_set_name not in op_set_names:
        raise HTTPException(
            status_code=400,
            detail=(
                f"op_set_name {payload.op_set_name!r} is not registered in "
                "the code-side op registry. Pick one of: "
                f"{sorted(op_set_names)}."
            ),
        )
    kind = Kind(**payload.model_dump())
    session.add(kind)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=409,
            detail=(
                f"Kind with name {payload.name!r} already exists. "
                "Names are unique."
            ),
        ) from exc
    await session.refresh(kind)
    # Tracer cache (Phase 5): new row -> tracer can now resolve this
    # kind name through op_set_name indirection.
    set_kind_cache_entry(kind.name, kind.op_set_name)
    return kind


@router.patch("/{kind_id}", response_model=schemas.KindOut)
async def update_kind(
    kind_id: uuid.UUID,
    payload: schemas.KindUpdate,
    session: AsyncSession = Depends(get_session),
) -> Kind:
    kind = await session.get(Kind, kind_id)
    if kind is None:
        raise HTTPException(status_code=404, detail=f"Kind {kind_id} not found")
    updates = payload.model_dump(exclude_unset=True)
    assert_update_allowed(
        locked=kind.locked, changed_fields=updates.keys(), label=f"Kind {kind.name!r}"
    )
    for field, value in updates.items():
        setattr(kind, field, value)
    await session.commit()
    await session.refresh(kind)
    return kind


@router.delete("/{kind_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_kind(
    kind_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Response:
    kind = await session.get(Kind, kind_id)
    if kind is None:
        raise HTTPException(status_code=404, detail=f"Kind {kind_id} not found")
    assert_delete_allowed(locked=kind.locked, label=f"Kind {kind.name!r}")
    in_use = (
        await session.scalars(
            select(Asset3D.id).where(Asset3D.kind_id == kind.name).limit(1)
        )
    ).first()
    if in_use is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Kind {kind.name!r} is still referenced by at least one "
                "Asset3D. Reassign or delete those assets first."
            ),
        )
    deleted_name = kind.name
    await session.delete(kind)
    await session.commit()
    # Tracer cache (Phase 5): drop the entry so a later Asset3D using
    # the deleted name fails fast with a clear KeyError instead of
    # tracing against a stale op_set_name mapping.
    remove_kind_cache_entry(deleted_name)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
