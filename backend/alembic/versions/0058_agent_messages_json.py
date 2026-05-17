"""persisted per-session conversation history

Revision ID: 0058_agent_messages_json
Revises: 0057_agent_sessions

Adds ``agent_sessions.messages_json`` — the Anthropic SDK ``messages``
array for the agent_orchestrator's tool-use loop. The orchestrator
loads this on every turn and writes it back after the model finishes
the turn, so a backend restart or browser refresh mid-session can
resume the conversation without losing context.

Nullable. NULL == "no turns yet" (equivalent to ``[]``). Stored as
JSONB (not TEXT) so future debug queries can index into specific
message indices via ``messages_json -> N`` operators.
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision = "0058_agent_messages_json"
down_revision = "0057_agent_sessions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agent_sessions",
        sa.Column(
            "messages_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("agent_sessions", "messages_json")
