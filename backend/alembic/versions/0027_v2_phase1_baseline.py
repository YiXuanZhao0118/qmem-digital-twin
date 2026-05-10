"""V2 Phase 1 baseline: simulation_runs table + beam_segments FK + revisions.scene_hash

Revision ID: 0027_v2_phase1_base
Revises: 0026_fix_fiber_obj_h

V2 schema (see docs/optical-schema-v2.md §3) splits source-truth from
solver-output:

  source truth: objects, optical_elements, optical_links,
                objects.properties.anchorBindings,
                objects.properties.opticalSources

  solver output: simulation_runs, beam_segments

This migration lays the table-shaped half of that split. The JSONB-shaped
half (anchorBindings/opticalSources) needs no migration because
SceneObject.properties is already a JSONB column.

Changes:
1. Create `simulation_runs` table (was missing — beam_segments.simulation_run_id
   was a phantom UUID with no FK). Holds per-run metadata: solver version,
   status, scene hash at run time, settings, warnings.
2. Promote `beam_segments.simulation_run_id` to a real FK with ON DELETE
   SET NULL. Existing segment rows (which point to in-memory uuid4()s
   that were never persisted) get NULL'd via the FK conversion.
3. Add `revisions.scene_hash` indexed text column. The V2 plan uses this
   to decide whether an existing simulation_run is still valid for the
   current scene state. Backfill existing rows with NULL.
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision = "0027_v2_phase1_base"
down_revision = "0026_fix_fiber_obj_h"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. simulation_runs table
    op.create_table(
        "simulation_runs",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "revision_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("revisions.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("solver_version", sa.Text(), nullable=False, server_default="optical-solver-v1"),
        sa.Column("status", sa.Text(), nullable=False, server_default="completed"),
        sa.Column("scene_hash", sa.Text(), nullable=True),
        sa.Column(
            "settings",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "warnings",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "finished_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_simulation_runs_scene_hash",
        "simulation_runs",
        ["scene_hash"],
    )
    op.create_index(
        "ix_simulation_runs_started_at",
        "simulation_runs",
        ["started_at"],
    )

    # 2. Promote beam_segments.simulation_run_id to a real FK.
    # Any pre-existing values point at in-memory uuid4()s that were never
    # persisted in simulation_runs, so they would orphan immediately. NULL
    # them out before the constraint goes on, otherwise the DB will reject
    # the FK creation.
    op.execute("UPDATE beam_segments SET simulation_run_id = NULL")
    op.create_foreign_key(
        "fk_beam_segments_simulation_run_id",
        "beam_segments",
        "simulation_runs",
        ["simulation_run_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # 3. revisions.scene_hash for V2 staleness check.
    op.add_column(
        "revisions",
        sa.Column("scene_hash", sa.Text(), nullable=True),
    )
    op.create_index(
        "ix_revisions_scene_hash",
        "revisions",
        ["scene_hash"],
    )


def downgrade() -> None:
    op.drop_index("ix_revisions_scene_hash", table_name="revisions")
    op.drop_column("revisions", "scene_hash")

    op.drop_constraint(
        "fk_beam_segments_simulation_run_id",
        "beam_segments",
        type_="foreignkey",
    )

    op.drop_index("ix_simulation_runs_started_at", table_name="simulation_runs")
    op.drop_index("ix_simulation_runs_scene_hash", table_name="simulation_runs")
    op.drop_table("simulation_runs")
