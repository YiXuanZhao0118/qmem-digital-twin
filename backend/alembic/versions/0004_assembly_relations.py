"""add assembly relations

Revision ID: 0004_assembly_relations
Revises: 0003_object_names
Create Date: 2026-04-29 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0004_assembly_relations"
down_revision = "0003_object_names"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "assembly_relations",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("relation_type", sa.Text(), nullable=False),
        sa.Column(
            "object_a_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("placements.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "object_b_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("placements.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("selector_a", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("selector_b", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("offset_mm", sa.Float(), nullable=True),
        sa.Column("angle_deg", sa.Float(), nullable=True),
        sa.Column("tolerance_mm", sa.Float(), nullable=False, server_default="0.01"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("solved", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("properties", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("assembly_relations")
