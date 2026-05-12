"""Collection schema cleanup + rigid_transform.

Two related changes to the Outliner data model:

1. **Drop deprecated flags.** ``collections.locked`` was specced but never
   enforced anywhere; lock is now strictly per-SceneObject (``objects.locked``,
   already in 0001) — collection-level lock is redefined as a UI bulk action
   over its descendants and stores no state. ``collections.exclude`` is folded
   into ``visible`` (the project never had a view-layer concept that would
   distinguish them); ``collections.holdout`` and ``collections.indirect_only``
   are render-engine concepts (alpha matte, indirect-only contribution) that
   carry no meaning in this optical-scene viewer.

   The same three sparse-override columns disappear from
   ``scene_view_collection_overrides``, leaving ``visible`` as the only flag
   that tracks per-view overrides.

2. **Add ``collections.rigid_transform``.** When true on a collection, every
   descendant SceneObject is treated as part of one rigid group: translating
   or rotating any member applies the same rigid-body transform to all the
   others, so the relative pose A↔B↔C stays fixed (Blender-style "transform
   together"). Effective state cascades: a collection inherits
   rigid_transform=true from any ancestor with rigid_transform=true. The
   column itself is plain — the cascade is computed at read time so we don't
   have to keep parents and children in sync on every toggle.

Revision ID: 0035_collection_rigid
Revises: 0034_isolator_v2_cut
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "0035_collection_rigid"
down_revision = "0034_isolator_v2_cut"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("collections") as batch:
        batch.drop_column("locked")
        batch.drop_column("exclude")
        batch.drop_column("holdout")
        batch.drop_column("indirect_only")
        batch.add_column(
            sa.Column(
                "rigid_transform",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            )
        )

    with op.batch_alter_table("scene_view_collection_overrides") as batch:
        batch.drop_column("exclude")
        batch.drop_column("holdout")
        batch.drop_column("indirect_only")


def downgrade() -> None:
    with op.batch_alter_table("scene_view_collection_overrides") as batch:
        batch.add_column(sa.Column("exclude", sa.Boolean(), nullable=True))
        batch.add_column(sa.Column("holdout", sa.Boolean(), nullable=True))
        batch.add_column(sa.Column("indirect_only", sa.Boolean(), nullable=True))

    with op.batch_alter_table("collections") as batch:
        batch.drop_column("rigid_transform")
        batch.add_column(
            sa.Column(
                "indirect_only",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            )
        )
        batch.add_column(
            sa.Column(
                "holdout",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            )
        )
        batch.add_column(
            sa.Column(
                "exclude",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            )
        )
        batch.add_column(
            sa.Column(
                "locked",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            )
        )
