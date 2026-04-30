"""add object properties

Revision ID: 0005_object_props
Revises: 0004_assembly_relations
Create Date: 2026-04-29 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0005_object_props"
down_revision = "0004_assembly_relations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "placements",
        sa.Column("properties", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
    )


def downgrade() -> None:
    op.drop_column("placements", "properties")
