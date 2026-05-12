"""RF chain CRUD + bulk replace — Phase RF.2.

The chain is a flat ordered list of nodes per terminal SceneObject.
Most editors will use the bulk-replace endpoint (`PUT /chains/{obj}`)
to atomically rewrite the chain after a drag-reorder; the per-node
CRUD endpoints are there for fine-tuning a single node's gain or
linked circuit.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import RfChainNode
from app.schemas import (
    RfChainBulkReplace,
    RfChainNodeCreate,
    RfChainNodeOut,
    RfChainNodeUpdate,
)


router = APIRouter()


@router.get("/nodes", response_model=list[RfChainNodeOut])
async def list_nodes(
    terminal_scene_object_id: uuid.UUID | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
) -> list[RfChainNode]:
    stmt = select(RfChainNode).order_by(RfChainNode.position_in_chain.asc())
    if terminal_scene_object_id is not None:
        stmt = stmt.where(RfChainNode.terminal_scene_object_id == terminal_scene_object_id)
    return list((await session.scalars(stmt)).all())


@router.post(
    "/nodes",
    response_model=RfChainNodeOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_node(
    payload: RfChainNodeCreate,
    session: AsyncSession = Depends(get_session),
) -> RfChainNode:
    row = RfChainNode(
        terminal_scene_object_id=payload.terminal_scene_object_id,
        position_in_chain=payload.position_in_chain,
        node_kind=payload.node_kind,
        label=payload.label,
        gain_db=payload.gain_db,
        kind_params=payload.kind_params,
        linked_circuit_id=payload.linked_circuit_id,
        linked_em_problem_id=payload.linked_em_problem_id,
    )
    session.add(row)
    try:
        await session.commit()
    except Exception as exc:  # likely unique-violation on (terminal, position)
        await session.rollback()
        raise HTTPException(status_code=400, detail=f"create failed: {exc}") from exc
    await session.refresh(row)
    return row


@router.patch("/nodes/{node_id}", response_model=RfChainNodeOut)
async def update_node(
    node_id: uuid.UUID,
    patch: RfChainNodeUpdate,
    session: AsyncSession = Depends(get_session),
) -> RfChainNode:
    row = await session.get(RfChainNode, node_id)
    if row is None:
        raise HTTPException(status_code=404, detail="RfChainNode not found")
    for field, value in patch.model_dump(exclude_unset=True, by_alias=False).items():
        setattr(row, field, value)
    row.updated_at = datetime.now(timezone.utc)
    await session.commit()
    await session.refresh(row)
    return row


@router.delete("/nodes/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_node(
    node_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> None:
    row = await session.get(RfChainNode, node_id)
    if row is None:
        raise HTTPException(status_code=404, detail="RfChainNode not found")
    await session.delete(row)
    await session.commit()


@router.put("/chains/{terminal_scene_object_id}", response_model=list[RfChainNodeOut])
async def replace_chain(
    terminal_scene_object_id: uuid.UUID,
    payload: RfChainBulkReplace,
    session: AsyncSession = Depends(get_session),
) -> list[RfChainNode]:
    """Atomically replace the entire chain that terminates at the given
    SceneObject. The path parameter must match the body's
    `terminalSceneObjectId` (sanity check)."""

    if payload.terminal_scene_object_id != terminal_scene_object_id:
        raise HTTPException(
            status_code=400,
            detail="terminalSceneObjectId in body does not match path",
        )

    await session.execute(
        delete(RfChainNode).where(
            RfChainNode.terminal_scene_object_id == terminal_scene_object_id
        )
    )
    rows = [
        RfChainNode(
            terminal_scene_object_id=terminal_scene_object_id,
            position_in_chain=node.position_in_chain,
            node_kind=node.node_kind,
            label=node.label,
            gain_db=node.gain_db,
            kind_params=node.kind_params,
            linked_circuit_id=node.linked_circuit_id,
            linked_em_problem_id=node.linked_em_problem_id,
        )
        for node in payload.nodes
    ]
    session.add_all(rows)
    await session.commit()
    for r in rows:
        await session.refresh(r)
    return sorted(rows, key=lambda r: r.position_in_chain)
