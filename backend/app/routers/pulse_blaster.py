"""PulseBlaster channel CRUD + bulk upsert — Phase F+.

Single-PulseBlaster MVP. Lab plumbing layer that maps physical TTL
channels (0..N-1) to lab Components. The actual gating sequence per
device lives in TimingProgram; this router just owns the wiring.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import PulseBlasterChannel
from app.schemas import (
    PulseBlasterChannelBulkUpsert,
    PulseBlasterChannelCreate,
    PulseBlasterChannelOut,
    PulseBlasterChannelUpdate,
)


router = APIRouter()


@router.get("/channels", response_model=list[PulseBlasterChannelOut])
async def list_channels(
    session: AsyncSession = Depends(get_session),
) -> list[PulseBlasterChannel]:
    stmt = select(PulseBlasterChannel).order_by(PulseBlasterChannel.channel_index.asc())
    return list((await session.scalars(stmt)).all())


@router.get("/channels/{channel_id}", response_model=PulseBlasterChannelOut)
async def get_channel(
    channel_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> PulseBlasterChannel:
    row = await session.get(PulseBlasterChannel, channel_id)
    if row is None:
        raise HTTPException(status_code=404, detail="PulseBlasterChannel not found")
    return row


@router.post(
    "/channels",
    response_model=PulseBlasterChannelOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_channel(
    payload: PulseBlasterChannelCreate,
    session: AsyncSession = Depends(get_session),
) -> PulseBlasterChannel:
    row = PulseBlasterChannel(
        channel_index=payload.channel_index,
        label=payload.label,
        target_component_id=payload.target_component_id,
        invert=payload.invert,
        enabled=payload.enabled,
    )
    session.add(row)
    try:
        await session.commit()
    except Exception as exc:  # likely unique-violation on channel_index
        await session.rollback()
        raise HTTPException(status_code=400, detail=f"create failed: {exc}") from exc
    await session.refresh(row)
    return row


@router.patch("/channels/{channel_id}", response_model=PulseBlasterChannelOut)
async def update_channel(
    channel_id: uuid.UUID,
    patch: PulseBlasterChannelUpdate,
    session: AsyncSession = Depends(get_session),
) -> PulseBlasterChannel:
    row = await session.get(PulseBlasterChannel, channel_id)
    if row is None:
        raise HTTPException(status_code=404, detail="PulseBlasterChannel not found")
    for field, value in patch.model_dump(exclude_unset=True, by_alias=False).items():
        setattr(row, field, value)
    row.updated_at = datetime.now(timezone.utc)
    await session.commit()
    await session.refresh(row)
    return row


@router.delete(
    "/channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_channel(
    channel_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> None:
    row = await session.get(PulseBlasterChannel, channel_id)
    if row is None:
        raise HTTPException(status_code=404, detail="PulseBlasterChannel not found")
    await session.delete(row)
    await session.commit()


@router.put("/channels", response_model=list[PulseBlasterChannelOut])
async def bulk_upsert_channels(
    payload: PulseBlasterChannelBulkUpsert,
    session: AsyncSession = Depends(get_session),
) -> list[PulseBlasterChannel]:
    """Replace-all: wipe + re-insert. Convenient for the 24-row grid UI."""
    await session.execute(delete(PulseBlasterChannel))
    rows = [
        PulseBlasterChannel(
            channel_index=ch.channel_index,
            label=ch.label,
            target_component_id=ch.target_component_id,
            invert=ch.invert,
            enabled=ch.enabled,
        )
        for ch in payload.channels
    ]
    session.add_all(rows)
    await session.commit()
    for r in rows:
        await session.refresh(r)
    return rows
