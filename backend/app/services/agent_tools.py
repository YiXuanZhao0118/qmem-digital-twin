"""Sole API surface for the AI binding agent.

Every Claude Agent SDK tool eventually resolves to a function in this
module. Nothing else (REST routes, ORM session, raw SQL) is given to
the agent — this is the single chokepoint that enforces the lock /
isolation invariants:

  * The session must be in 'running' state for any write.
  * New rows are inserted with ``status='draft'`` and
    ``created_by_session_id=<this session>`` so they're invisible to
    every other consumer.
  * Every write records a row in ``session_mutations`` in the same
    transaction so commit/cancel/undo have something to act on.
  * No update / delete tools in v1 (Q3 invariant). The agent can only
    iterate by undo-then-recreate.

Read tools (``list_kinds``, ``list_existing_*``) expose the catalog
the agent reasons over. They return the active catalog *plus* the
agent's own drafts — but not other sessions' drafts.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import kinds_manifest
from app.models import (
    AgentSession,
    ApprovalEvent,
    Asset3D,
    Component,
    SessionMutation,
)
from app.services.agent_session import SessionNotFoundError, SessionNotRunningError


# ---------------------------------------------------------------------------
# Exceptions surfaced to the agent's tool wrapper.
# ---------------------------------------------------------------------------


class ToolValidationError(Exception):
    """Bad input from the agent (unknown kind, dangling FK, etc.).
    Wrapper layer should return this to the agent as a tool error so
    the model can correct itself on the next turn.
    """


class EntityLockedError(Exception):
    """The agent tried to reference an entity that is ``ai_approved_at``
    locked. Distinct from ToolValidationError because it's worth
    auditing — we write a ``modify_blocked`` ApprovalEvent so the
    operator can see the agent attempted something it wasn't allowed
    to. v1: only happens if the agent passes a locked asset id as the
    ``asset_3d_id`` of a new component, since no update/delete tools
    exist.
    """


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _require_running(db: AsyncSession, session_id: uuid.UUID) -> AgentSession:
    sess = await db.get(AgentSession, session_id)
    if sess is None:
        raise SessionNotFoundError(str(session_id))
    if sess.status != "running":
        raise SessionNotRunningError(
            f"Session {session_id} is {sess.status!r}; agent writes refused."
        )
    return sess


def _snapshot(entity: Asset3D | Component) -> dict[str, Any]:
    """Minimal JSON-serializable snapshot for ``session_mutations.after``.

    We keep just enough to identify the row in the audit log; full
    state can always be re-fetched by entity_id since v1 doesn't
    delete on rollback before recording the mutation.
    """
    if isinstance(entity, Asset3D):
        return {
            "id": str(entity.id),
            "name": entity.name,
            "asset_type": entity.asset_type,
            "file_path": entity.file_path,
        }
    return {
        "id": str(entity.id),
        "name": entity.name,
        "component_type": entity.component_type,
        "asset_3d_id": str(entity.asset_3d_id) if entity.asset_3d_id else None,
    }


# ---------------------------------------------------------------------------
# Read tools
# ---------------------------------------------------------------------------


def list_kinds() -> list[str]:
    """Return every valid ``component_type`` the agent may pass to
    :func:`create_component`. Derived from the frontend plugin
    manifest so backend + frontend never drift.
    """
    return sorted(kinds_manifest.component_type_to_kind().keys())


async def list_existing_assets(
    db: AsyncSession, session_id: uuid.UUID
) -> list[Asset3D]:
    """Active catalog + this session's own drafts. Other sessions'
    drafts are invisible (isolation invariant).
    """
    await _require_running(db, session_id)
    result = await db.scalars(
        select(Asset3D).where(
            or_(
                Asset3D.status == "active",
                Asset3D.created_by_session_id == session_id,
            )
        )
    )
    return list(result.all())


async def list_existing_components(
    db: AsyncSession, session_id: uuid.UUID
) -> list[Component]:
    """Same scope rules as :func:`list_existing_assets`. Archived
    components are excluded — they're catalog-tombstones, not
    reusable.
    """
    await _require_running(db, session_id)
    result = await db.scalars(
        select(Component).where(
            or_(
                Component.status == "active",
                Component.created_by_session_id == session_id,
            ),
            Component.archived_at.is_(None),
        )
    )
    return list(result.all())


# ---------------------------------------------------------------------------
# Write tools — each appends a session_mutations row in-transaction.
# ---------------------------------------------------------------------------


async def create_asset(
    db: AsyncSession,
    *,
    session_id: uuid.UUID,
    name: str,
    asset_type: str,
    file_path: str,
    unit: str = "mm",
    scale_factor: float = 1.0,
    anchors: list[dict[str, Any]] | None = None,
    source: str | None = None,
    source_url: str | None = None,
) -> Asset3D:
    """Insert a draft Asset3D and log the create.

    Validation:
      * Session is running.
      * ``name`` is non-empty (matches the existing Component name
        policy — a blank slot would create catalog ambiguity).
    """
    await _require_running(db, session_id)
    if not name.strip():
        raise ToolValidationError("Asset name cannot be empty.")

    asset = Asset3D(
        name=name.strip(),
        asset_type=asset_type,
        file_path=file_path,
        unit=unit,
        scale_factor=scale_factor,
        anchors=anchors or [],
        source=source,
        source_url=source_url,
        status="draft",
        created_by_session_id=session_id,
    )
    db.add(asset)
    await db.flush()  # populate asset.id before logging the mutation

    db.add(
        SessionMutation(
            session_id=session_id,
            op="create",
            entity_type="asset_3d",
            entity_id=asset.id,
            before=None,
            after=_snapshot(asset),
        )
    )
    await db.commit()
    await db.refresh(asset)
    return asset


async def create_component(
    db: AsyncSession,
    *,
    session_id: uuid.UUID,
    name: str,
    component_type: str,
    asset_3d_id: uuid.UUID | None = None,
    brand: str | None = None,
    model: str | None = None,
    properties: dict[str, Any] | None = None,
    notes: str | None = None,
) -> Component:
    """Insert a draft Component and log the create.

    Validation:
      * Session is running.
      * ``component_type`` is a known kind (sourced from the manifest).
      * If ``asset_3d_id`` is given, the referenced asset must be
        either ``status='active'`` *and not* ai_approved-locked, or a
        draft this session owns. Locked active assets ARE allowed to
        be referenced (binding new components to approved assets is a
        legitimate flow); only mutating the locked asset would be
        blocked. The wrapper writes a ``modify_blocked`` event only
        when the agent passes a session-owned-but-locked draft, which
        shouldn't happen in v1 but is here as belt-and-suspenders.
    """
    await _require_running(db, session_id)
    if not name.strip():
        raise ToolValidationError("Component name cannot be empty.")

    valid_kinds = set(kinds_manifest.component_type_to_kind().keys())
    if component_type not in valid_kinds:
        raise ToolValidationError(
            f"Unknown component_type {component_type!r}. "
            f"Call list_kinds() to see valid values."
        )

    if asset_3d_id is not None:
        asset = await db.get(Asset3D, asset_3d_id)
        if asset is None:
            raise ToolValidationError(
                f"asset_3d_id {asset_3d_id} does not exist."
            )
        # Active rows are fine to bind to even when ai_approved_at is set
        # (locking the asset doesn't make it un-bindable; it just
        # prevents the asset itself from being modified). Drafts must
        # belong to this session.
        if asset.status == "draft" and asset.created_by_session_id != session_id:
            raise ToolValidationError(
                f"Asset {asset_3d_id} is a draft owned by another session."
            )

    comp = Component(
        name=name.strip(),
        component_type=component_type,
        asset_3d_id=asset_3d_id,
        brand=brand,
        model=model,
        properties=properties or {},
        notes=notes,
        status="draft",
        created_by_session_id=session_id,
    )
    db.add(comp)
    await db.flush()

    db.add(
        SessionMutation(
            session_id=session_id,
            op="create",
            entity_type="component",
            entity_id=comp.id,
            before=None,
            after=_snapshot(comp),
        )
    )
    await db.commit()
    await db.refresh(comp)
    return comp


# ---------------------------------------------------------------------------
# Audit helper — surface for the future when update/delete tools land.
# Kept here so the wrapper module is the only place that writes
# ApprovalEvent of type 'modify_blocked'.
# ---------------------------------------------------------------------------


async def record_blocked_attempt(
    db: AsyncSession,
    *,
    session_id: uuid.UUID,
    entity_type: str,
    entity_id: uuid.UUID,
    attempted_op: str,
    detail: str,
) -> None:
    db.add(
        ApprovalEvent(
            event_type="modify_blocked",
            entity_type=entity_type,
            entity_id=entity_id,
            session_id=session_id,
            event_metadata={"attempted_op": attempted_op, "detail": detail},
        )
    )
    await db.commit()
