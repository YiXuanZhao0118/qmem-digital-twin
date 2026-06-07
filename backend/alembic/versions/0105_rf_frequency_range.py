"""add frequency_range_mhz to kinds + assets_3d (RF passband)

First-class RF working band, symmetric with wavelength_range_nm: optical kinds
carry a wavelength range, RF kinds a frequency range. Nullable on both tables;
existing rows keep NULL until populated.

Revision ID: 0105_rf_frequency_range
Revises: 0104_drop_scene_views
Create Date: 2026-06-07 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0105_rf_frequency_range"
down_revision = "0104_drop_scene_views"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "kinds",
        sa.Column("frequency_range_mhz", sa.ARRAY(sa.Float()), nullable=True),
    )
    op.add_column(
        "assets_3d",
        sa.Column("frequency_range_mhz", sa.ARRAY(sa.Float()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("assets_3d", "frequency_range_mhz")
    op.drop_column("kinds", "frequency_range_mhz")
