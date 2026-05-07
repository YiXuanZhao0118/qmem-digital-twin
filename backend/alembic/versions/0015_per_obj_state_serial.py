"""per-object state + serial relocation

Continues the per-object alignment started in 0014 (OpticalElement). Every
"physical instance state" gets keyed by SceneObject.id rather than
Component.id, because Component is the catalog template while SceneObject
is the actual unit on the optical bench (each unit has its own serial,
calibration, runtime state, sequence, and wiring).

Schema changes:
1. `connections`:
   - from_component_id/to_component_id → from_object_id/to_object_id
   - Backfill picks the FIRST SceneObject of each endpoint component.
   - Orphans (component with no SceneObject) → DELETE.
2. `device_states`:
   - PK changes from component_id to object_id.
   - Fan-out: every existing component-state row becomes N rows (one per
     SceneObject of that component) with the same state JSON.
3. `timing_programs`:
   - PK changes from component_id to object_id.
   - Fan-out same as device_states.
   - `timing_blocks.program_component_id` → `program_object_id`; blocks
     are also fanned out (each block becomes N copies, one per object,
     with fresh UUIDs).
4. `beam_paths`:
   - source_component_id/target_component_id → source/target_object_id.
   - Backfill picks first SceneObject of each named component; orphan
     paths get NULL endpoints (allowed — both columns are nullable).
5. `components.serial_number` relocates to `objects.serial_number`:
   - Backfill the FIRST SceneObject of each component with the original
     serial; siblings keep NULL (a serial is unique to a physical unit).
   - Drop the column from components.

Revision ID: 0015_per_obj_state_serial
Revises: 0014_per_obj_optical
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0015_per_obj_state_serial"
down_revision = "0014_per_obj_optical"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ─── Helper: first-object-per-component CTE used everywhere ─────────────
    # Inlined into each statement that needs it (we can't define a CTE
    # globally in alembic). Pattern: lowest updated_at then lowest id wins.

    # ─── 1. connections: per-component → per-object endpoints ───────────────
    op.add_column(
        "connections",
        sa.Column("from_object_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "connections",
        sa.Column("to_object_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.execute(
        """
        WITH first_obj_per_comp AS (
            SELECT DISTINCT ON (component_id)
                component_id, id
            FROM objects
            ORDER BY component_id, updated_at ASC, id ASC
        )
        UPDATE connections c
        SET from_object_id = f.id, to_object_id = t.id
        FROM first_obj_per_comp f, first_obj_per_comp t
        WHERE f.component_id = c.from_component_id
          AND t.component_id = c.to_component_id
        """
    )
    op.execute(
        "DELETE FROM connections WHERE from_object_id IS NULL OR to_object_id IS NULL"
    )
    op.alter_column("connections", "from_object_id", nullable=False)
    op.alter_column("connections", "to_object_id", nullable=False)
    op.create_foreign_key(
        "fk_connections_from_object_id",
        "connections", "objects",
        ["from_object_id"], ["id"], ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_connections_to_object_id",
        "connections", "objects",
        ["to_object_id"], ["id"], ondelete="CASCADE",
    )
    op.drop_column("connections", "from_component_id")
    op.drop_column("connections", "to_component_id")

    # ─── 2. device_states: PK component_id → object_id, fan-out ─────────────
    # Strategy: build a parallel new table, populate from join, swap.
    op.execute(
        """
        CREATE TABLE device_states_new (
            object_id UUID PRIMARY KEY REFERENCES objects(id) ON DELETE CASCADE,
            state JSONB NOT NULL DEFAULT '{}',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        INSERT INTO device_states_new (object_id, state, updated_at)
        SELECT o.id, ds.state, ds.updated_at
        FROM device_states ds
        JOIN objects o ON o.component_id = ds.component_id
        """
    )
    op.execute("DROP TABLE device_states")
    op.execute("ALTER TABLE device_states_new RENAME TO device_states")

    # ─── 3. timing_programs + timing_blocks ─────────────────────────────────
    # Drop FK from blocks first so we can rebuild both. Build new tables,
    # fan-out each program × its objects, fan-out each block × its objects
    # (fresh UUIDs because each program copy needs its own block set).
    op.execute(
        """
        CREATE TABLE timing_programs_new (
            object_id UUID PRIMARY KEY REFERENCES objects(id) ON DELETE CASCADE,
            name TEXT NOT NULL DEFAULT 'program',
            spin_core_start TEXT NOT NULL DEFAULT 'WAIT',
            duration_ns DOUBLE PRECISION NOT NULL DEFAULT 0,
            properties JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        INSERT INTO timing_programs_new (
            object_id, name, spin_core_start, duration_ns,
            properties, created_at, updated_at
        )
        SELECT o.id, tp.name, tp.spin_core_start, tp.duration_ns,
               tp.properties, tp.created_at, tp.updated_at
        FROM timing_programs tp
        JOIN objects o ON o.component_id = tp.component_id
        """
    )

    op.execute(
        """
        CREATE TABLE timing_blocks_new (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            program_object_id UUID NOT NULL
                REFERENCES timing_programs_new(object_id) ON DELETE CASCADE,
            label TEXT,
            t_start_ns DOUBLE PRECISION NOT NULL,
            t_end_ns DOUBLE PRECISION NOT NULL,
            waveform_kind TEXT NOT NULL DEFAULT 'const',
            params JSONB NOT NULL DEFAULT '{}',
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        INSERT INTO timing_blocks_new (
            id, program_object_id, label, t_start_ns, t_end_ns,
            waveform_kind, params, sort_order, created_at, updated_at
        )
        SELECT
            gen_random_uuid(),
            o.id,
            tb.label, tb.t_start_ns, tb.t_end_ns,
            tb.waveform_kind, tb.params, tb.sort_order,
            tb.created_at, tb.updated_at
        FROM timing_blocks tb
        JOIN objects o ON o.component_id = tb.program_component_id
        """
    )

    op.execute("DROP TABLE timing_blocks")
    op.execute("DROP TABLE timing_programs")
    op.execute("ALTER TABLE timing_programs_new RENAME TO timing_programs")
    op.execute("ALTER TABLE timing_blocks_new RENAME TO timing_blocks")

    # ─── 4. beam_paths: source/target component → object ────────────────────
    op.add_column(
        "beam_paths",
        sa.Column("source_object_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "beam_paths",
        sa.Column("target_object_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.execute(
        """
        WITH first_obj_per_comp AS (
            SELECT DISTINCT ON (component_id)
                component_id, id
            FROM objects
            ORDER BY component_id, updated_at ASC, id ASC
        )
        UPDATE beam_paths bp
        SET source_object_id = sf.id
        FROM first_obj_per_comp sf
        WHERE sf.component_id = bp.source_component_id
        """
    )
    op.execute(
        """
        WITH first_obj_per_comp AS (
            SELECT DISTINCT ON (component_id)
                component_id, id
            FROM objects
            ORDER BY component_id, updated_at ASC, id ASC
        )
        UPDATE beam_paths bp
        SET target_object_id = tf.id
        FROM first_obj_per_comp tf
        WHERE tf.component_id = bp.target_component_id
        """
    )
    op.create_foreign_key(
        "fk_beam_paths_source_object_id",
        "beam_paths", "objects",
        ["source_object_id"], ["id"], ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_beam_paths_target_object_id",
        "beam_paths", "objects",
        ["target_object_id"], ["id"], ondelete="SET NULL",
    )
    op.drop_column("beam_paths", "source_component_id")
    op.drop_column("beam_paths", "target_component_id")

    # ─── 5. serial_number: components → objects ─────────────────────────────
    op.add_column(
        "objects",
        sa.Column("serial_number", sa.Text(), nullable=True),
    )
    # Move the serial onto the FIRST SceneObject of each component (a
    # serial is unique to a physical unit, so siblings stay NULL).
    op.execute(
        """
        WITH first_obj_per_comp AS (
            SELECT DISTINCT ON (component_id)
                component_id, id
            FROM objects
            ORDER BY component_id, updated_at ASC, id ASC
        )
        UPDATE objects o
        SET serial_number = c.serial_number
        FROM first_obj_per_comp f
        JOIN components c ON c.id = f.component_id
        WHERE o.id = f.id
          AND c.serial_number IS NOT NULL
        """
    )
    op.drop_column("components", "serial_number")


def downgrade() -> None:
    raise NotImplementedError(
        "Downgrade not supported — per-object state schema cannot be cleanly "
        "collapsed back to per-component. Restore from a pre-0015 backup if needed."
    )
