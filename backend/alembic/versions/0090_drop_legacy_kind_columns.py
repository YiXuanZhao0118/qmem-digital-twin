"""Phase 9.14 — drop legacy ``components.component_type`` and
``assets_3d.physics_kind`` columns now that ``kind_id`` is the canonical
classification field.

Revision ID: 0090_drop_legacy_kind_columns
Revises: 0089_kind_id_column

Preconditions (all met by M5.1–M5.3):
  - Every Component row has ``kind_id`` populated (backfilled in 0089).
  - Every Asset3D row has ``kind_id`` populated (backfilled in 0089).
  - Backend ORM no longer maps ``component_type`` / ``physics_kind``.
  - Frontend types + UI read/write ``kindId`` exclusively.

The downgrade re-adds the columns nullable and re-backfills from
``kind_id`` so the schema can round-trip if a rollback is needed.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0090_drop_legacy_kind_columns"
down_revision = "0089_kind_id_column"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("components", "component_type")
    op.drop_column("assets_3d", "physics_kind")


def downgrade() -> None:
    op.add_column(
        "components",
        sa.Column("component_type", sa.Text(), nullable=True),
    )
    op.execute("UPDATE components SET component_type = kind_id")
    op.alter_column("components", "component_type", nullable=False)

    op.add_column(
        "assets_3d",
        sa.Column("physics_kind", sa.Text(), nullable=True),
    )
    op.execute("UPDATE assets_3d SET physics_kind = kind_id")
