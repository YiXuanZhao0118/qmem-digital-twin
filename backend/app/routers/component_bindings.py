"""ComponentBinding CRUD (alembic 0062).

Bindings live under two URL spaces:

* ``/api/components/{component_id}/bindings``  — list + create scoped to a
  Component. Listing returns the full binding tree in ``sort_order``
  ascending; tree structure is implied by ``parent_binding_id`` (NULL =
  root). Multiple roots are legal — a Component may compose from several
  independent root assets when there's no single anchoring body.

* ``/api/component-bindings/{binding_id}``  — read / update / delete a
  single binding by id. Update cannot change the binding's target
  (``target_kind`` + ``asset_3d_id`` / ``sub_component_id``); to retarget,
  delete and recreate. Keeps the cycle check simple.

Cycle protection
----------------
When creating a binding with ``target_kind='subcomponent'`` we walk the
candidate sub-component's transitive sub-component closure; if the
container Component appears in it, the request is rejected with 400.
This is iterative (not a recursive CTE) — trees are shallow in practice
and pulling rows in batches stays readable.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.db import get_session
from app.models import Asset3D, Component, ComponentBinding


# Two routers — one nested under /components, one top-level for /{binding_id}.
component_scoped = APIRouter()
binding_scoped = APIRouter()


async def _has_subcomponent_cycle(
    session: AsyncSession,
    container_component_id: uuid.UUID,
    candidate_sub_id: uuid.UUID,
) -> bool:
    """Return True if including ``candidate_sub_id`` as a sub-component of
    ``container_component_id`` would create a cycle.

    Walks the candidate's transitive sub-component closure. ``container``
    appearing in that closure means recursion. A binding may transitively
    nest a Component up to any reasonable depth — production catalogs
    have single-digit depth (isolator → PBS is 1; mirror_mount → mirror
    is 1), so the iterative walk is cheap.
    """
    if container_component_id == candidate_sub_id:
        return True

    visited: set[uuid.UUID] = set()
    frontier: list[uuid.UUID] = [candidate_sub_id]
    while frontier:
        cur = frontier.pop()
        if cur in visited:
            continue
        visited.add(cur)
        if cur == container_component_id:
            return True
        result = await session.scalars(
            select(ComponentBinding.sub_component_id)
            .where(ComponentBinding.component_id == cur)
            .where(ComponentBinding.sub_component_id.is_not(None))
        )
        for sub_id in result:
            if sub_id is not None and sub_id not in visited:
                frontier.append(sub_id)
    return False


async def _validate_parent_binding(
    session: AsyncSession,
    component_id: uuid.UUID,
    parent_binding_id: uuid.UUID | None,
) -> None:
    """Reject parent_binding_ids that don't belong to the same Component."""
    if parent_binding_id is None:
        return
    parent = await session.get(ComponentBinding, parent_binding_id)
    if parent is None:
        raise HTTPException(
            status_code=400, detail="parent_binding_id does not exist"
        )
    if parent.component_id != component_id:
        raise HTTPException(
            status_code=400,
            detail="parent_binding_id belongs to a different component",
        )


# =============================================================================
# component-scoped: /api/components/{component_id}/bindings
# =============================================================================


@component_scoped.get(
    "/{component_id}/bindings", response_model=list[schemas.ComponentBindingOut]
)
async def list_bindings(
    component_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> list[ComponentBinding]:
    await crud.get_or_404(session, Component, component_id)
    result = await session.scalars(
        select(ComponentBinding)
        .where(ComponentBinding.component_id == component_id)
        .order_by(ComponentBinding.sort_order, ComponentBinding.created_at)
    )
    return list(result.all())


@component_scoped.post(
    "/{component_id}/bindings",
    response_model=schemas.ComponentBindingOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_binding(
    component_id: uuid.UUID,
    payload: schemas.ComponentBindingCreate,
    session: AsyncSession = Depends(get_session),
) -> ComponentBinding:
    await crud.get_or_404(session, Component, component_id)

    # FK existence checks at app layer so we return clean 400s instead of
    # IntegrityError bubbling out of the DB layer.
    if payload.target_kind == "asset":
        assert payload.asset_3d_id is not None  # enforced by ComponentBindingCreate
        if await session.get(Asset3D, payload.asset_3d_id) is None:
            raise HTTPException(status_code=400, detail="asset_3d_id does not exist")
    else:
        assert payload.sub_component_id is not None
        if await session.get(Component, payload.sub_component_id) is None:
            raise HTTPException(
                status_code=400, detail="sub_component_id does not exist"
            )
        if await _has_subcomponent_cycle(
            session, component_id, payload.sub_component_id
        ):
            raise HTTPException(
                status_code=400,
                detail="adding this sub-component would create a cycle",
            )

    await _validate_parent_binding(session, component_id, payload.parent_binding_id)

    binding = ComponentBinding(component_id=component_id, **payload.model_dump())
    session.add(binding)
    await session.commit()
    await session.refresh(binding)
    return binding


# =============================================================================
# binding-scoped: /api/component-bindings/{binding_id}
# =============================================================================


@binding_scoped.get(
    "/{binding_id}", response_model=schemas.ComponentBindingOut
)
async def get_binding(
    binding_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> ComponentBinding:
    return await crud.get_or_404(session, ComponentBinding, binding_id)


@binding_scoped.put(
    "/{binding_id}", response_model=schemas.ComponentBindingOut
)
async def update_binding(
    binding_id: uuid.UUID,
    payload: schemas.ComponentBindingUpdate,
    session: AsyncSession = Depends(get_session),
) -> ComponentBinding:
    binding = await crud.get_or_404(session, ComponentBinding, binding_id)
    updates = payload.model_dump(exclude_unset=True)

    if "parent_binding_id" in updates:
        new_parent = updates["parent_binding_id"]
        if new_parent == binding.id:
            raise HTTPException(
                status_code=400, detail="a binding cannot be its own parent"
            )
        await _validate_parent_binding(session, binding.component_id, new_parent)

    crud.apply_updates(binding, updates)
    await session.commit()
    await session.refresh(binding)
    return binding


@binding_scoped.delete("/{binding_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_binding(
    binding_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Response:
    binding = await crud.get_or_404(session, ComponentBinding, binding_id)
    await session.delete(binding)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
