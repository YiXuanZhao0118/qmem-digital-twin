from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.db import get_session
from app.models import OpticalElement, SceneObject
from app.v2_bindings import (
    V2_TRACKED_LASER_KEYS,
    beam_from_legacy_laser_kind_params,
    get_optical_source,
    legacy_laser_kind_params_from_beam,
)
from app.websocket import manager


router = APIRouter()


async def _serialize_optical_elements(
    session: AsyncSession, elements: list[OpticalElement]
) -> list[dict[str, object]]:
    """V2 Phase 3 (alembic 0029) translator boundary for the
    /api/optical-elements GET responses.

    DB stores empty kindParams for laser_source post-cutover; the legacy
    shape is synthesised on-the-fly from
    objects.properties.opticalSources[].beam so existing frontend readers
    keep working.

    We build plain dicts (not mutated SA rows) to avoid triggering an
    autoflush during Pydantic serialisation of the response.
    """
    payloads = [
        schemas.OpticalElementOut.model_validate(el).model_dump(mode="json", by_alias=True)
        for el in elements
    ]
    laser_object_ids = [
        el.object_id for el in elements if el.element_kind == "laser_source"
    ]
    if not laser_object_ids:
        return payloads
    rows = (
        await session.scalars(
            select(SceneObject).where(SceneObject.id.in_(laser_object_ids))
        )
    ).all()
    objects_by_id = {row.id: row for row in rows}
    for payload, el in zip(payloads, elements):
        if el.element_kind != "laser_source":
            continue
        scene_object = objects_by_id.get(el.object_id)
        source = get_optical_source(scene_object) if scene_object is not None else None
        beam = source.get("beam") if isinstance(source, dict) else None
        if isinstance(beam, dict):
            payload["kindParams"] = {
                **(payload.get("kindParams") or {}),
                **legacy_laser_kind_params_from_beam(beam),
            }
    return payloads


def element_payload(element: OpticalElement) -> dict[str, object]:
    return schemas.OpticalElementOut.model_validate(element).model_dump(mode="json", by_alias=True)


async def _get_by_object(session: AsyncSession, object_id: uuid.UUID) -> OpticalElement | None:
    stmt = select(OpticalElement).where(OpticalElement.object_id == object_id)
    return (await session.scalars(stmt)).one_or_none()


@router.get("", response_model=list[schemas.OpticalElementOut])
async def list_optical_elements(session: AsyncSession = Depends(get_session)) -> list[dict[str, object]]:
    elements = await crud.list_all(session, OpticalElement)
    return await _serialize_optical_elements(session, elements)


@router.post("", response_model=schemas.OpticalElementOut, status_code=status.HTTP_201_CREATED)
async def create_optical_element(
    payload: schemas.OpticalElementCreate, session: AsyncSession = Depends(get_session)
) -> OpticalElement:
    # Ensure the SceneObject exists.
    await crud.get_or_404(session, SceneObject, payload.object_id)
    existing = await _get_by_object(session, payload.object_id)
    if existing is not None:
        raise HTTPException(status_code=409, detail="OpticalElement already exists for this object.")

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


@router.get("/{object_id}", response_model=schemas.OpticalElementOut)
async def get_optical_element(
    object_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> OpticalElement:
    el = await _get_by_object(session, object_id)
    if el is None:
        raise HTTPException(status_code=404, detail="OpticalElement not found for this object.")
    payloads = await _serialize_optical_elements(session, [el])
    return payloads[0]


@router.put("/{object_id}", response_model=schemas.OpticalElementOut)
async def update_optical_element(
    object_id: uuid.UUID,
    payload: schemas.OpticalElementUpdate,
    session: AsyncSession = Depends(get_session),
) -> OpticalElement:
    element = await _get_by_object(session, object_id)
    if element is None:
        raise HTTPException(status_code=404, detail="OpticalElement not found for this object.")

    incoming = payload.model_dump(exclude_unset=True, by_alias=False)
    raw_kind_params = incoming.get("kind_params", element.kind_params) or {}
    merged = schemas.OpticalElementBase(
        element_kind=incoming.get("element_kind", element.element_kind),
        wavelength_range_nm=tuple(incoming.get("wavelength_range_nm", element.wavelength_range_nm)),
        input_ports=incoming.get("input_ports", element.input_ports) or [],
        output_ports=incoming.get("output_ports", element.output_ports) or [],
        kind_params=raw_kind_params,
    )
    element.element_kind = merged.element_kind
    element.wavelength_range_nm = list(merged.wavelength_range_nm)
    element.input_ports = [p.model_dump(by_alias=True) for p in merged.input_ports]
    element.output_ports = [p.model_dump(by_alias=True) for p in merged.output_ports]
    element.kind_params = merged.kind_params

    # V2 Phase 3 (alembic 0029): if the (V1-style) caller sent any
    # beam-defining laser kindParams, the schema validator silently dropped
    # them above. To preserve the user's edit, translate the legacy fields
    # into a V2 BeamSource and write that back to the SceneObject's
    # opticalSources[0].beam. The next read goes through the GET-side
    # synthesiser and the values round-trip.
    if element.element_kind == "laser_source" and isinstance(raw_kind_params, dict):
        v1_changes = {
            k: v for k, v in raw_kind_params.items() if k in V2_TRACKED_LASER_KEYS
        }
        if v1_changes:
            scene_object = await session.get(SceneObject, object_id)
            if scene_object is not None:
                source = get_optical_source(scene_object)
                if source is None:
                    new_beam = beam_from_legacy_laser_kind_params(v1_changes)
                    properties = dict(scene_object.properties or {})
                    sources = list(properties.get("opticalSources") or [])
                    sources.append({"id": "tmp", "bindingId": "tmp", "enabled": True, "beam": new_beam})
                    properties["opticalSources"] = sources
                    scene_object.properties = properties
                else:
                    # Merge legacy fields onto the existing beam by round-tripping
                    # through the inverse translator on the merged set.
                    current_legacy = legacy_laser_kind_params_from_beam(source.get("beam") or {})
                    merged_legacy = {**current_legacy, **v1_changes}
                    new_beam = beam_from_legacy_laser_kind_params(merged_legacy)
                    properties = dict(scene_object.properties or {})
                    sources = list(properties.get("opticalSources") or [])
                    new_sources = []
                    replaced = False
                    for s in sources:
                        if isinstance(s, dict) and s is source and not replaced:
                            new_sources.append({**s, "beam": new_beam})
                            replaced = True
                        elif isinstance(s, dict) and s.get("id") == source.get("id") and not replaced:
                            new_sources.append({**s, "beam": new_beam})
                            replaced = True
                        else:
                            new_sources.append(s)
                    if not replaced:
                        new_sources.append({**source, "beam": new_beam})
                    properties["opticalSources"] = new_sources
                    scene_object.properties = properties

    await session.commit()
    await session.refresh(element)

    # Re-synthesise legacy kindParams for the response so the caller sees the
    # post-write beam state in the legacy shape it sent.
    payloads = await _serialize_optical_elements(session, [element])
    await manager.broadcast("optical_element.updated", payloads[0])
    return payloads[0]


@router.delete("/{object_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_optical_element(
    object_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Response:
    element = await _get_by_object(session, object_id)
    if element is None:
        raise HTTPException(status_code=404, detail="OpticalElement not found for this object.")
    await session.delete(element)
    await session.commit()
    await manager.broadcast(
        "optical_element.updated", {"objectId": str(object_id), "deleted": True}
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
