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
from app.models import (
    PulseBlasterChannel,
    SceneObject,
    TimingBlock,
    TimingProgram,
)
from app.schemas import (
    PulseBlasterChannelBulkUpsert,
    PulseBlasterChannelCreate,
    PulseBlasterChannelOut,
    PulseBlasterChannelUpdate,
    PulseBlasterCompileOut,
    PulseBlasterInstructionOut,
)
from app.solvers.spinapi_compile import (
    PbInstruction,
    compile_to_opcodes,
    render_spinapi_python,
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


@router.get("/compile", response_model=PulseBlasterCompileOut)
async def compile_program(
    session: AsyncSession = Depends(get_session),
) -> PulseBlasterCompileOut:
    """Phase PB.4 — compile bound channels + per-Component TimingPrograms
    into a flat SpinCore opcode stream. Returns both a structured list
    (for UI display) and a Python source rendering (for download / paste
    into a spinapi script)."""

    channel_rows = list(
        (
            await session.scalars(
                select(PulseBlasterChannel).order_by(PulseBlasterChannel.channel_index.asc())
            )
        ).all()
    )

    # For every bound component, find one SceneObject with that component
    # and pull its TimingProgram + blocks. A component may have N
    # instances; we pick the first (alphabetical id) that has a program.
    bound_components = {
        ch.target_component_id
        for ch in channel_rows
        if ch.enabled and ch.target_component_id is not None
    }

    programs_by_component: dict[str, dict] = {}
    if bound_components:
        objs = list(
            (
                await session.scalars(
                    select(SceneObject).where(SceneObject.component_id.in_(bound_components))
                )
            ).all()
        )
        # Group by component_id so we can pick a deterministic representative.
        objs.sort(key=lambda o: str(o.id))
        comp_to_object: dict[str, list[SceneObject]] = {}
        for o in objs:
            comp_to_object.setdefault(str(o.component_id), []).append(o)

        # Hydrate programs + blocks for each candidate object until we find one with a program.
        for comp_id, candidates in comp_to_object.items():
            for o in candidates:
                program = await session.get(TimingProgram, o.id)
                if program is None:
                    continue
                blocks = list(
                    (
                        await session.scalars(
                            select(TimingBlock)
                            .where(TimingBlock.program_object_id == o.id)
                            .order_by(TimingBlock.t_start_ns.asc())
                        )
                    ).all()
                )
                programs_by_component[comp_id] = {
                    "object_id": str(o.id),
                    "blocks": [
                        {
                            "t_start_ns": b.t_start_ns,
                            "t_end_ns": b.t_end_ns,
                            "waveform_kind": b.waveform_kind,
                            "params": b.params or {},
                        }
                        for b in blocks
                    ],
                }
                break

    instructions = compile_to_opcodes(
        channels=[
            {
                "channel_index": ch.channel_index,
                "label": ch.label,
                "target_component_id": (
                    str(ch.target_component_id) if ch.target_component_id else None
                ),
                "invert": ch.invert,
                "enabled": ch.enabled,
            }
            for ch in channel_rows
        ],
        programs_by_component=programs_by_component,
    )

    total_ns = sum(inst.length_ns for inst in instructions)

    return PulseBlasterCompileOut(
        instructions=[
            PulseBlasterInstructionOut(
                index=inst.index,
                output_state=inst.output_state,
                opcode=inst.opcode,
                data=inst.data,
                length_ns=inst.length_ns,
                label=inst.label,
            )
            for inst in instructions
        ],
        python_source=render_spinapi_python(instructions),
        bound_channel_count=len(bound_components),
        total_duration_ns=total_ns,
    )
