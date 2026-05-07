"""add timing_programs and timing_blocks

Adds two tables for per-component timed action sequences (laser power
profiles, AOM gating, EOM phase modulation, ...). One TimingProgram per
component (1:1 via PK on component_id), N TimingBlocks per program.

Revision ID: 0012_timing_programs
Revises: 0011_collections
Create Date: 2026-05-01 17:30:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0012_timing_programs"
down_revision = "0011_collections"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "timing_programs",
        sa.Column(
            "component_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("components.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("name", sa.Text(), nullable=False, server_default="program"),
        sa.Column("spin_core_start", sa.Text(), nullable=False, server_default="WAIT"),
        sa.Column("duration_ns", sa.Float(), nullable=False, server_default="0"),
        sa.Column(
            "properties",
            postgresql.JSONB(),
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
            onupdate=sa.func.now(),
        ),
        sa.CheckConstraint(
            "spin_core_start IN ('WAIT', 'CONTINUE')",
            name="timing_programs_spin_core_start_valid",
        ),
    )

    op.create_table(
        "timing_blocks",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "program_component_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("timing_programs.component_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("label", sa.Text(), nullable=True),
        sa.Column("t_start_ns", sa.Float(), nullable=False),
        sa.Column("t_end_ns", sa.Float(), nullable=False),
        sa.Column("waveform_kind", sa.Text(), nullable=False, server_default="const"),
        sa.Column(
            "params",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
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
            onupdate=sa.func.now(),
        ),
        sa.CheckConstraint(
            "waveform_kind IN ('const', 'linear_ramp', 'arbitrary', 'gate_on', 'gate_off')",
            name="timing_blocks_waveform_kind_valid",
        ),
        sa.CheckConstraint(
            "t_end_ns > t_start_ns",
            name="timing_blocks_end_after_start",
        ),
    )

    op.create_index(
        "ix_timing_blocks_program_t_start",
        "timing_blocks",
        ["program_component_id", "t_start_ns"],
    )


def downgrade() -> None:
    op.drop_index("ix_timing_blocks_program_t_start", table_name="timing_blocks")
    op.drop_table("timing_blocks")
    op.drop_table("timing_programs")
