"""add collection hierarchy (Blender-style outliner)

Adds three tables and removes the unused ``parent_component_id`` column on
``objects``:

* ``collections`` — recursive tree (parent_id self-FK) of named groups with
  visibility / lock / exclude / holdout / indirect_only flags.
* ``collection_members`` — pure many-to-many between ``collections`` and
  ``objects``. Multi-linking is allowed (one object can live in many
  collections at once).
* ``scene_view_collection_overrides`` — sparse override table reserved for v2
  per-view ExcludeFromViewLayer / Holdout / Indirect Only. v1 ships the schema
  but does not write into it.

The migration also creates a single ``Master Collection`` row (``parent_id IS
NULL``) and backfills every existing ``SceneObject`` into it so the Outliner
has something to show from the moment v1 boots.

Revision ID: 0011_collections
Revises: 0010_component_archive
Create Date: 2026-05-01 12:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "0011_collections"
down_revision = "0010_component_archive"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "collections",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column(
            "parent_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("collections.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("color", sa.Text(), nullable=False, server_default="#0f766e"),
        sa.Column("visible", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("locked", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("exclude", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("holdout", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column(
            "indirect_only",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "properties",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
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
        "ix_collections_parent",
        "collections",
        ["parent_id", "sort_order"],
    )

    op.create_table(
        "collection_members",
        sa.Column(
            "collection_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("collections.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "object_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("objects.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "added_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_collection_members_object",
        "collection_members",
        ["object_id"],
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
        sa.Column("exclude", sa.Boolean(), nullable=True),
        sa.Column("holdout", sa.Boolean(), nullable=True),
        sa.Column("indirect_only", sa.Boolean(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
    )

    op.execute(
        sa.text(
            """
            INSERT INTO collections (id, name, parent_id, properties)
            VALUES (gen_random_uuid(), 'Master Collection', NULL, '{"isMaster": true}'::jsonb)
            """
        )
    )
    op.execute(
        sa.text(
            """
            INSERT INTO collection_members (collection_id, object_id, sort_order)
            SELECT m.id, o.id, ROW_NUMBER() OVER (ORDER BY o.updated_at) - 1
            FROM objects o
            CROSS JOIN (
                SELECT id FROM collections WHERE parent_id IS NULL
                ORDER BY created_at ASC LIMIT 1
            ) m
            ON CONFLICT DO NOTHING
            """
        )
    )

    with op.batch_alter_table("objects") as batch:
        batch.drop_column("parent_component_id")


def downgrade() -> None:
    with op.batch_alter_table("objects") as batch:
        batch.add_column(
            sa.Column(
                "parent_component_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("components.id"),
                nullable=True,
            )
        )

    op.drop_table("scene_view_collection_overrides")
    op.drop_index("ix_collection_members_object", table_name="collection_members")
    op.drop_table("collection_members")
    op.drop_index("ix_collections_parent", table_name="collections")
    op.drop_table("collections")
