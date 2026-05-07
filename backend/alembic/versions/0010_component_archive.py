"""add archived_at to components for soft-delete

Adds a nullable `archived_at` timestamp to `components`. NULL means active;
non-NULL means the component has been removed by the user and must not
reappear (seed.py / re-imports honour this flag).

Revision ID: 0010_component_archive
Revises: 0009_rename_objects
Create Date: 2026-05-01 09:45:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0010_component_archive"
down_revision = "0009_rename_objects"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "components",
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_components_archived_at",
        "components",
        ["archived_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_components_archived_at", table_name="components")
    op.drop_column("components", "archived_at")
