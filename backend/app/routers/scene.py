from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.db import get_session
from app.models import (
    Asset3D,
    AssemblyRelation,
    BeamPath,
    BeamSegment,
    Collection,
    CollectionMember,
    Component,
    Connection,
    DeviceState,
    OpticalElement,
    OpticalLink,
    SceneObject,
    SceneView,
    TimingProgram,
)
from sqlalchemy.orm import selectinload
from app.routers.collections import canonical_collection_members, get_master_collection
from app.v2_bindings import (
    get_optical_source,
    legacy_laser_kind_params_from_beam,
    legacy_polarizer_kind_params_from_binding,
    legacy_waveplate_kind_params_from_binding,
)


router = APIRouter()


@router.get("/scene", response_model=schemas.SceneOut)
async def get_scene(session: AsyncSession = Depends(get_session)) -> schemas.SceneOut:
    assets = list((await session.scalars(select(Asset3D))).all())
    components = list(
        (await session.scalars(select(Component).where(Component.archived_at.is_(None)))).all()
    )
    objects = list((await session.scalars(select(SceneObject))).all())
    connections = list((await session.scalars(select(Connection))).all())
    assembly_relations = list((await session.scalars(select(AssemblyRelation))).all())
    beam_paths = list((await session.scalars(select(BeamPath))).all())
    device_states = list((await session.scalars(select(DeviceState))).all())
    optical_elements = list((await session.scalars(select(OpticalElement))).all())
    optical_links = list((await session.scalars(select(OpticalLink))).all())

    # V2 Phase 3 (alembic 0029) translator: laser_source kindParams is empty
    # in DB after the cutover. Synthesise the legacy shape from each laser's
    # opticalSources[].beam so the frontend's existing readers (rayTrace,
    # OpticalElementPanel, BeamScopePanel, opticalBeams) keep working.
    #
    # We build OpticalElementOut dicts here instead of mutating the SA rows
    # so we don't trigger an autoflush during Pydantic serialisation.
    objects_by_id = {obj.id: obj for obj in objects}
    optical_element_payloads = [
        schemas.OpticalElementOut.model_validate(el).model_dump(mode="json", by_alias=True)
        for el in optical_elements
    ]
    for payload, el in zip(optical_element_payloads, optical_elements):
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
    beam_segments = list((await session.scalars(select(BeamSegment))).all())
    scene_views = list(
        (
            await session.scalars(
                select(SceneView).order_by(SceneView.sort_order.asc(), SceneView.created_at.asc())
            )
        ).all()
    )
    await get_master_collection(session)
    collections_rows = list(
        (
            await session.scalars(
                select(Collection).order_by(
                    Collection.sort_order.asc(), Collection.created_at.asc()
                )
            )
        ).all()
    )
    collection_members_rows = list(
        (
            await session.scalars(
                select(CollectionMember).order_by(
                    CollectionMember.collection_id.asc(),
                    CollectionMember.sort_order.asc(),
                )
            )
        ).all()
    )
    collection_members = canonical_collection_members(
        collections_rows, collection_members_rows
    )
    timing_programs_rows = list(
        (
            await session.scalars(
                select(TimingProgram).options(selectinload(TimingProgram.blocks))
            )
        ).all()
    )

    return schemas.SceneOut(
        assets=assets,
        components=components,
        objects=objects,
        connections=connections,
        assembly_relations=assembly_relations,
        beam_paths=beam_paths,
        device_states=device_states,
        optical_elements=optical_element_payloads,
        optical_links=optical_links,
        beam_segments=beam_segments,
        scene_views=scene_views,
        collections=collections_rows,
        collection_members=collection_members,
        timing_programs=timing_programs_rows,
    )
