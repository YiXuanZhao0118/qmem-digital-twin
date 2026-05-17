"""Lifecycle for AI binding-agent conversations.

A *session* is one conversation in which the agent creates draft
Asset3D + Component rows and links them; the user approves the batch
at the end (locking the rows) or abandons it (rows rolled back via
reverse-replay of ``session_mutations``).

This module owns the state machine:

    running ──(commit)──▶ committed   (drafts → active, ai_approved_at set)
            ──(cancel)──▶ cancelled   (drafts deleted via reverse-replay)
            ──(timeout)─▶ abandoned   (same rollback path, automatic)

The single chokepoint for agent writes is :mod:`app.services.agent_tools`;
this module exposes only lifecycle verbs (start, heartbeat, undo,
commit, cancel, sweep).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    AgentSession,
    ApprovalEvent,
    Asset3D,
    Component,
    SessionMutation,
)


# ---------------------------------------------------------------------------
# Exceptions — REST layer maps these to HTTP status codes.
# ---------------------------------------------------------------------------


class SessionNotFoundError(Exception):
    pass


class SessionNotRunningError(Exception):
    """Raised when caller tries to act on a session that has already
    transitioned to a terminal state (committed / cancelled / abandoned).
    Terminal states are immutable — re-open by starting a new session.
    """


class NothingToUndoError(Exception):
    pass


class UndoBlockedError(Exception):
    """A foreign-key dependency prevents undo. Typical case: the user
    tries to undo creation of an Asset that a Component (created later
    in the same session and not yet undone) still references.
    """


# ---------------------------------------------------------------------------
# Entity-type → ORM class. Keep this dict in sync with what
# agent_tools.py records in session_mutations.entity_type.
# ---------------------------------------------------------------------------

_ENTITY_TYPES: dict[str, type] = {
    "asset_3d": Asset3D,
    "component": Component,
}


def _model_for(entity_type: str) -> type:
    cls = _ENTITY_TYPES.get(entity_type)
    if cls is None:
        # Defensive: a mutation row with an unknown entity_type would
        # mean someone edited the table outside agent_tools. Refuse to
        # guess what to roll back.
        raise RuntimeError(f"Unknown entity_type in session_mutations: {entity_type!r}")
    return cls


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


async def _load_running_session(
    db: AsyncSession, session_id: uuid.UUID
) -> AgentSession:
    """Load a session and assert it's still in 'running' state.

    Raises:
        SessionNotFoundError: no row with that id.
        SessionNotRunningError: session has already terminated.
    """
    sess = await db.get(AgentSession, session_id)
    if sess is None:
        raise SessionNotFoundError(str(session_id))
    if sess.status != "running":
        raise SessionNotRunningError(
            f"Session {session_id} is {sess.status!r}, not 'running'."
        )
    return sess


def _now() -> datetime:
    # Centralized so tests can monkeypatch a clock if needed.
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Public lifecycle API
# ---------------------------------------------------------------------------


async def start_session(
    db: AsyncSession,
    *,
    instruction: str = "",
    heartbeat_timeout_sec: int = 300,
) -> AgentSession:
    """Create a fresh running session. Heartbeat is initialised to NOW so
    the sweeper won't immediately mark it abandoned.
    """
    sess = AgentSession(
        instruction=instruction,
        status="running",
        heartbeat_timeout_sec=heartbeat_timeout_sec,
    )
    db.add(sess)
    await db.commit()
    await db.refresh(sess)
    return sess


async def heartbeat(db: AsyncSession, session_id: uuid.UUID) -> AgentSession:
    """Bump the session's ``last_heartbeat_at`` to NOW. Idempotent.

    Frontend should call this every ~30s while the AI panel is open.
    """
    sess = await _load_running_session(db, session_id)
    sess.last_heartbeat_at = _now()
    await db.commit()
    await db.refresh(sess)
    return sess


async def commit_session(
    db: AsyncSession, session_id: uuid.UUID
) -> dict[str, object]:
    """Promote every non-undone draft to ``status='active'`` and set
    ``ai_approved_at = NOW``. Writes one ``approve`` event per entity.

    All writes happen in a single transaction; if anything fails the
    session stays in 'running' state and the user can retry.

    Returns a summary of what got committed.
    """
    sess = await _load_running_session(db, session_id)

    # Pull every still-live mutation. Order doesn't matter for commit
    # (we just flip status), but we keep created_at sort for determinism.
    mutations_result = await db.scalars(
        select(SessionMutation)
        .where(
            SessionMutation.session_id == session_id,
            SessionMutation.undone_at.is_(None),
        )
        .order_by(SessionMutation.created_at.asc())
    )
    live_mutations = list(mutations_result.all())

    now = _now()
    approved_assets: list[uuid.UUID] = []
    approved_components: list[uuid.UUID] = []

    for mut in live_mutations:
        if mut.op != "create":
            # v1 invariant. If/when update/delete are introduced the
            # commit semantics for them will need a real branch here.
            continue
        cls = _model_for(mut.entity_type)
        entity = await db.get(cls, mut.entity_id)
        if entity is None:
            # The row vanished — could only happen if some external
            # process deleted a draft. Log and skip rather than crash.
            continue
        entity.status = "active"
        entity.ai_approved_at = now
        if mut.entity_type == "asset_3d":
            approved_assets.append(mut.entity_id)
        else:
            approved_components.append(mut.entity_id)
        db.add(
            ApprovalEvent(
                event_type="approve",
                entity_type=mut.entity_type,
                entity_id=mut.entity_id,
                session_id=session_id,
            )
        )

    sess.status = "committed"
    sess.committed_at = now
    await db.commit()
    return {
        "session_id": session_id,
        "approved_assets": approved_assets,
        "approved_components": approved_components,
    }


async def cancel_session(
    db: AsyncSession,
    session_id: uuid.UUID,
    *,
    reason: str = "user_cancelled",
) -> dict[str, object]:
    """Roll back every still-live mutation in this session by reverse-
    replay, then transition the session to 'cancelled'.

    For v1 (op='create' only) rollback = DELETE the drafted row. We
    delete in reverse insertion order so that a Component whose
    asset_3d_id points at a sibling-draft Asset gets removed before
    the Asset itself — preventing FK violations.
    """
    sess = await _load_running_session(db, session_id)

    mutations_result = await db.scalars(
        select(SessionMutation)
        .where(
            SessionMutation.session_id == session_id,
            SessionMutation.undone_at.is_(None),
        )
        .order_by(SessionMutation.created_at.desc())
    )
    to_roll_back = list(mutations_result.all())

    rolled_back_count = 0
    now = _now()
    for mut in to_roll_back:
        if mut.op != "create":
            continue
        cls = _model_for(mut.entity_type)
        await db.execute(delete(cls).where(cls.id == mut.entity_id))
        mut.undone_at = now
        rolled_back_count += 1

    sess.status = "abandoned" if reason == "abandoned_timeout" else "cancelled"
    sess.cancelled_at = now
    sess.cancellation_reason = reason

    db.add(
        ApprovalEvent(
            event_type="session_rolled_back",
            session_id=session_id,
            event_metadata={
                "reason": reason,
                "rolled_back_count": rolled_back_count,
            },
        )
    )
    await db.commit()
    return {
        "session_id": session_id,
        "rolled_back_count": rolled_back_count,
        "reason": reason,
    }


async def undo_last_mutation(
    db: AsyncSession, session_id: uuid.UUID
) -> SessionMutation:
    """Undo the most recently-created live mutation in this session.

    Implementation mirrors :func:`cancel_session` but only for a single
    mutation. The mutation row is preserved with ``undone_at`` set so
    the audit trail keeps every attempt the user made.

    Raises:
        NothingToUndoError: no live mutations remain.
        UndoBlockedError: the entity to undo is still referenced by
            another live mutation's entity (e.g. undoing an Asset that
            a still-live Component points at).
    """
    await _load_running_session(db, session_id)

    last = await db.scalar(
        select(SessionMutation)
        .where(
            SessionMutation.session_id == session_id,
            SessionMutation.undone_at.is_(None),
        )
        .order_by(SessionMutation.created_at.desc())
        .limit(1)
    )
    if last is None:
        raise NothingToUndoError(str(session_id))

    if last.op != "create":
        # v1 doesn't produce these but be defensive for the future.
        raise RuntimeError(f"Unsupported op for undo: {last.op!r}")

    # FK pre-check for the only relationship that can dangle in v1:
    # undoing an Asset3D while a not-yet-undone Component still
    # references it would be a foreign-key violation.
    if last.entity_type == "asset_3d":
        blocking = await db.scalar(
            select(Component.id)
            .where(
                Component.asset_3d_id == last.entity_id,
                Component.status == "draft",
            )
            .limit(1)
        )
        if blocking is not None:
            raise UndoBlockedError(
                f"Asset {last.entity_id} is referenced by draft component "
                f"{blocking}; undo the component first."
            )

    cls = _model_for(last.entity_type)
    await db.execute(delete(cls).where(cls.id == last.entity_id))
    last.undone_at = _now()
    await db.commit()
    await db.refresh(last)
    return last


# ---------------------------------------------------------------------------
# Sweeper — called by a FastAPI startup task on a 60s interval.
# ---------------------------------------------------------------------------


async def scan_for_abandoned(db: AsyncSession) -> list[uuid.UUID]:
    """Find sessions whose heartbeat has expired and roll them back.

    Returns the list of session ids that were transitioned to
    'abandoned'. Caller logs the result; nothing else uses it.
    """
    now = _now()

    # The cutoff is per-session because we keep heartbeat_timeout_sec
    # configurable per session (default 300s). We can't push the
    # comparison into a single WHERE clause cleanly across dialects, so
    # do the filter in Python after pulling candidate rows.
    candidates_result = await db.scalars(
        select(AgentSession).where(AgentSession.status == "running")
    )
    candidates = list(candidates_result.all())

    abandoned: list[uuid.UUID] = []
    for sess in candidates:
        cutoff = sess.last_heartbeat_at + timedelta(seconds=sess.heartbeat_timeout_sec)
        if cutoff < now:
            abandoned.append(sess.id)

    # Roll back each abandoned session in its own transaction-ish scope
    # so a single bad rollback doesn't block the others. Each call
    # commits on success.
    for session_id in abandoned:
        try:
            await cancel_session(db, session_id, reason="abandoned_timeout")
        except SessionNotRunningError:
            # Raced with another sweeper or with the user clicking
            # Approve/Cancel between our SELECT and our UPDATE — fine,
            # just skip.
            continue

    return abandoned
