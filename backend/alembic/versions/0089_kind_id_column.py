"""Phase 9.13 — introduce unified ``kind_id`` column on Component + Asset3D.

Revision ID: 0089_kind_id_column
Revises: 0088_catalog_id_constraints

Goal: collapse the two parallel classification fields (
``components.component_type``, ``assets_3d.physics_kind``) into a single
``kind_id`` slug pointing at the Kind registry. This migration only
*adds* ``kind_id`` and backfills it from the existing legacy column —
``component_type`` / ``physics_kind`` stay around for a follow-up drop
migration after all readers have moved over (see M5 in the unification
plan).

Backfill is a verbatim copy (no alias canonicalization). Values like
``pbs`` / ``lens`` / ``isolator`` / ``faraday_rotator`` that aren't
currently in the Kind registry land in ``kind_id`` as-is; expanding the
registry to recognise them is tracked separately.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0089_kind_id_column"
down_revision = "0088_catalog_id_constraints"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ---- components.kind_id ------------------------------------------------
    op.add_column(
        "components",
        sa.Column("kind_id", sa.Text(), nullable=True),
    )
    op.execute("UPDATE components SET kind_id = component_type")
    op.create_index("ix_components_kind_id", "components", ["kind_id"])

    # ---- assets_3d.kind_id -------------------------------------------------
    op.add_column(
        "assets_3d",
        sa.Column("kind_id", sa.Text(), nullable=True),
    )
    op.execute("UPDATE assets_3d SET kind_id = physics_kind")
    op.create_index("ix_assets_3d_kind_id", "assets_3d", ["kind_id"])


def downgrade() -> None:
    op.drop_index("ix_assets_3d_kind_id", table_name="assets_3d")
    op.drop_column("assets_3d", "kind_id")
    op.drop_index("ix_components_kind_id", table_name="components")
    op.drop_column("components", "kind_id")
