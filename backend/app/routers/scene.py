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
    Component,
    Connection,
    DeviceState,
    OpticalElement,
    OpticalLink,
    Placement,
)


router = APIRouter()


@router.get("/scene", response_model=schemas.SceneOut)
async def get_scene(session: AsyncSession = Depends(get_session)) -> schemas.SceneOut:
    assets = list((await session.scalars(select(Asset3D))).all())
    components = list((await session.scalars(select(Component))).all())
    placements = list((await session.scalars(select(Placement))).all())
    connections = list((await session.scalars(select(Connection))).all())
    assembly_relations = list((await session.scalars(select(AssemblyRelation))).all())
    beam_paths = list((await session.scalars(select(BeamPath))).all())
    device_states = list((await session.scalars(select(DeviceState))).all())
    optical_elements = list((await session.scalars(select(OpticalElement))).all())
    optical_links = list((await session.scalars(select(OpticalLink))).all())

    return schemas.SceneOut(
        assets=assets,
        components=components,
        placements=placements,
        objects=placements,
        connections=connections,
        assembly_relations=assembly_relations,
        beam_paths=beam_paths,
        device_states=device_states,
        optical_elements=optical_elements,
        optical_links=optical_links,
    )
