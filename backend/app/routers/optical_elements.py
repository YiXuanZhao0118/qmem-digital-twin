from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.db import get_session
from app.models import Component, OpticalElement
from app.websocket import manager


router = APIRouter()


def element_payload(element: OpticalElement) -> dict[str, object]:
    return schemas.OpticalElementOut.model_validate(element).model_dump(mode="json", by_alias=True)


@router.get("", response_model=list[schemas.OpticalElementOut])
async def list_optical_elements(session: AsyncSession = Depends(get_session)) -> list[OpticalElement]:
    return await crud.list_all(session, OpticalElement)


@router.post("", response_model=schemas.OpticalElementOut, status_code=status.HTTP_201_CREATED)
async def create_optical_element(
    payload: schemas.OpticalElementCreate, session: AsyncSession = Depends(get_session)
) -> OpticalElement:
    await crud.get_or_404(session, Component, payload.component_id)
    existing = await session.get(OpticalElement, payload.component_id)
    if existing is not None:
        raise HTTPException(status_code=409, detail="OpticalElement already exists for this component.")

    data = payload.model_dump(by_alias=False)
    # Ports come back as Pydantic model dicts; ensure JSONB-friendly form.
    data["input_ports"] = [
        port.model_dump(by_alias=True) if hasattr(port, "model_dump") else port
        for port in payload.input_ports
    ]
    data["output_ports"] = [
        port.model_dump(by_alias=True) if hasattr(port, "model_dump") else port
        for port in payload.output_ports
    ]
    data["wavelength_range_nm"] = list(payload.wavelength_range_nm)
    element = OpticalElement(**data)
    session.add(element)
    await session.commit()
    await session.refresh(element)
    await manager.broadcast("optical_element.updated", element_payload(element))
    return element


@router.get("/{component_id}", response_model=schemas.OpticalElementOut)
async def get_optical_element(
    component_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> OpticalElement:
    return await crud.get_or_404(session, OpticalElement, component_id)


@router.put("/{component_id}", response_model=schemas.OpticalElementOut)
async def update_optical_element(
    component_id: uuid.UUID,
    payload: schemas.OpticalElementUpdate,
    session: AsyncSession = Depends(get_session),
) -> OpticalElement:
    element = await crud.get_or_404(session, OpticalElement, component_id)

    incoming = payload.model_dump(exclude_unset=True, by_alias=False)
    # Re-validate the merged result through OpticalElementBase so kind_params
    # and ports remain consistent with element_kind.
    merged = schemas.OpticalElementBase(
        element_kind=incoming.get("element_kind", element.element_kind),
        wavelength_range_nm=tuple(incoming.get("wavelength_range_nm", element.wavelength_range_nm)),
        input_ports=incoming.get("input_ports", element.input_ports) or [],
        output_ports=incoming.get("output_ports", element.output_ports) or [],
        kind_params=incoming.get("kind_params", element.kind_params) or {},
    )
    element.element_kind = merged.element_kind
    element.wavelength_range_nm = list(merged.wavelength_range_nm)
    element.input_ports = [p.model_dump(by_alias=True) for p in merged.input_ports]
    element.output_ports = [p.model_dump(by_alias=True) for p in merged.output_ports]
    element.kind_params = merged.kind_params

    await session.commit()
    await session.refresh(element)
    await manager.broadcast("optical_element.updated", element_payload(element))
    return element


@router.delete("/{component_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_optical_element(
    component_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Response:
    element = await crud.get_or_404(session, OpticalElement, component_id)
    await session.delete(element)
    await session.commit()
    await manager.broadcast(
        "optical_element.updated", {"componentId": str(component_id), "deleted": True}
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
