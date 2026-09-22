"""CRUD for the ``kinds`` table (alembic 0086).

Each row is one Kind metadata variant. PhysicsOps stay in code; each
row references one via ``op_set_name``. Creating a kind via the UI lets
the user curate metadata variants (different defaults / wavelength
ranges / face templates) without writing TypeScript, but to introduce
genuinely new physics behaviour you still need to register a new op set
in code.

See docs/asset-physics-model.md §6 for the design rationale.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.db import get_session
from app.lock_guard import assert_delete_allowed, assert_update_allowed
from app.kinds_manifest import element_kinds, load_manifest
from app.models import Asset3D, Kind, KindDeletion
from app.optical.db_kinds import (
    remove_kind_cache_entry,
    set_kind_cache_entry,
)


router = APIRouter()


def _kind_out(kind: Kind) -> dict:
    return schemas.KindOut.model_validate(kind).model_dump(mode="json", by_alias=True)


def _registered_op_set_names() -> set[str]:
    """All op-set names a Kind row may reference.

    Physics kinds point at code-defined op sets. Passive mechanical
    kinds such as ``optical_table`` are metadata-only, but still need a
    stable op-set slug so the Kinds editor can create and retain them.
    """
    manifest = load_manifest()
    passive_ids = {
        plugin["id"]
        for plugin in manifest.get("passive_plugins", [])
        if isinstance(plugin, dict) and isinstance(plugin.get("id"), str)
    }
    return set(element_kinds()) | passive_ids


@router.get("", response_model=list[schemas.KindOut])
async def list_kinds(
    domain: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> list[Kind]:
    stmt = select(Kind).order_by(Kind.name)
    if domain is not None:
        # Match if the requested domain is one of the kind's domains, so a
        # multi-domain part (e.g. AOM = optical+rf) shows up under each.
        stmt = stmt.where(Kind.domains.any(domain))
    return list((await session.scalars(stmt)).all())


@router.get("/op-sets", response_model=list[str])
async def list_op_sets() -> list[str]:
    """Every op-set name a Kind row may reference.

    Declared BEFORE ``/{kind_id}`` so FastAPI matches the literal path
    first — ``kind_id`` is a UUID and would otherwise 422 on "op-sets".

    The Kinds editor used to derive its op-set dropdown from the
    op_set_name values of existing rows, which hid every code-side op
    set that had no Kind row yet: the user had to type the name blind
    and only learned it was wrong from the 400 that ``create_kind``
    raises. This is the same set that validation checks against.
    """
    return sorted(_registered_op_set_names())


class RoleSpecOut(schemas.CamelModel):
    """One port role of a kind (TS ``kinds/_plugin.ts`` ``RoleSpec``)."""

    min: int  # 0 = optional anchor, >= 1 = required
    max: int | None  # 1 = single port, N = bounded, None = unbounded multiport
    domain: str  # the port's signal domain (optical / rf / ttl / ...)
    direction: bool  # direction, not just position, matters for align
    aperture: bool  # apertureMm must be set
    fast_axis: bool  # an asset-level fast-axis angle applies


class KindRolesOut(schemas.CamelModel):
    """The port contract of one physics kind, as ``backend/data/kinds.json``
    (the export of ``frontend/src/kinds/<kind>/index.ts``) states it."""

    kind: str
    primary_domain: str
    default_physics: list[str]
    required_anchors: list[str]
    optional_anchors: list[str]
    # The plugin's explicit anchor-id -> signal-domain map; ids not in it
    # fall back to the caller's own heuristic, as the web app's do.
    port_domains: dict[str, str]
    # Per-role spec; null for a kind that authors no ``roles`` map.
    roles: dict[str, RoleSpecOut] | None


@router.get("/roles", response_model=list[KindRolesOut])
async def list_kind_roles() -> list[KindRolesOut]:
    """Every physics kind's port roles and domains, straight from the kinds
    manifest (``load_manifest``), in plugin registration order.

    Compute-only; no DB. It exists so a second client (the qmem-blender
    add-on's RF graph) reads the contract instead of copying ``kinds.json``.
    Passive (mechanical) plugins carry no ports and are not listed; neither
    are DB-only kinds rows (``isolator``, ``mechanical``, ...), which have no
    plugin. Declared BEFORE ``/{kind_id}`` so the literal path wins.
    """
    out: list[KindRolesOut] = []
    for plugin in load_manifest()["physics_plugins"]:
        physics = plugin["physics"]
        anchors = physics.get("anchors") or {}
        roles = physics.get("roles")
        out.append(KindRolesOut(
            kind=physics["element_kind"],
            primary_domain=physics["primary_domain"],
            default_physics=list(physics.get("default_physics") or []),
            required_anchors=list(anchors.get("required") or []),
            optional_anchors=list(anchors.get("optional") or []),
            port_domains=dict(physics.get("port_domains") or {}),
            roles=None if roles is None else {
                role: RoleSpecOut(
                    min=spec["min"],
                    max=spec["max"],  # always emitted; null means unbounded
                    domain=spec["domain"],
                    direction=spec.get("direction") is True,
                    aperture=spec.get("aperture") is True,
                    fast_axis=spec.get("fast_axis") is True,
                )
                for role, spec in roles.items()
            },
        ))
    return out


@router.get("/{kind_id}", response_model=schemas.KindOut)
async def get_kind(
    kind_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Kind:
    kind = await session.get(Kind, kind_id)
    if kind is None:
        raise HTTPException(status_code=404, detail=f"Kind {kind_id} not found")
    return kind


@router.post("", response_model=schemas.KindOut, status_code=status.HTTP_201_CREATED)
async def create_kind(
    payload: schemas.KindCreate,
    session: AsyncSession = Depends(get_session),
) -> Kind:
    op_set_names = _registered_op_set_names()
    if payload.op_set_name not in op_set_names:
        raise HTTPException(
            status_code=400,
            detail=(
                f"op_set_name {payload.op_set_name!r} is not registered in "
                "the code-side op registry. Pick one of: "
                f"{sorted(op_set_names)}."
            ),
        )
    # Clear any tombstone first (alembic 0138): the BEFORE INSERT trigger
    # silently skips inserts for a tombstoned name, so leaving it in place
    # would turn this POST into a no-op that then 500s on refresh().
    # Re-creating a deleted kind here is the tombstone's release valve.
    tombstone = await session.get(KindDeletion, payload.name)
    if tombstone is not None:
        await session.delete(tombstone)
        await session.flush()

    kind = Kind(**payload.model_dump())
    session.add(kind)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=409,
            detail=(
                f"Kind with name {payload.name!r} already exists. "
                "Names are unique."
            ),
        ) from exc
    await session.refresh(kind)
    # Tracer cache (Phase 5): new row -> tracer can now resolve this
    # kind name through op_set_name indirection.
    set_kind_cache_entry(kind.name, kind.op_set_name)
    return kind


@router.patch("/{kind_id}", response_model=schemas.KindOut)
async def update_kind(
    kind_id: uuid.UUID,
    payload: schemas.KindUpdate,
    session: AsyncSession = Depends(get_session),
) -> Kind:
    kind = await session.get(Kind, kind_id)
    if kind is None:
        raise HTTPException(status_code=404, detail=f"Kind {kind_id} not found")
    updates = payload.model_dump(exclude_unset=True)
    assert_update_allowed(
        locked=kind.locked, changed_fields=updates.keys(), label=f"Kind {kind.name!r}"
    )
    for field, value in updates.items():
        setattr(kind, field, value)
    await session.commit()
    await session.refresh(kind)
    return kind


@router.delete("/{kind_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_kind(
    kind_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Response:
    kind = await session.get(Kind, kind_id)
    if kind is None:
        raise HTTPException(status_code=404, detail=f"Kind {kind_id} not found")
    assert_delete_allowed(locked=kind.locked, label=f"Kind {kind.name!r}")
    in_use = (
        await session.scalars(
            select(Asset3D.id).where(Asset3D.kind_id == kind.name).limit(1)
        )
    ).first()
    if in_use is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Kind {kind.name!r} is still referenced by at least one "
                "Asset3D. Reassign or delete those assets first."
            ),
        )
    deleted_name = kind.name
    await session.delete(kind)
    # Tombstone (alembic 0138) — without it the next resync migration that
    # inserts "whatever the manifest has and the table lacks" would put this
    # row back on the following restart, which is exactly what 0126 / 0136
    # did to the kinds deleted before them.
    session.add(KindDeletion(name=deleted_name, note="deleted in the Kinds editor"))
    await session.commit()
    # Tracer cache (Phase 5): drop the entry so a later Asset3D using
    # the deleted name fails fast with a clear KeyError instead of
    # tracing against a stale op_set_name mapping.
    remove_kind_cache_entry(deleted_name)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
