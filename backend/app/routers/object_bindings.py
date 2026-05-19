"""ObjectBinding CRUD (alembic 0076).

Per-SceneObject overrides of ComponentBinding pose / asset. URL shape
mirrors ``component_bindings`` so the two systems read symmetrically:

* ``/api/objects/{object_id}/object-bindings``   — list + upsert scoped to a
  SceneObject. UPSERT semantics: posting an entry whose
  ``component_binding_id`` already has a row for this scene-object
  updates the existing row instead of failing on the unique constraint.
  Matches how the IsolatorObjectControls panel writes (one row per knob,
  re-issued on every slider drag).

* ``/api/object-bindings/{id}``                  — read / update / delete a
  single row by id. Update can't change ``component_binding_id`` (same
  immutability rule as ComponentBindingUpdate) — to retarget, delete and
  recreate.

The renderer composes ``effective = component_binding.local* + delta*``
per axis. Missing deltas (NULL) mean "no override for that axis", which
is distinct from "explicit 0".
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.db import get_session
from app.models import Asset3D, ComponentBinding, ObjectBinding, SceneObject
from app.websocket import manager


def binding_payload(binding: ObjectBinding) -> dict[str, object]:
    """CamelCase JSON of an ObjectBinding for WS broadcast. Matches the
    shape the frontend ``ObjectBinding`` type expects so sceneStore can
    upsert directly into ``scene.objectBindings``."""
    return schemas.ObjectBindingOut.model_validate(binding).model_dump(
        mode="json", by_alias=True
    )


# Two routers — one nested under /objects, one top-level for /{id}.
object_scoped = APIRouter()
binding_scoped = APIRouter()


# =============================================================================
# object-scoped: /api/objects/{object_id}/object-bindings
# =============================================================================


@object_scoped.get(
    "/{object_id}/object-bindings",
    response_model=list[schemas.ObjectBindingOut],
)
async def list_object_bindings(
    object_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> list[ObjectBinding]:
    await crud.get_or_404(session, SceneObject, object_id)
    result = await session.scalars(
        select(ObjectBinding)
        .where(ObjectBinding.object_id == object_id)
        .order_by(ObjectBinding.created_at)
    )
    return list(result.all())


@object_scoped.post(
    "/{object_id}/object-bindings",
    response_model=schemas.ObjectBindingOut,
)
async def upsert_object_binding(
    object_id: uuid.UUID,
    payload: schemas.ObjectBindingCreate,
    session: AsyncSession = Depends(get_session),
) -> ObjectBinding:
    """Create or update the ObjectBinding for (object_id, payload.component_binding_id).

    Returns 200 on update, 201 on create. The unique constraint
    ``uq_object_bindings_object_binding`` makes UPSERT the only sensible
    write API — the UI drags sliders continuously and we don't want
    repeated POSTs to 409 once a row exists.
    """
    await crud.get_or_404(session, SceneObject, object_id)

    cb = await session.get(ComponentBinding, payload.component_binding_id)
    if cb is None:
        raise HTTPException(
            status_code=400, detail="component_binding_id does not exist"
        )

    if payload.asset_3d_id_override is not None:
        if await session.get(Asset3D, payload.asset_3d_id_override) is None:
            raise HTTPException(
                status_code=400, detail="asset_3d_id_override does not exist"
            )

    existing = await session.scalar(
        select(ObjectBinding)
        .where(ObjectBinding.object_id == object_id)
        .where(ObjectBinding.component_binding_id == payload.component_binding_id)
    )

    if existing is None:
        binding = ObjectBinding(object_id=object_id, **payload.model_dump())
        session.add(binding)
        event = "object_binding.created"
    else:
        crud.apply_updates(existing, payload.model_dump())
        binding = existing
        event = "object_binding.updated"

    await session.commit()
    await session.refresh(binding)
    await manager.broadcast(event, binding_payload(binding))
    return binding


# =============================================================================
# binding-scoped: /api/object-bindings/{binding_id}
# =============================================================================


@binding_scoped.get(
    "/{binding_id}", response_model=schemas.ObjectBindingOut
)
async def get_object_binding(
    binding_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> ObjectBinding:
    return await crud.get_or_404(session, ObjectBinding, binding_id)


@binding_scoped.put(
    "/{binding_id}", response_model=schemas.ObjectBindingOut
)
async def update_object_binding(
    binding_id: uuid.UUID,
    payload: schemas.ObjectBindingUpdate,
    session: AsyncSession = Depends(get_session),
) -> ObjectBinding:
    binding = await crud.get_or_404(session, ObjectBinding, binding_id)
    updates = payload.model_dump(exclude_unset=True)

    if "asset_3d_id_override" in updates and updates["asset_3d_id_override"] is not None:
        if await session.get(Asset3D, updates["asset_3d_id_override"]) is None:
            raise HTTPException(
                status_code=400, detail="asset_3d_id_override does not exist"
            )

    crud.apply_updates(binding, updates)
    await session.commit()
    await session.refresh(binding)
    await manager.broadcast("object_binding.updated", binding_payload(binding))
    return binding


@binding_scoped.delete(
    "/{binding_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_object_binding(
    binding_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> Response:
    binding = await crud.get_or_404(session, ObjectBinding, binding_id)
    await session.delete(binding)
    await session.commit()
    await manager.broadcast(
        "object_binding.deleted",
        {"id": str(binding_id), "objectId": str(binding.object_id)},
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
