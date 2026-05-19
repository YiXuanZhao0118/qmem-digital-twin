"""IO-3D-850-VLP + IO-5-850-VLP: 5-part binding tree + viewerHints.bundledOverlay=false

Revision ID: 0068_io_vlp_binding_tree
Revises: 0067_tornos_body_asset

Stage A''.9 — migrates the two VLP-suffix Thorlabs isolator models
to the binding tree. Same shape as TORNOS (root body + 2 empty
Mounts + 2 PBS sub-Components), but the body is the existing
real-STL Asset3D, not the procedural cylinder builder.

For both IO-3D-850-VLP and IO-5-850-VLP:

  1. Set the STL Asset3D's ``properties.viewerHints.bundledOverlay
     = false`` so the legacy ``buildThorlabsIsolatorObject`` path
     (still active for the housing geometry load) skips its bundled
     PBS overlay. The binding tree's PBS sub-Components handle PBS
     rendering instead, avoiding a double-render.
  2. Insert the 5-part binding tree using the model-specific PBS
     pose-table values copied from
     ``frontend/src/kinds/isolator/pbsOverlay.ts::ISOLATOR_PBS_DEFAULTS_BY_MODEL``
     so the binding-tree PBS positions land at the same world
     coords as the legacy overlay used to.

Pose values used::

  IO-3D-850-VLP: front_pbs (0, 4, 0)  ry=0;  back_pbs (0, 27, 0) ry=90
  IO-5-850-VLP:  front_pbs (0, 5, 0)  ry=0;  back_pbs (0, 60, 0) ry=90

Both PBSs are standard cement-bonded PBS cubes → PBS252 Component.
HP-suffix variants (Glan-Laser) come in A''.11 with their own
glan_polarizer_calcite Component template.

Idempotent — checks for existing empty-Mount bindings before
restructuring.

Downgrade
---------
Mirrors A''.7's downgrade: flatten Mount + PBS back to direct PBS
children of root (restoring tunable_axes onto PBS bindings) and
clear the viewerHints.bundledOverlay flag.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0068_io_vlp_binding_tree"
down_revision = "0067_tornos_body_asset"
branch_labels = None
depends_on = None


PBS_COMPONENT_NAME = "PBS252"

# (model, front_pos_mm, front_ry_deg, back_pos_mm, back_ry_deg)
# Pose values mirror pbsOverlay's ISOLATOR_PBS_DEFAULTS_BY_MODEL
# verbatim — visual equivalence test.
VLP_MODELS: list[tuple[str, tuple[float, float, float], float, tuple[float, float, float], float]] = [
    ("IO-3D-850-VLP", (0.0, 4.0, 0.0), 0.0,  (0.0, 27.0, 0.0), 90.0),
    ("IO-5-850-VLP",  (0.0, 5.0, 0.0), 0.0,  (0.0, 60.0, 0.0), 90.0),
]

# Tunable rotation window for each Mount — same as TORNOS in A''.7.
TUNABLE_RY_AXIS = {
    "frame": "parent",
    "min": -90.0,
    "max": 90.0,
    "default": 0.0,
}


def _migrate_one_model(
    bind,
    model: str,
    front_pos: tuple[float, float, float],
    front_ry: float,
    back_pos: tuple[float, float, float],
    back_ry: float,
    pbs_id,
) -> None:
    comp = bind.execute(
        sa.text(
            "SELECT id, asset_3d_id FROM components "
            " WHERE model = :m AND archived_at IS NULL "
            " ORDER BY created_at ASC LIMIT 1"
        ),
        {"m": model},
    ).first()
    if comp is None or comp.asset_3d_id is None:
        return

    # 1. Flag the asset so the legacy overlay path skips its PBS bundle.
    #    Nested jsonb_set materialises the intermediate viewerHints
    #    object before setting the nested key — single-level
    #    jsonb_set's create_missing flag only autocreates the FINAL
    #    key, not intermediates (fixed forward in 0069 for an earlier
    #    iteration of this migration that hit the same gotcha).
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

    # 2. Idempotency: skip restructure if Mount already there.
    mount_exists = bind.execute(
        sa.text(
            "SELECT 1 FROM component_bindings "
            " WHERE component_id = :c AND target_kind = 'empty' LIMIT 1"
        ),
        {"c": comp.id},
    ).first()
    if mount_exists is not None:
        return

    root_id = bind.execute(
        sa.text(
            "SELECT id FROM component_bindings "
            " WHERE component_id = :c AND parent_binding_id IS NULL "
            " ORDER BY sort_order ASC, created_at ASC LIMIT 1"
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
        # Mount binding (empty target, carries pose + tunable).
        mount_id = bind.execute(
            sa.text(
                """
                INSERT INTO component_bindings (
                    component_id, parent_binding_id, target_kind,
                    role, local_x_mm, local_y_mm, local_z_mm,
                    local_rx_deg, local_ry_deg, local_rz_deg,
                    tunable_axes, sort_order, properties
                ) VALUES (
                    :c, :root, 'empty',
                    'mount', :x, :y, :z,
                    0, :ry, 0,
                    CAST(:tunable AS jsonb), :sort, CAST(:props AS jsonb)
                ) RETURNING id
                """
            ),
            {
                "c": comp.id,
                "root": root_id,
                "x": pos[0],
                "y": pos[1],
                "z": pos[2],
                "ry": ry,
                "tunable": tunable,
                "sort": sort_order,
                "props": json.dumps({"role_label": label}),
            },
        ).scalar_one()

        # PBS sub-Component binding under the Mount (identity local).
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
                    :c, :mount, 'subcomponent',
                    :sub, 'internal_part',
                    0, 0, 0, 0, 0, 0,
                    '{}'::jsonb, 1, CAST(:props AS jsonb)
                )
                """
            ),
            {
                "c": comp.id,
                "mount": mount_id,
                "sub": pbs_id,
                "props": json.dumps(
                    {"role_label": label.replace("_mount", "_pbs")}
                ),
            },
        )


