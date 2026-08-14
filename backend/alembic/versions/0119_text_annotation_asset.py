"""Seed the procedural ``Text Annotation`` Asset3D row.

Scene text labels (``kind_id='text_annotation'`` Components, spawned from
the Lab tab menu) draw through the canvas-sprite renderer
``three/loadAsset/passive/text_annotation.ts``. Since the 2026-06-10 render
unification EVERY Component renders by walking its ComponentBinding tree, so
a Component with no binding renders an empty Group — which is exactly what
text annotations did: created fine, edited fine, invisible in the scene.

The fix follows the same pattern the RF connectors use (0115): procedural
geometry still gets a real Asset3D row whose ``file_path`` is a
``primitive://`` key, so the binding tree has a leaf to resolve and
``loadAsset``'s ``primitive://`` branch dispatches to the plugin renderer by
the Component's ``kind_id``. ``sceneStore.addTextAnnotation`` binds this row
as the new Component's single root binding.

``kind_id='unclassified'`` (0110): a text label carries no physics and
``kind_id`` is NOT NULL since 0111.

Idempotent via WHERE NOT EXISTS on catalog_id, same as 0115.

Revision ID: 0119_text_annotation_asset
Revises: 0118_asset_device_id
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0119_text_annotation_asset"
down_revision = "0118_asset_device_id"
branch_labels = None
depends_on = None


CATALOG_ID = "text_annotation_label"


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
            "name": "Text Annotation",
            "file_path": "primitive://text_annotation",
            "source": "scene annotation 0119 (procedural)",
            "properties": json.dumps({"displayName": "Text Annotation"}),
        },
    )


def downgrade() -> None:
    op.get_bind().execute(
        sa.text("DELETE FROM assets_3d WHERE catalog_id = :catalog_id"),
        {"catalog_id": CATALOG_ID},
    )
