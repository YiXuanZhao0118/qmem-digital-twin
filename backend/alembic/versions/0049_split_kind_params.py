"""Phase 4: split physics_elements.kind_params into intrinsic_params + state_params

Revision ID: 0049_split_kind_params
Revises: 0048_aom_default_rf_in

Phase 4 of the three-layer (Spec sheet / Knob / Probe) refactor splits the
single ``kind_params`` JSONB blob into two columns:

  * ``intrinsic_params`` — spec-sheet values that don't change unless the
    physical part is swapped (refractive index, amplifier gain, AD9959 PLL
    multiplier, …). The Object panel renders this read-only.
  * ``state_params`` — operating-state knobs the user dials at experiment
    time (waveplate fast-axis angle, diffraction order, AD9959 channel
    freq / amp, …). The PHY Editor edits these.

``kind_params`` is **kept** as a derived merged view to give existing
solver code time to migrate. After Phase 5 (solver rewrite) consumers
read the two columns directly and ``kind_params`` can be retired in a
follow-up migration. For now it stays in sync: every read that goes
through ``app.crud`` merges the two; every write fans out from
``kind_params`` based on the kinds manifest partition.

Per-row migration:
  - Look up the plugin's intrinsic / state keys via
    ``app.kinds_manifest.partition_kind_params`` (reads the same manifest
    the frontend generates).
  - Write the split halves into the new columns.
  - Leave ``kind_params`` unchanged so existing reads keep working.

Plugins that have not been migrated (no ``intrinsic_param_keys`` /
``state_param_keys`` declared in the manifest) get
``intrinsic_params = {}`` and ``state_params = kind_params`` — the
"every key is state" default the partition helper returns.

Down-migration drops the two columns; the original ``kind_params`` blob
is the single source of truth pre-Phase-4 so no data is lost.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0049_split_kind_params"
down_revision = "0048_aom_default_rf_in"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add the two new columns. Default to {} so existing rows stay valid
    # while the migration backfills them.
    op.add_column(
        "physics_elements",
        sa.Column(
            "intrinsic_params",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.add_column(
        "physics_elements",
        sa.Column(
            "state_params",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )

    # Back-fill: walk every row, dispatch on element_kind, partition via
    # the manifest. Imported here (not at module top) so alembic's offline
    # mode doesn't try to load the JSON during SQL generation.
    from app.kinds_manifest import partition_kind_params

    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id, element_kind, kind_params FROM physics_elements")
    ).fetchall()
    for row in rows:
        kp = row.kind_params or {}
        if not isinstance(kp, dict):
            kp = {}
        intrinsic, state = partition_kind_params(row.element_kind, kp)
        conn.execute(
            sa.text(
                "UPDATE physics_elements SET "
                "intrinsic_params = CAST(:i AS JSONB), "
                "state_params = CAST(:s AS JSONB) "
                "WHERE id = :id"
            ),
            {
                "i": json.dumps(intrinsic),
                "s": json.dumps(state),
                "id": row.id,
            },
        )


def downgrade() -> None:
    op.drop_column("physics_elements", "state_params")
    op.drop_column("physics_elements", "intrinsic_params")
