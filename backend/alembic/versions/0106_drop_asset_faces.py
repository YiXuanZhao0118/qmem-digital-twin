"""drop assets_3d.faces + transitions (v2 face path retired)

The legacy face-based v2 solver path is gone (anchor tracer is the production
path), so the per-asset faces[] / transitions[] columns are no longer read or
written. Drop them. Downgrade re-adds the nullable JSONB columns (data is not
restored — it lived only on the retired path).

Revision ID: 0106_drop_asset_faces
Revises: 0105_rf_frequency_range
Create Date: 2026-06-07 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0106_drop_asset_faces"
down_revision = "0105_rf_frequency_range"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("assets_3d", "faces")
    op.drop_column("assets_3d", "transitions")


def downgrade() -> None:
    op.add_column("assets_3d", sa.Column("transitions", postgresql.JSONB(), nullable=True))
    op.add_column("assets_3d", sa.Column("faces", postgresql.JSONB(), nullable=True))
