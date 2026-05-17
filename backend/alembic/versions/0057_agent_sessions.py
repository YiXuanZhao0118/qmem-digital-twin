"""agent sessions, mutation log, approval events, draft status

Revision ID: 0057_agent_sessions
Revises: 0056_fiber_recombine_ends

Backs the in-browser AI binding agent. A "session" is one conversation
in which the agent creates draft Asset3D + Component rows and links
them; the user approves the batch at the end (locking the rows for
the agent) or abandons it (rows are rolled back via reverse-replay
of session_mutations).

Tables added
------------
* ``agent_sessions``      — one row per conversation. Status machine:
                            running → committed | cancelled | abandoned.
                            ``last_heartbeat_at`` drives auto-abandon
                            after ``heartbeat_timeout_sec`` (default 300).
* ``session_mutations``   — append-only log of every write the agent
                            made via its tool layer. ``before`` is null
                            for ``op='create'`` (v1 only supports create).
                            ``undone_at`` is set when the user clicks
                            "undo last step" — we keep the row for audit
                            rather than deleting it.
* ``approval_events``     — append-only audit log. Records ``approve``,
                            ``unlock``, ``modify_blocked``, and
                            ``session_rolled_back`` events. Never
                            UPDATEd or DELETEd.

Columns added to existing tables
--------------------------------
* ``assets_3d.status``                — 'active' (default) | 'draft'.
                                        Drafts are filtered out of
                                        normal list endpoints; only
                                        the owning session sees them.
* ``assets_3d.created_by_session_id`` — FK to agent_sessions, nullable.
                                        Permanent provenance marker
                                        (set on INSERT, never modified).
* ``assets_3d.ai_approved_at``        — non-null = locked for the AI
                                        tool layer. Existing REST routes
                                        ignore this field.
* ``components.*``                    — same three columns.

Idempotency / safety
--------------------
This migration is purely additive. Existing rows on ``assets_3d`` and
``components`` get the defaults (``status='active'``,
``created_by_session_id=NULL``, ``ai_approved_at=NULL``) which
preserves their current behavior exactly.
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision = "0057_agent_sessions"
down_revision = "0056_fiber_recombine_ends"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_sessions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        # Free-text instruction the user typed when starting the session.
        # Kept for replay / audit; never used as primary key.
        sa.Column("instruction", sa.Text(), nullable=False, server_default=""),
        # running → committed | cancelled | abandoned (terminal states).
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default="running",
        ),
        sa.Column(
            "last_heartbeat_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "heartbeat_timeout_sec",
            sa.Integer(),
            nullable=False,
            server_default="300",
        ),
        sa.Column("committed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        # Human-readable reason: 'user_cancelled' | 'abandoned_timeout' |
        # 'crash_recovery'. NULL for committed sessions.
        sa.Column("cancellation_reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    # Sweeper looks for status='running' AND last_heartbeat_at < cutoff —
    # composite index keeps that scan O(log n) as session history grows.
    op.create_index(
        "ix_agent_sessions_status_heartbeat",
        "agent_sessions",
        ["status", "last_heartbeat_at"],
    )

    op.create_table(
        "session_mutations",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("agent_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # op ∈ {'create'} in v1. Reserved for {'update','delete'} once
        # Q3 is relaxed; the before/after columns are already shaped for it.
        sa.Column("op", sa.Text(), nullable=False),
        # 'asset_3d' | 'component'. Same string used in approval_events.
        sa.Column("entity_type", sa.Text(), nullable=False),
        sa.Column(
            "entity_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        # Pre-mutation snapshot. NULL for op='create' (nothing existed).
        sa.Column(
            "before",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        # Post-mutation snapshot. NULL for op='delete' (nothing left).
        sa.Column(
            "after",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        # Set when the user clicks "undo last step". Mutation row is
        # preserved (not deleted) so the audit trail captures every
        # attempt the user made before settling on the final shape.
        sa.Column(
            "undone_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    # "find the most recent not-yet-undone mutation in this session" is the
    # hot path for undo-last — composite index covers it.
    op.create_index(
        "ix_session_mutations_session_undone_created",
        "session_mutations",
        ["session_id", "undone_at", "created_at"],
    )

    op.create_table(
        "approval_events",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        # 'approve' | 'unlock' | 'modify_blocked' | 'session_rolled_back'.
        # Free string column so new event types don't need a migration.
        sa.Column("event_type", sa.Text(), nullable=False),
        # NULL for events that aren't per-entity (e.g. 'session_rolled_back').
        sa.Column("entity_type", sa.Text(), nullable=True),
        sa.Column(
            "entity_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
        # NULL when an event isn't tied to an agent session (future:
        # manual unlock by a human via the UI).
        sa.Column(
            "session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("agent_sessions.id", ondelete="SET NULL"),
            nullable=True,
        ),
        # Free-form metadata: rolled_back_count, blocked_attempt_payload,
        # unlocked_by_user (once auth lands), etc.
        sa.Column(
            "metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="{}",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    # Columns on assets_3d ----------------------------------------------------
    op.add_column(
        "assets_3d",
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default="active",
        ),
    )
    op.add_column(
        "assets_3d",
        sa.Column(
            "created_by_session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("agent_sessions.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "assets_3d",
        sa.Column(
            "ai_approved_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    # The hot path for list endpoints is "show me all active assets",
    # so a partial index on status='active' keeps that scan tiny even
    # as draft history accumulates.
    op.create_index(
        "ix_assets_3d_status_active",
        "assets_3d",
        ["status"],
        postgresql_where=sa.text("status = 'active'"),
    )

    # Columns on components ---------------------------------------------------
    op.add_column(
        "components",
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default="active",
        ),
    )
    op.add_column(
        "components",
        sa.Column(
            "created_by_session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("agent_sessions.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "components",
        sa.Column(
            "ai_approved_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_components_status_active",
        "components",
        ["status"],
        postgresql_where=sa.text("status = 'active'"),
    )


def downgrade() -> None:
    # Drop in reverse order. FKs on the new columns are removed by
    # dropping the columns themselves; the events/mutations tables go
    # last because they reference agent_sessions.
    op.drop_index("ix_components_status_active", table_name="components")
    op.drop_column("components", "ai_approved_at")
    op.drop_column("components", "created_by_session_id")
    op.drop_column("components", "status")

    op.drop_index("ix_assets_3d_status_active", table_name="assets_3d")
    op.drop_column("assets_3d", "ai_approved_at")
    op.drop_column("assets_3d", "created_by_session_id")
    op.drop_column("assets_3d", "status")

    op.drop_table("approval_events")
    op.drop_index(
        "ix_session_mutations_session_undone_created",
        table_name="session_mutations",
    )
    op.drop_table("session_mutations")
    op.drop_index(
        "ix_agent_sessions_status_heartbeat",
        table_name="agent_sessions",
    )
    op.drop_table("agent_sessions")
