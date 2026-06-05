"""Drop the legacy beam_paths table.

The manually-drawn BeamPath feature is fully retired — beam visualisation is
now driven exclusively by the v3 geometry tracer (BeamSegment / __rayTraceDebug).
The model, router and all frontend code are removed; this drops the now-orphaned
table. The DB held 0 beam_paths rows at removal time, so the drop is non-
destructive. ``downgrade`` recreates the table structure (data is not restored).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0103_drop_beam_paths"
down_revision = "0102_aom_rf_model"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("beam_paths")


def downgrade() -> None:
    op.create_table(
        "beam_paths",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("wavelength_nm", sa.Float(), nullable=True),
        sa.Column("color", sa.Text(), nullable=False, server_default="#ff0000"),
        sa.Column(
            "source_object_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("objects.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "target_object_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("objects.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("points", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("properties", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("visible", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
