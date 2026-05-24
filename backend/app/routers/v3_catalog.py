"""V3 catalog API — list / fetch Asset3D / Component records with the
new physics fields. Mounted at `/api/v3/` to avoid colliding with
existing `/api/assets3d/`, `/api/components/` routes.

Endpoints:
  GET  /v3/assets3d                          — list
  GET  /v3/assets3d/{catalog_id}             — fetch one
  PUT  /v3/assets3d/{catalog_id}/body-frame-rotation
                                             — set/clear CAD-frame quaternion
  GET  /v3/components                        — list
  GET  /v3/components/{catalog_id}           — fetch one
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Asset3D, Component, ComponentBinding
from app.schemas import CamelModel
from app.schemas_v3 import (
    Asset3DV3Out, Asset3DV3Update, ComponentV3Out, QuaternionV3,
)


router = APIRouter(prefix="/v3", tags=["v3-catalog"])


# ---------------------------------------------------------------------------
# Asset3D
# ---------------------------------------------------------------------------

@router.get("/assets3d", response_model=list[Asset3DV3Out])
async def list_assets3d(
    physics_kind: str | None = None,
    has_v3: bool = True,
    session: AsyncSession = Depends(get_session),
) -> list[Asset3D]:
    """List Asset3D rows. `has_v3=True` (default) filters to rows with a
    populated `catalog_id` (the v3-seeded subset). `physics_kind` further
    narrows by optical kind."""
    stmt = select(Asset3D)
    if has_v3:
        stmt = stmt.where(Asset3D.catalog_id.is_not(None))
    if physics_kind:
        stmt = stmt.where(Asset3D.physics_kind == physics_kind)
    stmt = stmt.order_by(Asset3D.catalog_id)
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)


@router.get("/assets3d/{catalog_id}", response_model=Asset3DV3Out)
async def get_asset3d_by_catalog_id(
    catalog_id: str,
    session: AsyncSession = Depends(get_session),
) -> Asset3D:
    row = (await session.execute(
        select(Asset3D).where(Asset3D.catalog_id == catalog_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"asset3d catalog_id={catalog_id!r} not found",
        )
    return row


@router.put("/assets3d/{catalog_id}", response_model=Asset3DV3Out)
async def update_asset3d_by_catalog_id(
    catalog_id: str,
    payload: Asset3DV3Update,
    session: AsyncSession = Depends(get_session),
) -> Asset3D:
    """Update editable v3 physics metadata for one Asset3D row."""
    row = (await session.execute(
        select(Asset3D).where(Asset3D.catalog_id == catalog_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"asset3d catalog_id={catalog_id!r} not found",
        )

    fields = payload.model_fields_set
    if "physics_kind" in fields:
        row.physics_kind = payload.physics_kind
    if "faces" in fields:
        row.faces = (
            [f.model_dump(by_alias=True, exclude_none=True) for f in payload.faces]
            if payload.faces is not None
            else None
        )
    if "transitions" in fields:
        row.transitions = (
            [t.model_dump(by_alias=True, exclude_none=True) for t in payload.transitions]
            if payload.transitions is not None
            else None
        )
    if "default_params" in fields:
        row.default_params = payload.default_params
    if "wavelength_range_nm" in fields:
        row.wavelength_range_nm = payload.wavelength_range_nm
    if "body_frame_rotation" in fields:
        row.body_frame_rotation = (
            payload.body_frame_rotation.model_dump(by_alias=True, exclude_none=True)
            if payload.body_frame_rotation is not None
            else None
        )

    await session.commit()
    await session.refresh(row)
    return row


# ---------------------------------------------------------------------------
# Component
# ---------------------------------------------------------------------------

@router.get("/components", response_model=list[ComponentV3Out])
async def list_components(
    has_v3: bool = True,
    session: AsyncSession = Depends(get_session),
) -> list[ComponentV3Out]:
    stmt = select(Component)
    if has_v3:
        stmt = stmt.where(Component.catalog_id.is_not(None))
    stmt = stmt.order_by(Component.catalog_id)
    components = (await session.execute(stmt)).scalars().all()
    # Attach binding summaries (Component.bindings -> ComponentBinding rows)
    results = []
    for c in components:
        binds = (await session.execute(
            select(ComponentBinding)
            .where(ComponentBinding.component_id == c.id)
            .order_by(ComponentBinding.sort_order)
        )).scalars().all()
        results.append(_component_to_out(c, binds))
    return results


@router.get("/components/{catalog_id}", response_model=ComponentV3Out)
async def get_component_by_catalog_id(
    catalog_id: str,
    session: AsyncSession = Depends(get_session),
) -> ComponentV3Out:
    c = (await session.execute(
        select(Component).where(Component.catalog_id == catalog_id)
    )).scalar_one_or_none()
    if c is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"component catalog_id={catalog_id!r} not found",
        )
    binds = (await session.execute(
        select(ComponentBinding)
        .where(ComponentBinding.component_id == c.id)
        .order_by(ComponentBinding.sort_order)
    )).scalars().all()
    return _component_to_out(c, binds)


def _component_to_out(c: Component, binds: list[ComponentBinding]) -> ComponentV3Out:
    return ComponentV3Out(
        id=c.id,
        catalog_id=c.catalog_id,
        name=c.name,
        component_type=c.component_type,
        brand=c.brand,
        model=c.model,
        exposed_faces=c.exposed_faces,
        properties=c.properties or {},
        bindings=[{
            "bindingId": (b.properties or {}).get("bindingId"),
            "assetId": str(b.asset_3d_id) if b.asset_3d_id else None,
            "localXMm": b.local_x_mm,
            "localYMm": b.local_y_mm,
            "localZMm": b.local_z_mm,
            "localRxDeg": b.local_rx_deg,
            "localRyDeg": b.local_ry_deg,
            "localRzDeg": b.local_rz_deg,
            "sortOrder": b.sort_order,
        } for b in binds],
    )
