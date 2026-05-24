"""Asset-Physics-Model v3: add face/transition/kind columns to catalog tables.

Revision ID: 0082_v3_physics
Revises: 0081_glan_w_h_6_5

Phase 2 of the Asset-Physics-Model migration (see docs/asset-physics-model.md
and docs/asset-physics-implementation.md). Introduces the v3 schema
**alongside** the existing tables — all new columns are nullable, so
existing rows stay valid and existing code that ignores them keeps working.

Tables affected:
  - assets_3d:   + catalog_id, physics_kind, faces, transitions,
                   default_params, wavelength_range_nm, body_frame_rotation
  - components:  + catalog_id, exposed_faces
  - objects:     + param_overrides, dynamic_sources

`catalog_id` is a stable string key used by the JSON catalog files in
``assets/catalog/`` so the seed script can upsert deterministically
(the UUID PK is generated on first insert). Unique index ignores NULLs
so existing rows without catalog_id remain valid.

Downgrade drops the new columns and index.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, JSONB


revision = "0082_v3_physics"
down_revision = "0081_glan_w_h_6_5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ---- assets_3d ----------------------------------------------------------
    op.add_column(
        "assets_3d",
        sa.Column("catalog_id", sa.Text(), nullable=True),
    )
    op.create_index(
        "ix_assets_3d_catalog_id",
        "assets_3d",
        ["catalog_id"],
        unique=True,
        postgresql_where=sa.text("catalog_id IS NOT NULL"),
    )
    op.add_column(
        "assets_3d",
        sa.Column("physics_kind", sa.Text(), nullable=True),
    )
    op.add_column(
        "assets_3d",
        sa.Column("faces", JSONB(), nullable=True),
    )
    op.add_column(
        "assets_3d",
        sa.Column("transitions", JSONB(), nullable=True),
    )
    op.add_column(
        "assets_3d",
        sa.Column("default_params", JSONB(), nullable=True),
    )
    op.add_column(
        "assets_3d",
        sa.Column("wavelength_range_nm", ARRAY(sa.Float()), nullable=True),
    )
    op.add_column(
        "assets_3d",
        sa.Column("body_frame_rotation", JSONB(), nullable=True),
    )

    # ---- components ---------------------------------------------------------
    op.add_column(
        "components",
        sa.Column("catalog_id", sa.Text(), nullable=True),
    )
    op.create_index(
        "ix_components_catalog_id",
        "components",
        ["catalog_id"],
        unique=True,
        postgresql_where=sa.text("catalog_id IS NOT NULL"),
    )
    op.add_column(
        "components",
        sa.Column("exposed_faces", JSONB(), nullable=True),
    )

    # ---- objects (SceneObject) ---------------------------------------------
    op.add_column(
        "objects",
        sa.Column("param_overrides", JSONB(), nullable=True),
    )
    op.add_column(
        "objects",
        sa.Column("dynamic_sources", JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("objects", "dynamic_sources")
    op.drop_column("objects", "param_overrides")

    op.drop_column("components", "exposed_faces")
    op.drop_index("ix_components_catalog_id", table_name="components")
    op.drop_column("components", "catalog_id")

    op.drop_column("assets_3d", "body_frame_rotation")
    op.drop_column("assets_3d", "wavelength_range_nm")
    op.drop_column("assets_3d", "default_params")
    op.drop_column("assets_3d", "transitions")
    op.drop_column("assets_3d", "faces")
    op.drop_column("assets_3d", "physics_kind")
    op.drop_index("ix_assets_3d_catalog_id", table_name="assets_3d")
    op.drop_column("assets_3d", "catalog_id")
