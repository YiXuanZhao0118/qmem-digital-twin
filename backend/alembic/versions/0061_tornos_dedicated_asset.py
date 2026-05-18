"""give Coherent TORNOS isolator its own Asset3D so PBS anchors can be edited

Revision ID: 0061_tornos_dedicated_asset
Revises: 0060_waveplate_fast_axis_to_asset

Before this migration the Coherent TORNOS-850-4 isolator component pointed
at the shared ``primitive_box`` Asset3D, which is also used by ~30 other
unrelated components (lasers, EOMs, vacuum chambers, mounting clamps, ...).
Anchors live on Asset3D; the PHY Editor's "save anchor positions" path
writes into the asset row, so any attempt to add ``front_pbs`` / ``back_pbs``
anchors to TORNOS would have applied them to every other component using
``primitive_box``.

This clones the shared row into a new dedicated asset
(``coherent_tornos_850_4_primitive``) and re-points the TORNOS component
at it. Anchor edits in PHY Editor are now scoped to TORNOS only. Same
split pattern as 0054_split_rf_cable_assets.

Idempotent. If the new asset row already exists, skips creation and just
fixes up the component ``asset_3d_id`` pointer.

Downgrade
---------
Repoints TORNOS back at ``primitive_box`` and deletes the new asset only
if no other component references it. Destructive of any TORNOS-specific
anchor edits.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0061_tornos_dedicated_asset"
down_revision = "0060_waveplate_fast_axis_asset"
branch_labels = None
depends_on = None


SOURCE_ASSET_NAME = "primitive_box"
NEW_ASSET_NAME = "coherent_tornos_850_4_primitive"
TARGET_COMPONENT_MODEL = "TORNOS-850-4"


def upgrade() -> None:
    bind = op.get_bind()

    source = bind.execute(
        sa.text(
            "SELECT id, anchors, asset_type, file_path, source, source_url, "
            "       unit, scale_factor "
            "  FROM assets_3d "
            " WHERE name = :n"
        ),
        {"n": SOURCE_ASSET_NAME},
    ).first()
    if source is None:
        return

    component_row = bind.execute(
        sa.text(
            "SELECT id, asset_3d_id FROM components "
            " WHERE model = :m AND component_type = 'isolator'"
        ),
        {"m": TARGET_COMPONENT_MODEL},
    ).first()
    if component_row is None:
        return

    existing_new = bind.execute(
        sa.text("SELECT id FROM assets_3d WHERE name = :n"),
        {"n": NEW_ASSET_NAME},
    ).first()

    if existing_new is None:
        new_asset_id = bind.execute(
            sa.text(
                """
                INSERT INTO assets_3d (
                    name, anchors, asset_type, file_path, source,
                    source_url, unit, scale_factor
                ) VALUES (
                    :name, CAST(:anchors AS JSONB), :asset_type,
                    :file_path, :source, :source_url, :unit,
                    :scale_factor
                )
                RETURNING id
                """
            ),
            {
                "name": NEW_ASSET_NAME,
                "anchors": json.dumps(list(source.anchors or [])),
                "asset_type": source.asset_type,
                "file_path": source.file_path,
                "source": source.source,
                "source_url": source.source_url,
                "unit": source.unit,
                "scale_factor": source.scale_factor,
            },
        ).scalar_one()
    else:
        new_asset_id = existing_new.id

    if component_row.asset_3d_id != new_asset_id:
        bind.execute(
            sa.text("UPDATE components SET asset_3d_id = :a WHERE id = :c"),
            {"a": new_asset_id, "c": component_row.id},
        )


def downgrade() -> None:
    bind = op.get_bind()
    source = bind.execute(
        sa.text("SELECT id FROM assets_3d WHERE name = :n"),
        {"n": SOURCE_ASSET_NAME},
    ).first()
    if source is None:
        return

    new_asset = bind.execute(
        sa.text("SELECT id FROM assets_3d WHERE name = :n"),
        {"n": NEW_ASSET_NAME},
    ).first()
    if new_asset is None:
        return

    bind.execute(
        sa.text(
            "UPDATE components SET asset_3d_id = :a "
            " WHERE model = :m AND component_type = 'isolator'"
        ),
        {"a": source.id, "m": TARGET_COMPONENT_MODEL},
    )

    referrers = bind.execute(
        sa.text("SELECT COUNT(*) FROM components WHERE asset_3d_id = :a"),
        {"a": new_asset.id},
    ).scalar_one()
    if referrers == 0:
        bind.execute(
            sa.text("DELETE FROM assets_3d WHERE id = :a"),
            {"a": new_asset.id},
        )
