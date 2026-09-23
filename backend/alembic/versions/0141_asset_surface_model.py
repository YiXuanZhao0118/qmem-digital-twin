"""assets_3d.surface_model — a part as real surfaces with media between them

Phase 0 of docs/surface-optics.md: a nullable JSONB column holding the
surfaces + media of an optical part (validated by ``SurfaceModelV3`` on the
PUT). NULL = no surface model, so every existing row keeps tracing through its
anchor op, and nothing in the tracer reads the column yet. No row is written,
so no ``locked`` row is touched.

Revision ID: 0141_asset_surface_model
Revises: 0140_isolator_kind_row
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "0141_asset_surface_model"
down_revision = "0140_isolator_kind_row"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "assets_3d",
        sa.Column("surface_model", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("assets_3d", "surface_model")
