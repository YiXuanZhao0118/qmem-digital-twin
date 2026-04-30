from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.assembly_solver import relation_creates_cycle, solve_relation
from app.db import get_session
from app.models import AssemblyRelation, Placement
from app.websocket import manager


router = APIRouter()


def relation_payload(relation: AssemblyRelation) -> dict[str, object]:
    return schemas.AssemblyRelationOut.model_validate(relation).model_dump(mode="json", by_alias=True)


def placement_payload(placement: Placement) -> dict[str, object]:
    return schemas.PlacementOut.model_validate(placement).model_dump(mode="json", by_alias=True)


async def broadcast_changed_placement(session: AsyncSession, placement: Placement | None) -> None:
    if placement is None:
        return
    await session.refresh(placement)
    payload = placement_payload(placement)
    await manager.broadcast("placement.updated", payload)
    await manager.broadcast("object.updated", payload)


async def validate_relation_objects(
    session: AsyncSession,
    object_a_id: uuid.UUID,
    object_b_id: uuid.UUID,
) -> None:
    await crud.get_or_404(session, Placement, object_a_id)
    await crud.get_or_404(session, Placement, object_b_id)


def current_relation_values(relation: AssemblyRelation) -> dict[str, Any]:
    return {
        "name": relation.name,
        "relation_type": relation.relation_type,
        "object_a_id": relation.object_a_id,
        "object_b_id": relation.object_b_id,
        "selector_a": relation.selector_a,
        "selector_b": relation.selector_b,
        "offset_mm": relation.offset_mm,
        "angle_deg": relation.angle_deg,
        "tolerance_mm": relation.tolerance_mm,
        "enabled": relation.enabled,
        "solved": relation.solved,
        "properties": relation.properties,
    }


@router.get("", response_model=list[schemas.AssemblyRelationOut])
async def list_assembly_relations(session: AsyncSession = Depends(get_session)) -> list[AssemblyRelation]:
    return await crud.list_all(session, AssemblyRelation)


@router.post("", response_model=schemas.AssemblyRelationOut, status_code=status.HTTP_201_CREATED)
async def create_assembly_relation(
    payload: schemas.AssemblyRelationCreate,
    session: AsyncSession = Depends(get_session),
) -> AssemblyRelation:
    await validate_relation_objects(session, payload.object_a_id, payload.object_b_id)
    relation = AssemblyRelation(**payload.model_dump())
    session.add(relation)
    await session.flush()
    if relation.enabled and await relation_creates_cycle(session, relation):
        raise HTTPException(status_code=409, detail="Circular relation detected")
    changed = await solve_relation(session, relation)
    await session.commit()
    await session.refresh(relation)
    await manager.broadcast("assembly_relation.updated", relation_payload(relation))
    await broadcast_changed_placement(session, changed)
    return relation


@router.get("/{relation_id}", response_model=schemas.AssemblyRelationOut)
async def get_assembly_relation(
    relation_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> AssemblyRelation:
    return await crud.get_or_404(session, AssemblyRelation, relation_id)


@router.put("/{relation_id}", response_model=schemas.AssemblyRelationOut)
async def update_assembly_relation(
    relation_id: uuid.UUID,
    payload: schemas.AssemblyRelationUpdate,
    session: AsyncSession = Depends(get_session),
) -> AssemblyRelation:
    relation = await crud.get_or_404(session, AssemblyRelation, relation_id)
    updates = payload.model_dump(exclude_unset=True)
    candidate = {**current_relation_values(relation), **updates}
    validated = schemas.AssemblyRelationCreate(**candidate)
    await validate_relation_objects(session, validated.object_a_id, validated.object_b_id)
    crud.apply_updates(relation, updates)
    await session.flush()
    if relation.enabled and await relation_creates_cycle(session, relation):
        raise HTTPException(status_code=409, detail="Circular relation detected")
    changed = await solve_relation(session, relation)
    await session.commit()
    await session.refresh(relation)
    await manager.broadcast("assembly_relation.updated", relation_payload(relation))
    await broadcast_changed_placement(session, changed)
    return relation


@router.delete("/{relation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_assembly_relation(
    relation_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> Response:
    relation = await crud.get_or_404(session, AssemblyRelation, relation_id)
    payload = relation_payload(relation)
    await session.delete(relation)
    await session.commit()
    payload["deleted"] = True
    await manager.broadcast("assembly_relation.updated", payload)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
