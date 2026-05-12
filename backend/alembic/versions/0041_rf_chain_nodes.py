"""Phase RF.2: rf_chain_nodes — model an RF driver chain feeding an AOM/EOM.

Each row is one element of the RF chain (synth → amp → filter → … →
device). `terminal_scene_object_id` points at the lab device whose
kindParams.frequency/power this chain ultimately drives (typically an
AOM or EOM). `position_in_chain` is monotonic; node 0 is the source
end (DDS), the largest index is the device end.

Each node can optionally `linked_circuit_id` (SPICE) or
`linked_em_problem_id` (palace .s2p) — the Linked schematics chip
pattern means clicking a node jumps to its underlying simulation.

For the chain-summation UI (power_dbm at the device end), every
node carries a static `gain_db` knob (positive = amplifier, negative =
attenuator/insertion loss).

Revision ID: 0041_rf_chain_nodes
Revises: 0040_pulse_blaster_channels
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision = "0041_rf_chain_nodes"
down_revision = "0040_pulse_blaster_channels"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "rf_chain_nodes",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "terminal_scene_object_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("objects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("position_in_chain", sa.Integer(), nullable=False),
        sa.Column("node_kind", sa.Text(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False, server_default=""),
        sa.Column("gain_db", sa.Float(), nullable=False, server_default="0"),
        sa.Column(
            "kind_params",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "linked_circuit_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("circuits.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "linked_em_problem_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("em_problems.id", ondelete="SET NULL"),
            nullable=True,
        ),
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
    op.create_index(
        "ix_rf_chain_nodes_terminal_scene_object_id",
        "rf_chain_nodes",
        ["terminal_scene_object_id"],
    )
    op.create_unique_constraint(
        "uq_rf_chain_nodes_terminal_position",
        "rf_chain_nodes",
        ["terminal_scene_object_id", "position_in_chain"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_rf_chain_nodes_terminal_position",
        "rf_chain_nodes",
        type_="unique",
    )
    op.drop_index(
        "ix_rf_chain_nodes_terminal_scene_object_id",
        table_name="rf_chain_nodes",
    )
    op.drop_table("rf_chain_nodes")
