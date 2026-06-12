"""Thin connector Components — one per 0115 connector Asset3D (plan §5.1).

Gives each of the 9 connectors a catalog Component (single root binding →
its Asset3D) so it appears in the catalog and is PHY-editable standalone,
and so the cable binding trees (a later migration) + per-instance connector
swaps can reference it. Purely additive — creates no scene objects and
touches no existing rows.

Matches the established thin-Component shape (alembic 0062 backfill): a
``components`` row + one ``component_bindings`` row with
``parent_binding_id IS NULL, target_kind='asset'``. Idempotent: skips a
connector whose Component already exists (by catalog_id).

Revision ID: 0116_connector_components
Revises: 0115_connector_assets
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op


revision = "0116_connector_components"
down_revision = "0115_connector_assets"
branch_labels = None
depends_on = None


# (asset/component catalog_id, kind_id, brand, model)
_CONNECTORS = [
    ("fiber_connector_apc_pm", "fiber_connector", "Thorlabs", "30126A9"),
    ("fiber_connector_pc_pm", "fiber_connector", "Thorlabs", "30126A9"),
    ("fiber_connector_apc_sm", "fiber_connector", "Thorlabs", "30126A9"),
    ("fiber_connector_pc_sm", "fiber_connector", "Thorlabs", "30126A9"),
    ("fiber_connector_pc_mm", "fiber_connector", "Thorlabs", "30126A9"),
    ("rf_connector_sma_male", "rf_cable_connector", None, None),
    ("rf_connector_sma_female", "rf_cable_connector", None, None),
    ("rf_connector_bnc_male", "rf_cable_connector", None, None),
    ("rf_connector_bnc_female", "rf_cable_connector", None, None),
]


def upgrade() -> None:
    conn = op.get_bind()
    for slug, kind_id, brand, model in _CONNECTORS:
        asset = conn.execute(
            sa.text("SELECT id, name FROM assets_3d WHERE catalog_id = :s"),
            {"s": slug},
        ).first()
        if asset is None:
            # 0115 should have seeded it; skip defensively rather than fail.
            continue
        asset_id, asset_name = asset

        comp = conn.execute(
            sa.text("SELECT id FROM components WHERE catalog_id = :s"),
            {"s": slug},
        ).first()
        if comp is None:
            comp_id = conn.execute(
                sa.text(
                    "INSERT INTO components ("
                    " name, kind_id, brand, model, catalog_id, asset_3d_id, properties"
                    ") VALUES ("
                    " :n, :k, :b, :m, :s, :aid, '{}'::jsonb"
                    ") RETURNING id"
                ),
                {"n": asset_name, "k": kind_id, "b": brand, "m": model,
                 "s": slug, "aid": asset_id},
            ).scalar_one()
        else:
            comp_id = comp[0]

        has_root = conn.execute(
            sa.text(
                "SELECT 1 FROM component_bindings "
                "WHERE component_id = :c AND parent_binding_id IS NULL"
            ),
            {"c": comp_id},
        ).first()
        if has_root is None:
            conn.execute(
                sa.text(
                    "INSERT INTO component_bindings ("
                    " component_id, parent_binding_id, target_kind, asset_3d_id, role"
                    ") VALUES (:c, NULL, 'asset', :aid, 'body')"
                ),
                {"c": comp_id, "aid": asset_id},
            )


def downgrade() -> None:
    # Deleting the component cascades to its component_bindings
    # (component_id FK is ON DELETE CASCADE).
    slugs = [c[0] for c in _CONNECTORS]
    in_list = ", ".join(f"'{s}'" for s in slugs)
    op.get_bind().execute(
        sa.text(f"DELETE FROM components WHERE catalog_id IN ({in_list})")
    )
