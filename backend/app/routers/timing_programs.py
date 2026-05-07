from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app import schemas
from app.db import get_session
from app.models import SceneObject, TimingBlock, TimingProgram
from app.websocket import manager


router = APIRouter()


# --- helpers ---------------------------------------------------------------


async def _load_program(
    session: AsyncSession, object_id: uuid.UUID
) -> TimingProgram | None:
    """Fetch a program with its blocks eager-loaded (avoid N+1 on serialize)."""
    result = await session.scalars(
        select(TimingProgram)
        .where(TimingProgram.object_id == object_id)
        .options(selectinload(TimingProgram.blocks))
    )
    return result.first()


def _program_payload(program: TimingProgram) -> dict[str, object]:
    return schemas.TimingProgramOut.model_validate(program).model_dump(
        mode="json", by_alias=True
    )


async def _broadcast(program: TimingProgram) -> None:
    await manager.broadcast("timing_program.updated", _program_payload(program))


async def _broadcast_deleted(object_id: uuid.UUID) -> None:
    await manager.broadcast(
        "timing_program.deleted",
        {"objectId": str(object_id)},
    )


# --- routes ----------------------------------------------------------------


@router.get("", response_model=list[schemas.TimingProgramOut])
async def list_programs(
    session: AsyncSession = Depends(get_session),
) -> list[TimingProgram]:
    result = await session.scalars(
        select(TimingProgram).options(selectinload(TimingProgram.blocks))
    )
    return list(result.all())


@router.get("/{object_id}", response_model=schemas.TimingProgramOut)
async def get_program(
    object_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> TimingProgram:
    program = await _load_program(session, object_id)
    if program is None:
        raise HTTPException(status_code=404, detail="Timing program not found")
    return program


@router.put("/{object_id}", response_model=schemas.TimingProgramOut)
async def upsert_program(
    object_id: uuid.UUID,
    payload: schemas.TimingProgramUpsert,
    session: AsyncSession = Depends(get_session),
) -> TimingProgram:
    """Create-or-replace an object's timing program (per-object since 0015).

    Same delete-then-insert pattern as before, just keyed by object_id.
    """
    from sqlalchemy import delete as sa_delete, insert as sa_insert, select as sa_select

    exists = await session.execute(
        sa_select(SceneObject.id).where(SceneObject.id == object_id).limit(1)
    )
    if exists.first() is None:
        raise HTTPException(status_code=404, detail="SceneObject not found")

    # Wipe any existing program for this object (cascades to blocks via FK).
    await session.execute(
        sa_delete(TimingProgram).where(TimingProgram.object_id == object_id)
    )

    # Insert the new program row.
    await session.execute(
        sa_insert(TimingProgram).values(
            object_id=object_id,
            name=payload.name,
            spin_core_start=payload.spin_core_start,
            duration_ns=payload.duration_ns,
            properties=payload.properties,
        )
    )

    # Insert blocks.
    if payload.blocks:
        block_rows = [
            {
                "program_object_id": object_id,
                "label": b.label,
                "t_start_ns": b.t_start_ns,
                "t_end_ns": b.t_end_ns,
                "waveform_kind": b.waveform_kind,
                "params": b.params,
                "sort_order": b.sort_order or i,
            }
            for i, b in enumerate(payload.blocks)
        ]
        await session.execute(sa_insert(TimingBlock), block_rows)

    await session.commit()
    program = await _load_program(session, object_id)
    assert program is not None
    await _broadcast(program)
    return program


@router.delete("/{object_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_program(
    object_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> Response:
    program = await _load_program(session, object_id)
    if program is None:
        # Idempotent — deleting a non-existent program returns 204 anyway.
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    await session.delete(program)
    await session.commit()
    await _broadcast_deleted(object_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
