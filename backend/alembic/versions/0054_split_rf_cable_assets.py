"""split shared rf_cable Asset3D into per-component rows

Revision ID: 0054_split_rf_cable_assets
Revises: 0053_collection_templates

Before this migration, three rf_cable components — Thorlabs CA2906
(``thorlabs_ca2906_sma_cable``), the generic SMA→BNC adapter
(``rf_cable_sma_to_bnc``), and the generic BNC↔BNC (``rf_cable_bnc_to_bnc``)
— all pointed at the same procedural Asset3D row
(``primitive_thorlabs_ca2906_cable``). Anchors live on Asset3D, so the PHY
Editor's "save rf_in / rf_out positions" path wrote into the shared row
and every component instantly inherited the same values — editing the
BNC cable's connectors clobbered the SMA cable's, and vice versa, which
manifested as "anchors revert to the previous cable's values" when the
user came back.

This migration creates two NEW Asset3D rows (``primitive_rf_cable_sma_to_bnc``
and ``primitive_rf_cable_bnc_to_bnc``) by cloning ``primitive_thorlabs_ca2906_cable``
verbatim (anchors + everything), then re-points the two BNC variant
components at their dedicated asset. CA2906 stays on the original row.
After this, each cable component owns its own anchor geometry and PHY
Editor saves are scoped to one component family at a time.

Idempotent. If the new asset rows already exist (rerun, or someone hand-
created them), we skip creation and just fix up the component
``asset_3d_id`` pointer.

Downgrade
---------
Repoints the two BNC variant components back at ``primitive_thorlabs_ca2906_cable``
and deletes the two split assets — but only if they have NO objects
referencing them via scene_objects (downstream of components, but a
defensive check). Destructive of user-edited per-cable anchors; only run
in dev.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0054_split_rf_cable_assets"
down_revision = "0053_collection_templates"
branch_labels = None
depends_on = None


SOURCE_ASSET_NAME = "primitive_thorlabs_ca2906_cable"

# Component.model → new Asset3D.name. We match by `model` rather than
# `name` because (a) the seed script's `name` ("rf_cable_sma_to_bnc")
# differs from the user-facing display string the UI shows, and (b) we
# observed at least one DB where `name` had been overwritten to the
# model string anyway. `model` is the brand-specified label that's
# stable across UI renames.
SPLIT_TARGETS: dict[str, str] = {
    "SMA to BNC cable": "primitive_rf_cable_sma_to_bnc",
    "BNC cable": "primitive_rf_cable_bnc_to_bnc",
}


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
        # Fresh DB that never ran the legacy upsert — nothing to split.
        return

    for component_model, new_asset_name in SPLIT_TARGETS.items():
        component_row = bind.execute(
            sa.text(
                "SELECT id, asset_3d_id FROM components "
                " WHERE model = :m AND component_type = 'rf_cable'"
            ),
            {"m": component_model},
        ).first()
        if component_row is None:
            # Catalog entry hasn't been seeded yet (upsert_bnc_rf_cables.py
            # never ran). Skip silently; next seed run will create the
            # component pointing at the right per-component asset
            # because the upsert script is being updated in parallel.
            continue

        existing_new = bind.execute(
            sa.text("SELECT id FROM assets_3d WHERE name = :n"),
            {"n": new_asset_name},
        ).first()

        if existing_new is None:
            # Clone the source asset row verbatim. Anchors are a JSONB
            # array; round-trip via json.dumps to satisfy the bind layer.
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
                    "name": new_asset_name,
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
                sa.text(
                    "UPDATE components SET asset_3d_id = :a WHERE id = :c"
                ),
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

    for component_model, new_asset_name in SPLIT_TARGETS.items():
        new_asset = bind.execute(
            sa.text("SELECT id FROM assets_3d WHERE name = :n"),
            {"n": new_asset_name},
        ).first()
        if new_asset is None:
            continue

        # Repoint the component back at the shared CA2906 asset before
        # deleting the per-cable asset row (FK from components.asset_3d_id).
        bind.execute(
            sa.text(
                "UPDATE components SET asset_3d_id = :a "
                " WHERE model = :m AND component_type = 'rf_cable'"
            ),
            {"a": source.id, "m": component_model},
        )

        # Only delete the new asset if nothing else references it. The
        # components FK is the main consumer; objects don't carry
        # asset_3d_id (they reach via component). Defensive count to
        # avoid breaking downstream rows in customised dev DBs.
        referrers = bind.execute(
            sa.text(
                "SELECT COUNT(*) FROM components WHERE asset_3d_id = :a"
            ),
            {"a": new_asset.id},
        ).scalar_one()
        if referrers == 0:
            bind.execute(
                sa.text("DELETE FROM assets_3d WHERE id = :a"),
                {"a": new_asset.id},
            )
