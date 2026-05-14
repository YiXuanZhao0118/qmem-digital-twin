"""Lab-wide singleton settings shared across all users (alembic 0043).

First key: ``room_dimensions`` (Initial Setup). Previously each browser
stored its own copy in localStorage, so two users opening the app saw
different floor sizes for the same lab — fixed by routing through the
backend.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import AppSetting
from app.schemas import RoomDimensions


router = APIRouter()


ROOM_DIMENSIONS_KEY = "room_dimensions"
DEFAULT_ROOM_DIMENSIONS = RoomDimensions(width_mm=4200, depth_mm=1800, height_mm=4000)


@router.get("/room-dimensions", response_model=RoomDimensions)
async def get_room_dimensions(
    session: AsyncSession = Depends(get_session),
) -> RoomDimensions:
    row = await session.get(AppSetting, ROOM_DIMENSIONS_KEY)
    if row is None:
        return DEFAULT_ROOM_DIMENSIONS
    return RoomDimensions.model_validate(row.value)


@router.put("/room-dimensions", response_model=RoomDimensions)
async def put_room_dimensions(
    payload: RoomDimensions,
    session: AsyncSession = Depends(get_session),
) -> RoomDimensions:
    value = payload.model_dump(by_alias=True)
    stmt = (
        pg_insert(AppSetting)
        .values(key=ROOM_DIMENSIONS_KEY, value=value)
        .on_conflict_do_update(
            index_elements=[AppSetting.key],
            set_={"value": value},
        )
    )
    await session.execute(stmt)
    await session.commit()
    return payload
