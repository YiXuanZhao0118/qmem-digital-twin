"""fix Asset3D.properties.viewerHints.bundledOverlay backfill

Revision ID: 0069_fix_viewer_hints_bundled
Revises: 0068_io_vlp_binding_tree

0068's jsonb_set used a 2-level path
(``{viewerHints,bundledOverlay}``) with ``create_missing=true``, but
postgres's jsonb_set only auto-creates the *final* key of the path —
intermediate keys (``viewerHints`` here) must already exist. With
properties starting as ``{}``, the update silently returned the
original ``{}`` and the flag never landed.

This migration uses a nested jsonb_set to materialise the
intermediate ``viewerHints`` object first, then set ``bundledOverlay``
inside it. Applies to every Asset3D referenced by an isolator
Component that has a 5-part binding tree (empty Mount bindings
present) — that's the set of Components A''.7+ has migrated, so
re-running after future A''.10/A''.11 migrations will pick up their
assets too without re-keying.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op


revision = "0069_fix_viewer_hints_bundled"
down_revision = "0068_io_vlp_binding_tree"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    # Every Component with an empty Mount binding has had its binding
    # tree populated by an A''-series migration → its housing asset
    # should have bundledOverlay=false. Set it via nested jsonb_set
    # so the intermediate viewerHints object exists.
    bind.execute(
        sa.text(
            """
            UPDATE assets_3d a
               SET properties = jsonb_set(
                     jsonb_set(
                       COALESCE(a.properties, '{}'::jsonb),
                       '{viewerHints}',
                       COALESCE(a.properties->'viewerHints', '{}'::jsonb),
                       true
                     ),
                     '{viewerHints,bundledOverlay}',
                     'false'::jsonb,
                     true
                   )
              FROM components c
             WHERE c.asset_3d_id = a.id
               AND EXISTS (
                 SELECT 1 FROM component_bindings cb
                  WHERE cb.component_id = c.id
                    AND cb.target_kind = 'empty'
               )
            """
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE assets_3d "
            "   SET properties = properties #- '{viewerHints,bundledOverlay}'"
            " WHERE properties #> '{viewerHints,bundledOverlay}' IS NOT NULL"
        )
    )
