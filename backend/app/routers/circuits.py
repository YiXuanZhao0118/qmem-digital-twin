"""Circuits CRUD — Phase B.1 of the multiphysics platform.

Owns the ``circuits`` table (alembic 0037). Each row holds one SPICE
netlist; the ``solvers/spice.py`` runner reads ``params.circuitId`` from
``POST /api/simulation-runs`` to know which netlist to feed ngspice.

Phase E will add a visual schematic editor that compiles to the same
``netlist`` field; the JSONB ``schematic`` column reserves space for
that without requiring another migration.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Circuit
from app.schemas import CircuitCreate, CircuitOut, CircuitUpdate


router = APIRouter()


@router.get("", response_model=list[CircuitOut])
async def list_circuits(
    session: AsyncSession = Depends(get_session),
    scene_object_id: uuid.UUID | None = Query(
        default=None, description="Filter to circuits bound to this SceneObject"
    ),
    limit: int = Query(default=200, ge=1, le=1000),
) -> list[Circuit]:
    stmt = select(Circuit).order_by(Circuit.updated_at.desc()).limit(limit)
    if scene_object_id is not None:
        stmt = stmt.where(Circuit.scene_object_id == scene_object_id)
    return list((await session.scalars(stmt)).all())


@router.get("/{circuit_id}", response_model=CircuitOut)
async def get_circuit(
    circuit_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> Circuit:
    circuit = await session.get(Circuit, circuit_id)
    if circuit is None:
        raise HTTPException(status_code=404, detail="Circuit not found")
    return circuit


@router.post("", response_model=CircuitOut, status_code=status.HTTP_201_CREATED)
async def create_circuit(
    payload: CircuitCreate,
    session: AsyncSession = Depends(get_session),
) -> Circuit:
    circuit = Circuit(
        name=payload.name,
        netlist=payload.netlist,
        schematic=payload.schematic,
        scene_object_id=payload.scene_object_id,
    )
    session.add(circuit)
    await session.commit()
    await session.refresh(circuit)
    return circuit


@router.patch("/{circuit_id}", response_model=CircuitOut)
async def update_circuit(
    circuit_id: uuid.UUID,
    patch: CircuitUpdate,
    session: AsyncSession = Depends(get_session),
) -> Circuit:
    circuit = await session.get(Circuit, circuit_id)
    if circuit is None:
        raise HTTPException(status_code=404, detail="Circuit not found")

    data = patch.model_dump(exclude_unset=True, by_alias=False)
    for field, value in data.items():
        setattr(circuit, field, value)
    circuit.updated_at = datetime.now(timezone.utc)

    await session.commit()
    await session.refresh(circuit)
    return circuit


@router.delete("/{circuit_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_circuit(
    circuit_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> None:
    circuit = await session.get(Circuit, circuit_id)
    if circuit is None:
        raise HTTPException(status_code=404, detail="Circuit not found")
    await session.delete(circuit)
    await session.commit()
