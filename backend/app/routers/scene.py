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
        optical_elements=optical_elements,
        optical_links=optical_links,
        beam_segments=beam_segments,
        scene_views=scene_views,
        collections=collections_rows,
        collection_members=collection_members,
        timing_programs=timing_programs_rows,
    )
