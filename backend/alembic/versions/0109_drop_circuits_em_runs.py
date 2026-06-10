"""drop circuits table + purge removed-module simulation runs

The Optics (optics_cavity / optics_crystal), Electronics (spice), and EM
(em_fem) modules were removed on 2026-06-10 — frontend tabs, backend
solvers/routers, and the ``SimulationModule`` enum values. This migration
cleans up the DB side of that removal:

1. Drop ``rf_chain_nodes.linked_circuit_id`` (the dead "Linked schematics"
   FK into ``circuits``). Its sibling ``linked_em_problem_id`` stays — the
   EM problems / meshes / touchstone tables are retained.
2. Drop the ``circuits`` table (Phase B Electronics, alembic 0037). It must
   be dropped AFTER the FK column above so the constraint is gone first.
3. Delete ``simulation_runs`` rows whose ``module`` is one of the removed
   values. Those rows would otherwise fail Pydantic validation on read now
   that the values are gone from ``SimulationModule``. ``module`` is a plain
   text column (alembic 0036), so this is a data delete, not an enum-type
   change. THIS STEP IS IRREVERSIBLE — the downgrade cannot restore the
   deleted rows.

Revision ID: 0109_drop_circuits_em_runs
Revises: 0108_rf_switch_filepath
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision = "0109_drop_circuits_em_runs"
down_revision = "0108_rf_switch_filepath"
branch_labels = None
depends_on = None


_REMOVED_MODULES = ("optics_cavity", "optics_crystal", "spice", "em_fem")


def upgrade() -> None:
    # 1. Drop the dead FK column into circuits (removes the FK constraint).
    op.drop_column("rf_chain_nodes", "linked_circuit_id")

    # 2. Drop the circuits table (indexes go with it on PostgreSQL).
    op.drop_table("circuits")

    # 3. Purge orphaned simulation_runs rows for the removed modules.
    op.get_bind().execute(
        sa.text(
            "DELETE FROM simulation_runs WHERE module IN "
            "('optics_cavity', 'optics_crystal', 'spice', 'em_fem')"
        )
    )


def downgrade() -> None:
    # Recreate circuits (mirror of alembic 0037) so the FK target exists...
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
        sa.Column("netlist", sa.Text(), nullable=False, server_default=""),
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
    op.create_index("ix_circuits_scene_object_id", "circuits", ["scene_object_id"])
    op.create_index(
        "ix_circuits_updated_at", "circuits", [sa.text("updated_at DESC")]
    )

    # ...then re-add the FK column (mirror of alembic 0041).
    op.add_column(
        "rf_chain_nodes",
        sa.Column(
            "linked_circuit_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("circuits.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    # Note: the simulation_runs rows deleted in upgrade() cannot be restored.
