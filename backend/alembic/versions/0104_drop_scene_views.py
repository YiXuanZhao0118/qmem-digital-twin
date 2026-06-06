"""drop saved-view tables (scene_views + scene_view_collection_overrides)

The saved-view / view-picker feature (visibility L3) was removed. Drop its two
tables. ``scene_view_collection_overrides`` (reserved-for-v2, never written) is
dropped first because it carries a FK onto ``scene_views``.

Revision ID: 0104_drop_scene_views
Revises: 0103_drop_beam_paths
Create Date: 2026-06-05 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0104_drop_scene_views"
down_revision = "0103_drop_beam_paths"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("scene_view_collection_overrides")
    op.drop_index("ix_scene_views_sort", table_name="scene_views")
    op.drop_table("scene_views")


def downgrade() -> None:
    op.create_table(
        "scene_views",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("icon", sa.Text(), nullable=True),
        sa.Column("color", sa.Text(), nullable=False, server_default="#0f766e"),
        sa.Column("filter_kind", sa.Text(), nullable=False, server_default="leaf"),
        sa.Column(
            "filter_expr",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "overlay_overrides",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("is_pinned", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_scene_views_sort",
        "scene_views",
        ["sort_order", "created_at"],
    )
    op.create_table(
        "scene_view_collection_overrides",
        sa.Column(
            "scene_view_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("scene_views.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "collection_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("collections.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("visible", sa.Boolean(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
    )
