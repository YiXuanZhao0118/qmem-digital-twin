"""IO-3-850-HP + IO-5-850-HP: 5-part binding tree with Glan-Laser sub-Components

Revision ID: 0071_hp_glan_laser_bindings
Revises: 0070_migrate_isolator_deletions

Stage A''.11 — high-power isolator migration. Mirrors A''.9's VLP
work but the polariser sub-Component is Glan-Laser (calcite prism,
glan_polarizer kind) instead of PBS252 (cube).

Creates the Glan-Laser catalog entries if missing:

  1. Asset3D ``glan_polarizer_calcite_prism``, filePath
     ``procedural://glan_polarizer_prism`` (A''.11-prep's procedural
     builder). Shared across HP isolator models that use it.
  2. Component ``GlanLaserCalcitePrism``, componentType
     ``glan_polarizer`` (A''.3's plugin), asset_3d_id pointing at
     the above. Becomes the sub-Component the HP isolators reference.

Then for each HP model (IO-3-850-HP, IO-5-850-HP):
  - Set asset.properties.viewerHints.bundledOverlay=false on the
    STL housing (same flag the VLPs use, suppresses the legacy
    PBS-overlay path's calcite prism bundle).
  - Insert the 5-part binding tree using HP pose values from
    pbsOverlay::ISOLATOR_PBS_DEFAULTS_BY_MODEL.

HP pose values::

  IO-3-850-HP: front (0, 70, +13) ry=135;  back (0,  0, +13) ry=0
  IO-5-850-HP: front (0,  0, -18) ry=0;    back (0,  0, +18) ry=90

Note on rotation
----------------
pbsOverlay's Glan-Laser variant composes a -90°-around-three.X
optical-axis alignment with a yRotation around the optical axis.
The binding tree's local_*_deg values can express the y-rotation
directly (ry_deg) but the -90° alignment will need to live in the
glan_polarizer Component's body frame conventions instead — once
the procedural builder is used in earnest a follow-up may need to
adjust the prism's native orientation so this isn't required at
binding-tree time.

Idempotent — skips per-Component if Mount already exists.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0071_hp_glan_laser_bindings"
down_revision = "0070_migrate_isolator_deletions"
branch_labels = None
depends_on = None


GLAN_ASSET_NAME = "glan_polarizer_calcite_prism"
GLAN_ASSET_FILEPATH = "procedural://glan_polarizer_prism"
GLAN_COMPONENT_NAME = "GlanLaserCalcitePrism"

HP_MODELS: list[tuple[str, tuple[float, float, float], float, tuple[float, float, float], float]] = [
    ("IO-3-850-HP", (0.0, 70.0, +13.0), 135.0, (0.0,  0.0, +13.0),   0.0),
    ("IO-5-850-HP", (0.0,  0.0, -18.0),   0.0, (0.0,  0.0, +18.0),  90.0),
]

TUNABLE_RY_AXIS = {
    "frame": "parent",
    "min": -90.0,
    "max": 90.0,
    "default": 0.0,
}


def upgrade() -> None:
    bind = op.get_bind()

    # --- 1. Ensure Glan-Laser Asset3D exists ------------------------------
    glan_asset_id = bind.execute(
        sa.text("SELECT id FROM assets_3d WHERE name = :n LIMIT 1"),
        {"n": GLAN_ASSET_NAME},
    ).scalar_one_or_none()
    if glan_asset_id is None:
        glan_asset_id = bind.execute(
            sa.text(
                """
                INSERT INTO assets_3d (
                    name, asset_type, file_path, unit, scale_factor,
                    anchors, properties
                ) VALUES (
                    :n, 'procedural', :fp, 'mm', 1.0,
                    '[]'::jsonb, '{}'::jsonb
                ) RETURNING id
                """
            ),
            {"n": GLAN_ASSET_NAME, "fp": GLAN_ASSET_FILEPATH},
        ).scalar_one()

    # --- 2. Ensure Glan-Laser Component template exists -------------------
    glan_comp_id = bind.execute(
        sa.text("SELECT id FROM components WHERE name = :n LIMIT 1"),
        {"n": GLAN_COMPONENT_NAME},
    ).scalar_one_or_none()
    if glan_comp_id is None:
        glan_comp_id = bind.execute(
            sa.text(
                """
                INSERT INTO components (
                    name, component_type, brand, model, asset_3d_id,
                    properties, physics_capabilities, status
                ) VALUES (
                    :n, 'glan_polarizer', 'Generic', NULL, :a,
                    '{}'::jsonb, '["optical"]'::jsonb, 'active'
                ) RETURNING id
                """
            ),
            {"n": GLAN_COMPONENT_NAME, "a": glan_asset_id},
        ).scalar_one()
        # Backfill a root binding for the new Component so it follows
        # the same shape as the 0062-backfilled rows.
        bind.execute(
            sa.text(
                """
                INSERT INTO component_bindings (
                    component_id, parent_binding_id, target_kind,
                    asset_3d_id, role, sort_order, properties
                ) VALUES (
                    :c, NULL, 'asset', :a, 'body', 0, '{}'::jsonb
                )
                """
            ),
            {"c": glan_comp_id, "a": glan_asset_id},
        )

    # --- 3. For each HP model: viewerHints.bundledOverlay + binding tree -
    for model, front_pos, front_ry, back_pos, back_ry in HP_MODELS:
        _migrate_one_model(
            bind, model, front_pos, front_ry, back_pos, back_ry, glan_comp_id
        )


def _migrate_one_model(
    bind,
    model: str,
    front_pos: tuple[float, float, float],
    front_ry: float,
    back_pos: tuple[float, float, float],
    back_ry: float,
    glan_comp_id,
) -> None:
    comp = bind.execute(
        sa.text(
            "SELECT id, asset_3d_id FROM components WHERE model = :m "
            " AND archived_at IS NULL ORDER BY created_at ASC LIMIT 1"
        ),
        {"m": model},
    ).first()
    if comp is None or comp.asset_3d_id is None:
        return

    # Set viewerHints.bundledOverlay=false (nested jsonb_set per A''.9 lesson).
    bind.execute(
        sa.text(
            """
            UPDATE assets_3d
               SET properties = jsonb_set(
                     jsonb_set(
                       COALESCE(properties, '{}'::jsonb),
                       '{viewerHints}',
                       COALESCE(properties->'viewerHints', '{}'::jsonb),
                       true
                     ),
                     '{viewerHints,bundledOverlay}',
                     'false'::jsonb,
                     true
                   )
             WHERE id = :id
            """
        ),
        {"id": comp.asset_3d_id},
    )

    # Idempotency.
    mount_exists = bind.execute(
        sa.text(
            "SELECT 1 FROM component_bindings WHERE component_id = :c "
            " AND target_kind = 'empty' LIMIT 1"
        ),
        {"c": comp.id},
    ).first()
    if mount_exists is not None:
        return

    root_id = bind.execute(
        sa.text(
            "SELECT id FROM component_bindings WHERE component_id = :c "
            " AND parent_binding_id IS NULL ORDER BY sort_order ASC LIMIT 1"
        ),
        {"c": comp.id},
    ).scalar_one_or_none()
    if root_id is None:
        return

    tunable = json.dumps({"ry_deg": TUNABLE_RY_AXIS})

    for sort_order, (label, pos, ry) in enumerate(
        (
            ("front_mount", front_pos, front_ry),
            ("back_mount", back_pos, back_ry),
        ),
        start=1,
    ):
        mount_id = bind.execute(
            sa.text(
                """
                INSERT INTO component_bindings (
                    component_id, parent_binding_id, target_kind,
                    role, local_x_mm, local_y_mm, local_z_mm,
                    local_rx_deg, local_ry_deg, local_rz_deg,
                    tunable_axes, sort_order, properties
                ) VALUES (
                    :c, :root, 'empty', 'mount',
                    :x, :y, :z, 0, :ry, 0,
                    CAST(:tunable AS jsonb), :sort, CAST(:props AS jsonb)
                ) RETURNING id
                """
            ),
            {
                "c": comp.id, "root": root_id,
                "x": pos[0], "y": pos[1], "z": pos[2], "ry": ry,
                "tunable": tunable, "sort": sort_order,
                "props": json.dumps({"role_label": label}),
            },
        ).scalar_one()
        bind.execute(
            sa.text(
                """
                INSERT INTO component_bindings (
                    component_id, parent_binding_id, target_kind,
                    sub_component_id, role,
                    local_x_mm, local_y_mm, local_z_mm,
                    local_rx_deg, local_ry_deg, local_rz_deg,
                    tunable_axes, sort_order, properties
                ) VALUES (
                    :c, :mount, 'subcomponent', :sub,
                    'internal_part', 0, 0, 0, 0, 0, 0,
                    '{}'::jsonb, 1, CAST(:props AS jsonb)
                )
                """
            ),
            {
                "c": comp.id, "mount": mount_id, "sub": glan_comp_id,
                "props": json.dumps(
                    {"role_label": label.replace("_mount", "_glan_laser")}
                ),
            },
        )


def downgrade() -> None:
    bind = op.get_bind()
    for model, *_ in HP_MODELS:
        comp = bind.execute(
            sa.text(
                "SELECT id, asset_3d_id FROM components WHERE model = :m "
                " ORDER BY created_at ASC LIMIT 1"
            ),
            {"m": model},
        ).first()
        if comp is None:
            continue
        # Same flatten pattern as A''.9's downgrade.
        mounts = bind.execute(
            sa.text(
                "SELECT id, local_x_mm, local_y_mm, local_z_mm, local_ry_deg,"
                "       tunable_axes "
                " FROM component_bindings WHERE component_id = :c "
                "   AND target_kind = 'empty'"
            ),
            {"c": comp.id},
        ).fetchall()
        root_id = bind.execute(
            sa.text(
                "SELECT id FROM component_bindings WHERE component_id = :c "
                " AND parent_binding_id IS NULL LIMIT 1"
            ),
            {"c": comp.id},
        ).scalar_one_or_none()
        for m in mounts:
            bind.execute(
                sa.text(
                    """
                    UPDATE component_bindings
                       SET parent_binding_id = :root,
                           local_x_mm = :x, local_y_mm = :y, local_z_mm = :z,
                           local_ry_deg = :ry,
                           tunable_axes = CAST(:tunable AS jsonb)
                     WHERE parent_binding_id = :mount
                    """
                ),
                {
                    "root": root_id,
                    "x": m.local_x_mm, "y": m.local_y_mm, "z": m.local_z_mm,
                    "ry": m.local_ry_deg,
                    "tunable": json.dumps(dict(m.tunable_axes)),
                    "mount": m.id,
                },
            )
            bind.execute(
                sa.text("DELETE FROM component_bindings WHERE id = :id"),
                {"id": m.id},
            )
        if comp.asset_3d_id is not None:
            bind.execute(
                sa.text(
                    "UPDATE assets_3d "
                    "   SET properties = properties #- '{viewerHints,bundledOverlay}'"
                    " WHERE id = :id"
                ),
                {"id": comp.asset_3d_id},
            )
    # Leave the Glan-Laser Asset3D + Component in place — other migrations
    # may have referenced them.
