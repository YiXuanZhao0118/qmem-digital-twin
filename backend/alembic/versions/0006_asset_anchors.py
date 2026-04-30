"""add anchors column to assets_3d

Revision ID: 0006_asset_anchors
Revises: 0005_object_props
Create Date: 2026-04-30 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0006_asset_anchors"
down_revision = "0005_object_props"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "assets_3d",
        sa.Column(
            "anchors",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("assets_3d", "anchors")
