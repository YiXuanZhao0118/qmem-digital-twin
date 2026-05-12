"""Phase F+: pulse_blaster_channels — wire PulseBlaster TTL channels to lab Components.

Single-PulseBlaster MVP. One row per physical TTL channel (0..23 for a
PB24/ESR; up to 32 for some PRO models). Each channel optionally binds
to a Component (the lab device whose gate this channel drives).

The actual TimingProgram (per-Component, alembic 0008-ish) stays the
single source of truth for "what should this device do at time t".
This table just tells the dispatch layer "channel N is wired to
Component X's gate", so the timing program for X gets emitted as
spinapi opcodes on channel N. With this in place a single SpinCore
opcode stream can drive the whole lab.

Revision ID: 0040_pulse_blaster_channels
Revises: 0039_coils_magnetics
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision = "0040_pulse_blaster_channels"
down_revision = "0039_coils_magnetics"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "pulse_blaster_channels",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("channel_index", sa.Integer(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "target_component_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("components.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("invert", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_unique_constraint(
        "uq_pulse_blaster_channels_index",
        "pulse_blaster_channels",
        ["channel_index"],
    )
    op.create_index(
        "ix_pulse_blaster_channels_target_component_id",
        "pulse_blaster_channels",
        ["target_component_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_pulse_blaster_channels_target_component_id",
        table_name="pulse_blaster_channels",
    )
    op.drop_constraint(
        "uq_pulse_blaster_channels_index",
        "pulse_blaster_channels",
        type_="unique",
    )
    op.drop_table("pulse_blaster_channels")
