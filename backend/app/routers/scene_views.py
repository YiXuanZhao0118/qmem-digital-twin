from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.db import get_session
from app.models import SceneView
from app.websocket import manager


router = APIRouter()


def scene_view_payload(view: SceneView) -> dict[str, object]:
    return schemas.SceneViewOut.model_validate(view).model_dump(mode="json", by_alias=True)


@router.get("", response_model=list[schemas.SceneViewOut])
async def list_scene_views(session: AsyncSession = Depends(get_session)) -> list[SceneView]:
    result = await session.scalars(
        select(SceneView).order_by(SceneView.sort_order.asc(), SceneView.created_at.asc())
    )
    return list(result.all())


@router.post("", response_model=schemas.SceneViewOut, status_code=status.HTTP_201_CREATED)
async def create_scene_view(
    payload: schemas.SceneViewCreate, session: AsyncSession = Depends(get_session)
) -> SceneView:
    if payload.is_default:
        await session.execute(update(SceneView).values(is_default=False))
    view = SceneView(**payload.model_dump())
    session.add(view)
    await session.commit()
    await session.refresh(view)
    await manager.broadcast("scene_view.updated", scene_view_payload(view))
    return view


@router.get("/{view_id}", response_model=schemas.SceneViewOut)
async def get_scene_view(
    view_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> SceneView:
    return await crud.get_or_404(session, SceneView, view_id)


@router.put("/{view_id}", response_model=schemas.SceneViewOut)
async def update_scene_view(
    view_id: uuid.UUID,
    payload: schemas.SceneViewUpdate,
    session: AsyncSession = Depends(get_session),
) -> SceneView:
    view = await crud.get_or_404(session, SceneView, view_id)
    updates = payload.model_dump(exclude_unset=True)
    if updates.get("is_default"):
        await session.execute(
            update(SceneView).where(SceneView.id != view_id).values(is_default=False)
        )
    crud.apply_updates(view, updates)
    await session.commit()
    await session.refresh(view)
    await manager.broadcast("scene_view.updated", scene_view_payload(view))
    return view


@router.delete("/{view_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_scene_view(
    view_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Response:
    view = await crud.get_or_404(session, SceneView, view_id)
    await session.delete(view)
    await session.commit()
    await manager.broadcast(
        "scene_view.updated", {"id": str(view_id), "deleted": True}
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{view_id}/duplicate", response_model=schemas.SceneViewOut, status_code=status.HTTP_201_CREATED)
async def duplicate_scene_view(
    view_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> SceneView:
    source = await crud.get_or_404(session, SceneView, view_id)
    clone = SceneView(
        name=f"{source.name} (copy)",
        description=source.description,
        icon=source.icon,
        color=source.color,
        filter_kind=source.filter_kind,
        filter_expr=source.filter_expr,
        overlay_overrides=source.overlay_overrides,
        is_default=False,
        is_pinned=source.is_pinned,
        sort_order=source.sort_order + 1,
        created_by=source.created_by,
    )
    session.add(clone)
    await session.commit()
    await session.refresh(clone)
    await manager.broadcast("scene_view.updated", scene_view_payload(clone))
    return clone


@router.put("/{view_id}/move", response_model=schemas.SceneViewOut)
async def move_scene_view(
    view_id: uuid.UUID,
    payload: dict[str, int],
    session: AsyncSession = Depends(get_session),
) -> SceneView:
    sort_order = payload.get("sortOrder")
    if sort_order is None:
        sort_order = payload.get("sort_order")
    if sort_order is None:
        raise HTTPException(status_code=400, detail="sortOrder is required")
    view = await crud.get_or_404(session, SceneView, view_id)
    view.sort_order = int(sort_order)
    await session.commit()
    await session.refresh(view)
    await manager.broadcast("scene_view.updated", scene_view_payload(view))
    return view
