"""Side: AI binding session state + audit trail."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, JsonDict, JsonList


class AgentSession(Base):
    """One AI binding conversation (alembic 0057).

    State machine::

        running ──(commit)──▶ committed
                ──(cancel)──▶ cancelled
                ──(timeout)─▶ abandoned

    Terminal states are immutable. Sweeper task picks up rows with
    status='running' AND last_heartbeat_at older than
    heartbeat_timeout_sec and transitions them to 'abandoned' +
    reverse-replays session_mutations to roll back any drafts.
    """

    __tablename__ = "agent_sessions"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    instruction: Mapped[str] = mapped_column(
        Text, nullable=False, default="", server_default=""
    )
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="running", server_default="running"
    )
    last_heartbeat_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    heartbeat_timeout_sec: Mapped[int] = mapped_column(
        Integer, nullable=False, default=300, server_default="300"
    )
    committed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancellation_reason: Mapped[str | None] = mapped_column(Text)
    # Anthropic SDK messages[] persisted across turns (alembic 0058).
    # NULL means "no turns yet". Loaded by agent_orchestrator on every
    # turn so a restart / browser refresh resumes mid-conversation.
    messages_json: Mapped[JsonList | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    mutations: Mapped[list[SessionMutation]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )


class SessionMutation(Base):
    """One write the agent made via its tool layer (alembic 0057).

    v1 only logs op='create' (Q3 invariant: agent can't update or
    delete). The before/after columns are shaped for future
    update/delete support without another migration.

    ``undone_at`` is set when the user clicks "undo last step" in the
    UI — the row is preserved (not deleted) so the audit trail shows
    every attempt the user made before settling on the final shape.
    Undone mutations are skipped at commit time and at rollback time.
    """

    __tablename__ = "session_mutations"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    session_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("agent_sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    op: Mapped[str] = mapped_column(Text, nullable=False)
    entity_type: Mapped[str] = mapped_column(Text, nullable=False)
    entity_id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    before: Mapped[JsonDict | None] = mapped_column(JSONB)
    after: Mapped[JsonDict | None] = mapped_column(JSONB)
    undone_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    session: Mapped[AgentSession] = relationship(back_populates="mutations")


class ApprovalEvent(Base):
    """Append-only audit log (alembic 0057).

    Records every approve, unlock, modify_blocked attempt, and session
    rollback. Never UPDATEd or DELETEd — the audit trail is the only
    source of truth for "what did the AI agent try to do, and what got
    approved by a human".

    Note: the Python attribute is ``event_metadata`` because
    ``DeclarativeBase.metadata`` is reserved; the underlying SQL column
    is still named ``metadata``.
    """

    __tablename__ = "approval_events"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    entity_type: Mapped[str | None] = mapped_column(Text)
    entity_id: Mapped[uuid.UUID | None] = mapped_column(PG_UUID(as_uuid=True))
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("agent_sessions.id", ondelete="SET NULL"),
    )
    event_metadata: Mapped[JsonDict] = mapped_column(
        "metadata", JSONB, nullable=False, default=dict, server_default="{}"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