def upgrade() -> None:
    bind = op.get_bind()
    pbs_id = bind.execute(
        sa.text(
            "SELECT id FROM components WHERE name = :n "
            " AND archived_at IS NULL ORDER BY created_at ASC LIMIT 1"
        ),
        {"n": PBS_COMPONENT_NAME},
    ).scalar_one_or_none()
    if pbs_id is None:
        return  # no PBS252 — fresh checkout, skip cleanly

    for model, front_pos, front_ry, back_pos, back_ry in VLP_MODELS:
        _migrate_one_model(
            bind, model, front_pos, front_ry, back_pos, back_ry, pbs_id
        )


def downgrade() -> None:
    bind = op.get_bind()
    for model, *_ in VLP_MODELS:
        comp = bind.execute(
            sa.text(
                "SELECT id, asset_3d_id FROM components WHERE model = :m "
                " ORDER BY created_at ASC LIMIT 1"
            ),
            {"m": model},
        ).first()
        if comp is None:
            continue

        # Flatten: copy each Mount's pose onto its PBS child, then
        # delete the Mount.
        mounts = bind.execute(
            sa.text(
                "SELECT id, local_x_mm, local_y_mm, local_z_mm,"
                "       local_ry_deg, tunable_axes "
                " FROM component_bindings "
                " WHERE component_id = :c AND target_kind = 'empty'"
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
                    "x": m.local_x_mm,
                    "y": m.local_y_mm,
                    "z": m.local_z_mm,
                    "ry": m.local_ry_deg,
                    "tunable": json.dumps(dict(m.tunable_axes)),
                    "mount": m.id,
                },
            )
            bind.execute(
                sa.text("DELETE FROM component_bindings WHERE id = :id"),
                {"id": m.id},
            )

        # Clear viewerHints.bundledOverlay flag.
        if comp.asset_3d_id is not None:
            bind.execute(
                sa.text(
                    """
                    UPDATE assets_3d
                       SET properties = properties #- '{viewerHints,bundledOverlay}'
                     WHERE id = :id
                    """
                ),
                {"id": comp.asset_3d_id},
            )
