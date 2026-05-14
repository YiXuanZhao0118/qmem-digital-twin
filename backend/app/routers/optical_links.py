from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from sqlalchemy import select

from app import crud, schemas
from app.db import get_session
from app.models import PhysicsElement, OpticalLink
from app.websocket import manager


router = APIRouter()


def link_payload(link: OpticalLink) -> dict[str, object]:
    return schemas.OpticalLinkOut.model_validate(link).model_dump(mode="json", by_alias=True)


def _port_ids(ports: list, role: str) -> set[str]:
    ids: set[str] = set()
    for port in ports or []:
        if isinstance(port, dict) and port.get("role") == role:
            value = port.get("portId") or port.get("port_id") or port.get("id")
            if value:
                ids.add(str(value))
    return ids


async def _get_physics_element_by_object(session: AsyncSession, object_id) -> PhysicsElement | None:
    stmt = select(PhysicsElement).where(PhysicsElement.object_id == object_id)
    return (await session.scalars(stmt)).one_or_none()


async def validate_ports(session: AsyncSession, payload: schemas.OpticalLinkBase) -> None:
    # Reject self-loops outright — an optical link cannot have the same
    # SCENE OBJECT as both source and target. The chain solver treats this
    # as a cycle and refuses to run, so we catch it at insert time.
    if payload.from_object_id == payload.to_object_id:
        raise HTTPException(
            status_code=400,
            detail=(
                "Optical link cannot loop back to the same object "
                f"({payload.from_object_id}). Pick a different target."
            ),
        )
    source = await _get_physics_element_by_object(session, payload.from_object_id)
    if source is None:
        raise HTTPException(
            status_code=400,
            detail="from_object_id has no optical element record.",
        )
    if payload.from_port not in _port_ids(source.output_ports, "output"):
        raise HTTPException(
            status_code=400,
            detail=f"from_port '{payload.from_port}' is not an output of the source element.",
        )

    target = await _get_physics_element_by_object(session, payload.to_object_id)
    if target is None:
        raise HTTPException(
            status_code=400,
            detail="to_object_id has no optical element record.",
        )
    if payload.to_port not in _port_ids(target.input_ports, "input"):
        raise HTTPException(
            status_code=400,
            detail=f"to_port '{payload.to_port}' is not an input of the target element.",
        )


@router.get("", response_model=list[schemas.OpticalLinkOut])
async def list_optical_links(session: AsyncSession = Depends(get_session)) -> list[OpticalLink]:
    return await crud.list_all(session, OpticalLink)


@router.post("", response_model=schemas.OpticalLinkOut, status_code=status.HTTP_201_CREATED)
async def create_optical_link(
    payload: schemas.OpticalLinkCreate, session: AsyncSession = Depends(get_session)
) -> OpticalLink:
    await validate_ports(session, payload)
    link = OpticalLink(**payload.model_dump())
    session.add(link)
    await session.commit()
    await session.refresh(link)
    await manager.broadcast("optical_link.updated", link_payload(link))
    return link


@router.put("/{link_id}", response_model=schemas.OpticalLinkOut)
async def update_optical_link(
    link_id: uuid.UUID,
    payload: schemas.OpticalLinkUpdate,
    session: AsyncSession = Depends(get_session),
) -> OpticalLink:
    link = await crud.get_or_404(session, OpticalLink, link_id)
    updates = payload.model_dump(exclude_unset=True)
    # Same self-loop guard as create — re-checked against the merged result.
    new_from = updates.get("from_object_id", link.from_object_id)
    new_to = updates.get("to_object_id", link.to_object_id)
    if new_from == new_to:
        raise HTTPException(
            status_code=400,
            detail=(
                "Optical link cannot loop back to the same object "
                f"({new_from}). Pick a different target."
            ),
        )
    crud.apply_updates(link, updates)
    await session.commit()
    await session.refresh(link)
    await manager.broadcast("optical_link.updated", link_payload(link))
    return link


@router.delete("/{link_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_optical_link(
    link_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Response:
    link = await crud.get_or_404(session, OpticalLink, link_id)
    await session.delete(link)
    await session.commit()
    await manager.broadcast("optical_link.updated", {"id": str(link_id), "deleted": True})
    return Response(status_code=status.HTTP_204_NO_CONTENT)
