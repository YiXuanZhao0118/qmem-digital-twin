"""Multi-physics extension of simulation_runs table.

Phase A.1 of the multi-physics platform plan
(see docs/MULTIPHYSICS_PLAN.md). Extends the V2-Phase-1 ``simulation_runs``
table (alembic 0027) with the columns the Workbench-style runner abstraction
needs:

- ``module``        — which solver kind ran this row
                      ('optics_seq' | 'optics_fdtd' | 'spice' | 'em_fem').
                      Backfill: every existing row was an optical run, so
                      default to 'optics_seq'.
- ``runner_kind``   — where the solver executed
                      ('inproc' | 'container' | 'ssh_workstation').
                      Backfill: 'inproc' (the legacy /api/simulations/...
                      endpoints all run in-process inside the FastAPI worker).
- ``params``        — module-specific input parameters (JSONB).
- ``progress``      — 0.0–1.0 progress reported by the runner. Nullable —
                      not every solver emits progress.
- ``error_message`` — populated on status='failed' / 'cancelled'.
- ``result_summary`` — small, UI-friendly summary (segment_count etc.).
                       Big blobs (full meshes, FDTD field dumps) go to
                       ``result_blob_path`` instead.
- ``result_blob_path`` — filesystem path to large output (Phase C/D).

The ``status`` column stays text (no PG enum — keeps Phase B/C/D adding new
states cheap) but the valid set grows from {'completed','running','failed'}
to {'queued','running','completed','failed','cancelled'}. Backfill is a no-op
because the new states only appear on rows created by the new POST
/api/simulation-runs endpoint.

Indexes:
- ON (module)   for module-filtered listings
- ON (status)   for "what's still running" queries

(``ix_simulation_runs_started_at`` and ``ix_simulation_runs_scene_hash``
already exist from alembic 0027.)

Revision ID: 0036_sim_runs_mphys
Revises: 0035_collection_rigid
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision = "0036_sim_runs_mphys"
down_revision = "0035_collection_rigid"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "simulation_runs",
        sa.Column(
            "module",
            sa.Text(),
            nullable=False,
            server_default="optics_seq",
        ),
    )
    op.add_column(
        "simulation_runs",
        sa.Column(
            "runner_kind",
            sa.Text(),
            nullable=False,
            server_default="inproc",
        ),
    )
    op.add_column(
        "simulation_runs",
        sa.Column(
            "params",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.add_column(
        "simulation_runs",
        sa.Column("progress", sa.Float(), nullable=True),
    )
    op.add_column(
        "simulation_runs",
        sa.Column("error_message", sa.Text(), nullable=True),
    )
    op.add_column(
        "simulation_runs",
        sa.Column(
            "result_summary",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )
    op.add_column(
        "simulation_runs",
        sa.Column("result_blob_path", sa.Text(), nullable=True),
    )

    op.create_index(
        "ix_simulation_runs_module",
        "simulation_runs",
        ["module"],
    )
    op.create_index(
        "ix_simulation_runs_status",
        "simulation_runs",
        ["status"],
    )


def downgrade() -> None:
    op.drop_index("ix_simulation_runs_status", table_name="simulation_runs")
    op.drop_index("ix_simulation_runs_module", table_name="simulation_runs")
    op.drop_column("simulation_runs", "result_blob_path")
    op.drop_column("simulation_runs", "result_summary")
    op.drop_column("simulation_runs", "error_message")
    op.drop_column("simulation_runs", "progress")
    op.drop_column("simulation_runs", "params")
    op.drop_column("simulation_runs", "runner_kind")
    op.drop_column("simulation_runs", "module")
