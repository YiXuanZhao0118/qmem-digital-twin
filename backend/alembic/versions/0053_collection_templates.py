"""collection_templates — save/instantiate Collection subtrees

Revision ID: 0053_collection_templates
Revises: 0052_fiber_split_to_paired_ends

Adds the ``collection_templates`` table backing the Collection Drift
feature: a user can snapshot a Collection (with all nested sub-collections
and SceneObject members) into a reusable template, then drop a fresh
instance back into the scene at the 3D cursor. The instance gets new
default object names and brand-new collection rows, but the per-member
relative pose (offset to the subtree's centroid + Euler angles) is exactly
what was captured at save time.

Cable connections, optical / RF links, and physics_element details are
intentionally NOT included in the snapshot — instantiation produces clean,
unwired objects.

See ``CollectionTemplate`` in app/models.py for the tree JSONB schema.
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision = "0053_collection_templates"
down_revision = "0052_fiber_split_to_paired_ends"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "collection_templates",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "tree",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )


def downgrade() -> None:
    op.drop_table("collection_templates")
