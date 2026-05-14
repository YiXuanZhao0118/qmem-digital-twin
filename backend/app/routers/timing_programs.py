"""TimingProgram CRUD + SpinCore compile (alembic 0045/0046).

Programs are top-level objects identified by their own UUID. Consumers
(rfSources.triggerBinding / gateBinding, AOM/EOM TTL gates, ...) reference
programs by ``id``; a single program may be shared across multiple
consumers. Each program optionally binds to a PB hardware channel via
``channel_index`` (UNIQUE partial index — one wire, one schedule).
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.db import get_session
from app.models import TimingProgram
from app.schemas import CamelModel
from app.solvers.spinapi_compile import compile_to_opcodes, render_spinapi_python
from app.websocket import manager


router = APIRouter()


def _program_payload(program: TimingProgram) -> dict[str, object]:
    return schemas.TimingProgramOut.model_validate(program).model_dump(
        mode="json", by_alias=True
    )


async def _broadcast(program: TimingProgram) -> None:
    await manager.broadcast("timing_program.updated", _program_payload(program))


async def _broadcast_deleted(program_id: uuid.UUID) -> None:
    await manager.broadcast("timing_program.deleted", {"id": str(program_id)})


def _intervals_for_db(payload: schemas.TimingProgramBase) -> list[dict[str, float]]:
    """Serialize Pydantic IntervalBase models as camelCase dicts for JSONB."""
    return [iv.model_dump(by_alias=True) for iv in payload.intervals]


async def _check_channel_conflict(
    session: AsyncSession,
    channel_index: int | None,
    *,
    exclude_program_id: uuid.UUID | None = None,
) -> None:
    """Raise 400 if another program already owns ``channel_index``."""
    if channel_index is None:
        return
    stmt = select(TimingProgram).where(TimingProgram.channel_index == channel_index)
    if exclude_program_id is not None:
        stmt = stmt.where(TimingProgram.id != exclude_program_id)
    existing = (await session.scalars(stmt)).first()
    if existing is not None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"PB channel {channel_index} is already bound to program "
                f"{existing.id} ({existing.name or 'unnamed'}). Move that "
                f"program off channel {channel_index} first or pick another channel."
            ),
        )


@router.get("", response_model=list[schemas.TimingProgramOut])
async def list_programs(
    session: AsyncSession = Depends(get_session),
) -> list[TimingProgram]:
    return list(
        (await session.scalars(select(TimingProgram).order_by(TimingProgram.created_at.asc()))).all()
    )


@router.get("/{program_id}", response_model=schemas.TimingProgramOut)
async def get_program(
    program_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> TimingProgram:
    program = await session.get(TimingProgram, program_id)
    if program is None:
        raise HTTPException(status_code=404, detail="TimingProgram not found")
    return program


@router.post(
    "",
    response_model=schemas.TimingProgramOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_program(
    payload: schemas.TimingProgramCreate,
    session: AsyncSession = Depends(get_session),
) -> TimingProgram:
    await _check_channel_conflict(session, payload.channel_index)
    program = TimingProgram(
        name=payload.name,
        kind=payload.kind,
        channel_index=payload.channel_index,
        invert=payload.invert,
        intervals=_intervals_for_db(payload),
    )
    session.add(program)
    await session.commit()
    await session.refresh(program)
    await _broadcast(program)
    return program


@router.put("/{program_id}", response_model=schemas.TimingProgramOut)
async def update_program(
    program_id: uuid.UUID,
    payload: schemas.TimingProgramUpdate,
    session: AsyncSession = Depends(get_session),
) -> TimingProgram:
    program = await session.get(TimingProgram, program_id)
    if program is None:
        raise HTTPException(status_code=404, detail="TimingProgram not found")
    if payload.name is not None:
        program.name = payload.name
    if payload.kind is not None:
        program.kind = payload.kind
    if "channel_index" in payload.model_fields_set:
        await _check_channel_conflict(
            session, payload.channel_index, exclude_program_id=program_id
        )
        program.channel_index = payload.channel_index
    if payload.invert is not None:
        program.invert = payload.invert
    if payload.intervals is not None:
        program.intervals = [iv.model_dump(by_alias=True) for iv in payload.intervals]
    await session.commit()
    await session.refresh(program)
    await _broadcast(program)
    return program


@router.delete("/{program_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_program(
    program_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> Response:
    program = await session.get(TimingProgram, program_id)
    if program is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    await session.delete(program)
    await session.commit()
    await _broadcast_deleted(program_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- SpinCore compile -------------------------------------------------------


class CompiledInstructionOut(CamelModel):
    index: int
    output_state: int
    opcode: str
    data: int
    length_ns: float
    label: str | None = None


class CompileOut(CamelModel):
    instructions: list[CompiledInstructionOut]
    python_source: str
    bound_program_count: int
    total_duration_ns: float


@router.get("/compile/spinapi", response_model=CompileOut)
async def compile_spinapi(
    session: AsyncSession = Depends(get_session),
) -> CompileOut:
    """Compile every channel-bound TimingProgram into a SpinCore opcode stream.

    Programs with ``channel_index IS NULL`` are skipped (unbound — no hardware
    wire to emit them on). Returns the structured instruction list plus a
    Python ``spinapi`` rendering suitable for drop-in into a PB script.
    """
    programs = list(
        (
            await session.scalars(
                select(TimingProgram).where(TimingProgram.channel_index.isnot(None))
            )
        ).all()
    )
    instructions = compile_to_opcodes(
        [
            {
                "id": str(p.id),
                "kind": p.kind,
                "channel_index": p.channel_index,
                "invert": p.invert,
                "intervals": p.intervals or [],
            }
            for p in programs
        ]
    )
    total_ns = sum(inst.length_ns for inst in instructions)
    return CompileOut(
        instructions=[
            CompiledInstructionOut(
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
        bound_program_count=len(programs),
        total_duration_ns=total_ns,
    )
