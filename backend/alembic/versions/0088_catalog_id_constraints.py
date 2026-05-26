"""Phase 9.11 — enforce ``catalog_id`` slug shape + uniqueness.

Revision ID: 0088_catalog_id_constraints
Revises: 0087_assets_anchors

Adds two guards to ``assets_3d.catalog_id`` and ``components.catalog_id``:

1. CHECK constraint — when non-null, the slug must match
   ``^[a-z0-9_]+$`` (lower-snake-case). Catches accidental garbage
   (spaces, capitals, slashes) before it lands in the catalog.

2. UNIQUE constraint — non-null slugs must be unique within a table.
   Multiple NULL rows are still allowed (PG 15+ default
   ``NULLS DISTINCT``) because most ``Component`` rows are SceneObject-
   instance leaves that never get a stable slug.

Both columns were already audited free of bad shapes / duplicates at
the time of this migration (see scripts/audit_catalog_slugs.py in the
PR description), so the constraints land without data churn.
"""

from __future__ import annotations

from alembic import op


revision = "0088_catalog_id_constraints"
down_revision = "0087_assets_anchors"
branch_labels = None
depends_on = None


_SLUG_REGEX = r"^[a-z0-9_]+$"


def upgrade() -> None:
    # Asset3D catalog_id
    op.create_check_constraint(
        "ck_assets_catalog_id_slug_shape",
        "assets_3d",
        f"catalog_id IS NULL OR catalog_id ~ '{_SLUG_REGEX}'",
    )
    op.create_unique_constraint(
        "uq_assets_catalog_id",
        "assets_3d",
        ["catalog_id"],
    )
    # Component catalog_id
    op.create_check_constraint(
        "ck_components_catalog_id_slug_shape",
        "components",
        f"catalog_id IS NULL OR catalog_id ~ '{_SLUG_REGEX}'",
    )
    op.create_unique_constraint(
        "uq_components_catalog_id",
        "components",
        ["catalog_id"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_components_catalog_id", "components", type_="unique")
    op.drop_constraint("ck_components_catalog_id_slug_shape", "components", type_="check")
    op.drop_constraint("uq_assets_catalog_id", "assets_3d", type_="unique")
    op.drop_constraint("ck_assets_catalog_id_slug_shape", "assets_3d", type_="check")
