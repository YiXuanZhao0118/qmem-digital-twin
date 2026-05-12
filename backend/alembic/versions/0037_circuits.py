"""Phase B.1 — circuits table for the Electronics module.

A ``circuits`` row stores one SPICE netlist (and, in Phase E, an optional
visual schematic graph that compiles to the same netlist). Optionally
bound to a SceneObject — when the user models a chassis / PCB in 3D and
attaches its electrical schematic, ``scene_object_id`` links them. Most
Phase B circuits will be free-floating (no scene object) — the binding
is purely a UX convenience for the future Cross-module dependency phase
(F).

The ``schematic`` column is a JSONB stub for Phase E (visual editor). For
Phase B it stays empty ``'{}'`` and the ``netlist`` text column is the
single source of truth.

Revision ID: 0037_circuits
Revises: 0036_sim_runs_mphys
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision = "0037_circuits"
down_revision = "0036_sim_runs_mphys"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "circuits",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "scene_object_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("objects.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column(
            "netlist",
            sa.Text(),
            nullable=False,
            server_default="",
        ),
        sa.Column(
            "schematic",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
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
        "ix_circuits_scene_object_id",
        "circuits",
        ["scene_object_id"],
    )
    op.create_index(
        "ix_circuits_updated_at",
        "circuits",
        [sa.text("updated_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_circuits_updated_at", table_name="circuits")
    op.drop_index("ix_circuits_scene_object_id", table_name="circuits")
    op.drop_table("circuits")
