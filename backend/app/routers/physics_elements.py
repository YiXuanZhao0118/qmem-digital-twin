from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.db import get_session
from sqlalchemy.orm.attributes import flag_modified

from app.models import PhysicsElement, SceneObject
from app.v2_bindings import (
    V2_TRACKED_AOM_KEYS,
    V2_TRACKED_BEAM_SPLITTER_KEYS,
    V2_TRACKED_ISOLATOR_KEYS,
    V2_TRACKED_LASER_KEYS,
    V2_TRACKED_POLARIZER_KEYS,
    V2_TRACKED_WAVEPLATE_KEYS,
    beam_from_legacy_laser_kind_params,
    get_optical_source,
    legacy_aom_kind_params_from_binding,
    legacy_beam_splitter_kind_params_from_bindings,
    legacy_isolator_kind_params_from_binding,
    legacy_laser_kind_params_from_beam,
    legacy_polarizer_kind_params_from_binding,
    legacy_waveplate_kind_params_from_binding,
    write_aom_rf_direction_body_local,
    write_beam_splitter_coating_normal,
    write_isolator_axis_deg_beam_local,
    write_polarizer_axis_deg_beam_local,
    write_waveplate_axis_deg_beam_local,
)
from app.websocket import manager


router = APIRouter()


async def _serialize_physics_elements(
    session: AsyncSession, elements: list[PhysicsElement]
) -> list[dict[str, object]]:
    """V2 Phase 3 (alembic 0029) translator boundary for the
    /api/physics-elements GET responses.

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
    v2_object_ids = [
        el.object_id
        for el in elements
        if el.element_kind in ("laser_source", "waveplate", "polarizer", "beam_splitter", "aom", "isolator")
    ]
    if not v2_object_ids:
        return payloads
    rows = (
        await session.scalars(
            select(SceneObject).where(SceneObject.id.in_(v2_object_ids))
        )
    ).all()
    objects_by_id = {row.id: row for row in rows}
    for payload, el in zip(payloads, elements):
        scene_object = objects_by_id.get(el.object_id)
        if scene_object is None:
            continue
        if el.element_kind == "laser_source":
            source = get_optical_source(scene_object)
            beam = source.get("beam") if isinstance(source, dict) else None
            if isinstance(beam, dict):
                payload["kindParams"] = {
                    **(payload.get("kindParams") or {}),
                    **legacy_laser_kind_params_from_beam(beam),
                }
        elif el.element_kind == "waveplate":
            patch = legacy_waveplate_kind_params_from_binding(scene_object)
            if patch:
                payload["kindParams"] = {**(payload.get("kindParams") or {}), **patch}
        elif el.element_kind == "polarizer":
            patch = legacy_polarizer_kind_params_from_binding(scene_object)
            if patch:
                payload["kindParams"] = {**(payload.get("kindParams") or {}), **patch}
        elif el.element_kind == "beam_splitter":
            existing = payload.get("kindParams") or {}
            polarizing = bool(existing.get("polarizing", False))
            patch = legacy_beam_splitter_kind_params_from_bindings(
                scene_object, polarizing=polarizing,
            )
            if patch:
                payload["kindParams"] = {**existing, **patch}
        elif el.element_kind == "aom":
            patch = legacy_aom_kind_params_from_binding(scene_object)
            if patch:
                payload["kindParams"] = {**(payload.get("kindParams") or {}), **patch}
        elif el.element_kind == "isolator":
            patch = legacy_isolator_kind_params_from_binding(scene_object)
            if patch:
                payload["kindParams"] = {**(payload.get("kindParams") or {}), **patch}
    return payloads


def element_payload(element: PhysicsElement) -> dict[str, object]:
    return schemas.OpticalElementOut.model_validate(element).model_dump(mode="json", by_alias=True)


async def _get_by_object(session: AsyncSession, object_id: uuid.UUID) -> PhysicsElement | None:
    stmt = select(PhysicsElement).where(PhysicsElement.object_id == object_id)
    return (await session.scalars(stmt)).one_or_none()


@router.get("", response_model=list[schemas.OpticalElementOut])
async def list_physics_elements(session: AsyncSession = Depends(get_session)) -> list[dict[str, object]]:
    elements = await crud.list_all(session, PhysicsElement)
    return await _serialize_physics_elements(session, elements)


@router.post("", response_model=schemas.OpticalElementOut, status_code=status.HTTP_201_CREATED)
async def create_physics_element(
    payload: schemas.OpticalElementCreate, session: AsyncSession = Depends(get_session)
) -> PhysicsElement:
    # Ensure the SceneObject exists.
    await crud.get_or_404(session, SceneObject, payload.object_id)
    existing = await _get_by_object(session, payload.object_id)
    if existing is not None:
        raise HTTPException(status_code=409, detail="PhysicsElement already exists for this object.")

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
    element = PhysicsElement(**data)
    session.add(element)
    await session.commit()
    await session.refresh(element)
    await manager.broadcast("physics_element.updated", element_payload(element))
    return element


@router.get("/{object_id}", response_model=schemas.OpticalElementOut)
async def get_physics_element(
    object_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> PhysicsElement:
    el = await _get_by_object(session, object_id)
    if el is None:
        raise HTTPException(status_code=404, detail="PhysicsElement not found for this object.")
    payloads = await _serialize_physics_elements(session, [el])
    return payloads[0]


@router.put("/{object_id}", response_model=schemas.OpticalElementOut)
async def update_physics_element(
    object_id: uuid.UUID,
    payload: schemas.OpticalElementUpdate,
    session: AsyncSession = Depends(get_session),
) -> PhysicsElement:
    element = await _get_by_object(session, object_id)
    if element is None:
        raise HTTPException(status_code=404, detail="PhysicsElement not found for this object.")

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

    # V2 Phase 4 (alembic 0030): if the (V1-style) caller sent a
    # waveplate fast axis or polarizer transmission axis, translate it to
    # the corresponding polarizationReference binding payload on the
    # SceneObject. Same pattern as the laser hard cutover below.
    if element.element_kind == "waveplate" and isinstance(raw_kind_params, dict):
        if "fastAxisDegBeamLocal" in raw_kind_params:
            try:
                axis = float(raw_kind_params["fastAxisDegBeamLocal"])
            except (TypeError, ValueError):
                axis = 0.0
            scene_object = await session.get(SceneObject, object_id)
            if scene_object is not None:
                write_waveplate_axis_deg_beam_local(scene_object, axis)
    if element.element_kind == "polarizer" and isinstance(raw_kind_params, dict):
        if "transmissionAxisDegBeamLocal" in raw_kind_params:
            try:
                axis = float(raw_kind_params["transmissionAxisDegBeamLocal"])
            except (TypeError, ValueError):
                axis = 0.0
            scene_object = await session.get(SceneObject, object_id)
            if scene_object is not None:
                write_polarizer_axis_deg_beam_local(scene_object, axis)
    if element.element_kind == "isolator" and isinstance(raw_kind_params, dict):
        if "transmissionAxisDegBeamLocal" in raw_kind_params:
            try:
                axis = float(raw_kind_params["transmissionAxisDegBeamLocal"])
            except (TypeError, ValueError):
                axis = 0.0
            scene_object = await session.get(SceneObject, object_id)
            if scene_object is not None:
                write_isolator_axis_deg_beam_local(scene_object, axis)
    if element.element_kind == "aom" and isinstance(raw_kind_params, dict):
        # Either V1 field (rfPropagationDirectionBodyLocal or its alias
        # acousticAxisBodyLocal) routes to the same rfDirection binding.
        raw_dir = (
            raw_kind_params.get("rfPropagationDirectionBodyLocal")
            or raw_kind_params.get("acousticAxisBodyLocal")
        )
        if raw_dir is not None:
            try:
                direction = [
                    float(raw_dir[0]),
                    float(raw_dir[1]),
                    float(raw_dir[2]),
                ]
                scene_object = await session.get(SceneObject, object_id)
                if scene_object is not None:
                    write_aom_rf_direction_body_local(scene_object, direction)
            except (TypeError, ValueError, IndexError):
                pass
    if element.element_kind == "beam_splitter" and isinstance(raw_kind_params, dict):
        if "coatingNormalBodyLocal" in raw_kind_params:
            raw_normal = raw_kind_params.get("coatingNormalBodyLocal")
            try:
                normal = [
                    float(raw_normal[0]),
                    float(raw_normal[1]),
                    float(raw_normal[2]),
                ]
                scene_object = await session.get(SceneObject, object_id)
                if scene_object is not None:
                    write_beam_splitter_coating_normal(scene_object, normal)
            except (TypeError, ValueError, IndexError):
                pass
        # PBS axis edits route through the same polarizationReference writer
        # used by polarizer (role="transmission" — shared between the two
        # kinds; role discrimination keeps them separate per object).
        if (
            "transmissionAxisDegBeamLocal" in raw_kind_params
            and bool(raw_kind_params.get("polarizing", False))
        ):
            try:
                axis = float(raw_kind_params["transmissionAxisDegBeamLocal"])
            except (TypeError, ValueError):
                axis = 0.0
            scene_object = await session.get(SceneObject, object_id)
            if scene_object is not None:
                write_polarizer_axis_deg_beam_local(scene_object, axis)

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
                    flag_modified(scene_object, "properties")
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
                    flag_modified(scene_object, "properties")

    await session.commit()
    await session.refresh(element)

    # Re-synthesise legacy kindParams for the response so the caller sees the
    # post-write beam state in the legacy shape it sent.
    payloads = await _serialize_physics_elements(session, [element])
    await manager.broadcast("physics_element.updated", payloads[0])
    return payloads[0]


@router.delete("/{object_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_physics_element(
    object_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Response:
    element = await _get_by_object(session, object_id)
    if element is None:
        raise HTTPException(status_code=404, detail="PhysicsElement not found for this object.")
    await session.delete(element)
    await session.commit()
    await manager.broadcast(
        "physics_element.updated", {"objectId": str(object_id), "deleted": True}
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
