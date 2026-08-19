"""Seed the procedural ``Rect Annotation`` Asset3D row.

Rectangular table markings (``kind_id='rect_annotation'`` Components, spawned
from the Lab toolbar) draw through
``three/loadAsset/passive/rect_annotation.ts``. Since the 2026-06-10 render
unification EVERY Component renders by walking its ComponentBinding tree, so
the marking needs a binding leaf to resolve — without one it would be
"creatable, editable, invisible", exactly the bug 0119 fixed for text labels.

Same pattern as 0115 (connectors) and 0119 (text annotations): procedural
geometry still gets a real Asset3D row whose ``file_path`` is a
``primitive://`` key, so the binding tree has a leaf and ``loadAsset``'s
``primitive://`` branch dispatches to the plugin renderer by the Component's
``kind_id``. ``sceneStore.addRectAnnotation`` binds this row as the new
Component's single root binding.

``kind_id='unclassified'`` (0110): a marking carries no physics and
``kind_id`` is NOT NULL since 0111.

Idempotent via WHERE NOT EXISTS on catalog_id, same as 0119.

Revision ID: 0124_rect_annotation_asset
Revises: 0123_devices
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0124_rect_annotation_asset"
down_revision = "0123_devices"
branch_labels = None
depends_on = None


CATALOG_ID = "rect_annotation_frame"


def upgrade() -> None:
    op.get_bind().execute(
        sa.text(
            "INSERT INTO assets_3d ("
            " catalog_id, name, asset_type, file_path, source, unit,"
            " scale_factor, kind_id, default_params, anchors, tunable_params,"
            " properties, locked"
            ") SELECT"
            " :catalog_id, :name, 'primitive', :file_path, :source, 'mm', 1.0,"
            " 'unclassified', CAST('{}' AS jsonb), CAST('[]' AS jsonb),"
            " CAST('[]' AS jsonb), CAST(:properties AS jsonb), false"
            " WHERE NOT EXISTS ("
            "  SELECT 1 FROM assets_3d WHERE catalog_id = :catalog_id"
            " )"
        ),
        {
            "catalog_id": CATALOG_ID,
            "name": "Rect Annotation",
            "file_path": "primitive://rect_annotation",
            "source": "scene annotation 0124 (procedural)",
            "properties": json.dumps({"displayName": "Rect Annotation"}),
        },
    )


def downgrade() -> None:
    op.get_bind().execute(
        sa.text("DELETE FROM assets_3d WHERE catalog_id = :catalog_id"),
        {"catalog_id": CATALOG_ID},
    )
