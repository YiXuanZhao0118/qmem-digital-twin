from __future__ import annotations

import uuid
from typing import TypeVar

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Base


ModelT = TypeVar("ModelT", bound=Base)


async def get_or_404(session: AsyncSession, model: type[ModelT], item_id: uuid.UUID) -> ModelT:
    item = await session.get(model, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail=f"{model.__name__} not found")
    return item


async def list_all(session: AsyncSession, model: type[ModelT]) -> list[ModelT]:
    result = await session.scalars(select(model))
    return list(result.all())


def apply_updates(item: ModelT, values: dict[str, object]) -> ModelT:
    for key, value in values.items():
        setattr(item, key, value)
    return item

