"""Restructure TimingProgram: own id PK, TTL/Trigger kind, intervals JSONB.

This collapses the old (TimingProgram per-object 1:1) + (TimingBlock separate
table with 5 waveform kinds) model down to:

  TimingProgram(id PK, name?, kind in {"TTL","Trigger"}, intervals JSONB[])

with intervals stored as ``[{spinCoreStartNs, spinCoreEndNs}, ...]``
inline. Consumers (rfSources.triggerBinding / gateBinding, PulseBlaster
channels) reference programs by ``id``; a single program can be shared
across multiple consumers.

Drops:
- ``timing_blocks`` table (intervals now JSONB on the parent row)
- ``timing_programs.object_id`` PK + column (no longer per-object)
- ``timing_programs.spin_core_start`` / ``duration_ns`` / ``properties``
- ``waveform_kind`` enum richness (gate_on / gate_off / const / linear_ramp /
  arbitrary) — only "high" intervals are stored; everywhere else is LOW
  by default. const{value>=0.5} blocks are folded into intervals; gate_off
  / const{<0.5} are dropped (off is the default); linear_ramp / arbitrary
  are dropped wholesale (no longer expressible).
- ``pulse_blaster_channels.target_component_id`` — channels now bind to a
  ``target_timing_program_id`` instead.

Downgrade is intentionally unsupported. The JSONB intervals can't round-
trip back to typed TimingBlock rows, and the dropped waveform kinds
(linear_ramp / arbitrary) have no representation in the new model.

Revision ID: 0045_restructure_timing_program
Revises: 0044_rf_links
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision = "0045_restructure_timing_program"
down_revision = "0044_rf_links"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Add new columns on timing_programs.
    op.add_column(
        "timing_programs",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
    )
    op.add_column(
        "timing_programs",
        sa.Column(
            "kind",
            sa.Text(),
            nullable=False,
            server_default="TTL",
        ),
    )
    op.add_column(
        "timing_programs",
        sa.Column(
            "intervals",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )

    # 2. Migrate timing_blocks → timing_programs.intervals JSONB.
    #    gate_on        → interval entry
    #    const>=0.5     → interval entry (treated as gate_on)
    #    gate_off / const<0.5 / linear_ramp / arbitrary → dropped
    op.execute(
        sa.text(
            """
            UPDATE timing_programs tp
            SET intervals = COALESCE((
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'spinCoreStartNs', tb.t_start_ns,
                        'spinCoreEndNs',   tb.t_end_ns
                    )
                    ORDER BY tb.t_start_ns
                )
                FROM timing_blocks tb
                WHERE tb.program_object_id = tp.object_id
                  AND (
                    tb.waveform_kind = 'gate_on'
                    OR (
                        tb.waveform_kind = 'const'
                        AND COALESCE((tb.params->>'value')::float, 0) >= 0.5
                    )
                  )
            ), '[]'::jsonb)
            """
        )
    )

    # 3. Drop timing_blocks entirely — its data now lives in JSONB above.
    op.drop_table("timing_blocks")

    # 4. Swap timing_programs PK from object_id to id, then drop old columns.
    #    The PK constraint name is 'timing_programs_new_pkey' (inherited from
    #    the alembic 0015 table swap; pg never renames constraint names on
    #    ALTER TABLE RENAME).
    op.drop_constraint(
        "timing_programs_new_pkey", "timing_programs", type_="primary"
    )
    op.create_primary_key("timing_programs_pkey", "timing_programs", ["id"])

    op.drop_column("timing_programs", "object_id")
    op.drop_column("timing_programs", "spin_core_start")
    op.drop_column("timing_programs", "duration_ns")
    op.drop_column("timing_programs", "properties")

    # name was NOT NULL DEFAULT 'program'; relax to nullable. Useful as an
    # optional human label when several consumers reference the same program.
    op.alter_column(
        "timing_programs",
        "name",
        existing_type=sa.Text(),
        nullable=True,
        existing_server_default="program",
        server_default=None,
    )

    # 5. PulseBlaster channels: bind to timing_program_id, not component_id.
    op.add_column(
        "pulse_blaster_channels",
        sa.Column(
            "target_timing_program_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("timing_programs.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.drop_column("pulse_blaster_channels", "target_component_id")


def downgrade() -> None:
    raise NotImplementedError(
        "0045 is one-way: intervals JSONB cannot losslessly round-trip back "
        "to typed TimingBlock rows. Restore from a pre-0045 snapshot if you "
        "need the old shape."
    )
