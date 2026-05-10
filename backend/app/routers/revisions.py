"""V2 Phase 1: read-only access to revisions.

The Revision table predates V2 (alembic models had it from day one) but had
no router. Phase 1 adds GET endpoints so the V2-aware UI can browse saved
scene snapshots; POST/restore lands in a later phase along with the
``sceneHash`` recompute logic.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Revision
from app.schemas import V2RevisionOut


router = APIRouter()


@router.get("", response_model=list[V2RevisionOut])
async def list_revisions(
    session: AsyncSession = Depends(get_session),
    limit: int = 100,
) -> list[Revision]:
    stmt = (
        select(Revision)
        .order_by(Revision.created_at.desc())
        .limit(limit)
    )
    return list((await session.scalars(stmt)).all())


@router.get("/{revision_id}", response_model=V2RevisionOut)
async def get_revision(
    revision_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> Revision:
    revision = await session.get(Revision, revision_id)
    if revision is None:
        raise HTTPException(status_code=404, detail="Revision not found")
    return revision
