"""Add the asset_lods sidecar table — per-asset LOD tier manifest.

objectives.md R-4/R-5. One row per (asset, level): level 0 is the asset's own
mesh, 1 and 2 are the decimated tiers BUILD emits on save. `error_mm` is the
tier's measured maximum deviation from LOD0 (meshoptimizer's simplify error,
scaled to mm) — it is R-5's runtime switching input, not a gated tolerance.

Why a separate table rather than a column / properties key on `assets_3d`:
most catalog assets carry `locked = true`, and `lock_guard` rejects any write
to a non-`locked` field of a locked row with 422. A LOD tier is a *derived
render artifact*, not the asset's ground truth, so generating one must not
require a human to unlock the asset first. A sidecar table sidesteps the guard
entirely and keeps the lock's meaning intact.

Invariants (enforced in `routers/v3_catalog.py`, not by the DB):
  * the level-0 row's `file_path` equals `assets_3d.file_path`;
  * every geometry-writing route deletes the asset's rows, so a tier can never
    outlive the mesh it was derived from;
  * `hints_digest` pins the `viewerHints` the tiers were baked against —
    viewerHints centroid keys are computed on the full-resolution mesh, so
    editing them invalidates every tier.

Revision ID: 0122_asset_lods
Revises: 0121_mechanical_kind
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

from alembic import op


revision = "0122_asset_lods"
down_revision = "0121_mechanical_kind"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "asset_lods",
        sa.Column(
            "id",
            PG_UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "asset_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("assets_3d.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("level", sa.SmallInteger(), nullable=False),
        sa.Column("file_path", sa.Text(), nullable=False),
        sa.Column("tri_count", sa.Integer(), nullable=False),
        sa.Column("byte_size", sa.Integer(), nullable=False),
        # Absolute max deviation from LOD0 in mm. 0 for level 0 by definition.
        sa.Column(
            "error_mm",
            sa.Float(),
            nullable=False,
            server_default="0",
        ),
        sa.Column("hints_digest", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint("level >= 0 AND level <= 2", name="ck_asset_lods_level"),
        sa.UniqueConstraint("asset_id", "level", name="uq_asset_lods_asset_level"),
    )
    op.create_index("ix_asset_lods_asset_id", "asset_lods", ["asset_id"])


def downgrade() -> None:
    op.drop_index("ix_asset_lods_asset_id", table_name="asset_lods")
    op.drop_table("asset_lods")
