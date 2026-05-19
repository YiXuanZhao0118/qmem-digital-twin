"""TORNOS-850-4: switch body asset to procedural builder + insert 5-part tree

Revision ID: 0067_tornos_body_asset
Revises: 0066_binding_empty_target

Stage A''.7 — three data changes that together convert TORNOS-850-4
from "single STL asset + 2 PBS sub-binding children" to the user's
5-part decomposition with empty Mount intermediates:

  1. Create a shared Asset3D row pointing at the new procedural body
     builder (``procedural://isolator_body`` — A''.6's
     ``buildIsolatorBodyObject``). Other isolator models can reuse
     this same asset once they migrate.
  2. Repoint TORNOS-850-4 Component.asset_3d_id + its root binding's
     asset_3d_id to the new asset.
  3. Restructure the binding tree: insert two ``target_kind='empty'``
     Mount bindings as children of the root, and reparent the
     existing PBS bindings to be children of their respective Mount.
     The ``tunable_axes.ry_deg`` rotation migrates from the PBS
     binding to the Mount binding (matching the user's design:
     "Mount rotates relative to body, PBS is rigid to Mount").

Before::

    root (asset=tornos_box_primitive)
    ├─ front_pbs (subcomp=PBS252, z=-13, ry=0,  tunable.ry_deg)
    └─ back_pbs  (subcomp=PBS252, z=+13, ry=90, tunable.ry_deg)

After::

    root (asset=isolator_body_procedural)
    ├─ front_mount (empty, z=-13, ry=0,  tunable.ry_deg)
    │   └─ front_pbs (subcomp=PBS252, identity, no tunable)
    └─ back_mount  (empty, z=+13, ry=90, tunable.ry_deg)
        └─ back_pbs  (subcomp=PBS252, identity, no tunable)

Idempotent — checks for the new asset's existence + the Mount-shape
before doing work.

Downgrade
---------
Mirrors the upgrade: flattens the tree back to direct PBS children
(restoring tunable_axes onto the PBS bindings), deletes the Mount
bindings, repoints TORNOS back to the old primitive box asset, and
leaves the new procedural asset in place (other consumers may
already reference it).
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0067_tornos_body_asset"
down_revision = "0066_binding_empty_target"
branch_labels = None
depends_on = None


TORNOS_MODEL = "TORNOS-850-4"
NEW_ASSET_NAME = "isolator_body_procedural"
NEW_ASSET_FILEPATH = "procedural://isolator_body"
LEGACY_ASSET_NAME = "coherent_tornos_850_4_primitive"


def upgrade() -> None:
    bind = op.get_bind()

    # --- 1. Ensure the new procedural body Asset3D exists -----------------
    new_asset_id = bind.execute(
        sa.text("SELECT id FROM assets_3d WHERE name = :n LIMIT 1"),
        {"n": NEW_ASSET_NAME},
    ).scalar_one_or_none()
    if new_asset_id is None:
        new_asset_id = bind.execute(
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
            {"n": NEW_ASSET_NAME, "fp": NEW_ASSET_FILEPATH},
        ).scalar_one()

    # --- 2. Find TORNOS-850-4 Component -----------------------------------
    tornos_id = bind.execute(
        sa.text(
            "SELECT id FROM components "
            " WHERE model = :m AND archived_at IS NULL "
            " ORDER BY created_at ASC LIMIT 1"
        ),
        {"m": TORNOS_MODEL},
    ).scalar_one_or_none()
    if tornos_id is None:
        return  # no TORNOS in this DB (fresh checkout)

    # --- 3. Repoint Component.asset_3d_id + root binding ------------------
    bind.execute(
        sa.text("UPDATE components SET asset_3d_id = :a WHERE id = :c"),
        {"a": new_asset_id, "c": tornos_id},
    )
    bind.execute(
        sa.text(
            "UPDATE component_bindings SET asset_3d_id = :a "
            " WHERE component_id = :c "
            "   AND parent_binding_id IS NULL "
            "   AND target_kind = 'asset'"
        ),
        {"a": new_asset_id, "c": tornos_id},
    )

    # --- 4. Idempotency: skip restructuring if Mount bindings exist -------
    mount_exists = bind.execute(
        sa.text(
            "SELECT 1 FROM component_bindings "
            " WHERE component_id = :c AND target_kind = 'empty' "
            " LIMIT 1"
        ),
        {"c": tornos_id},
    ).first()
    if mount_exists is not None:
        return  # already migrated to 5-part shape

    root_id = bind.execute(
        sa.text(
            "SELECT id FROM component_bindings "
            " WHERE component_id = :c AND parent_binding_id IS NULL "
            " ORDER BY sort_order ASC, created_at ASC LIMIT 1"
        ),
        {"c": tornos_id},
    ).scalar_one_or_none()
    if root_id is None:
        return

    # --- 5. Insert Mount intermediates + reparent PBS bindings -----------
    pbs_bindings = bind.execute(
        sa.text(
            "SELECT id, local_z_mm, local_ry_deg, tunable_axes, sort_order "
            " FROM component_bindings "
            " WHERE component_id = :c AND target_kind = 'subcomponent' "
            "   AND parent_binding_id = :root "
            " ORDER BY sort_order ASC"
        ),
        {"c": tornos_id, "root": root_id},
    ).fetchall()

    for index, pbs in enumerate(pbs_bindings):
        label = "front_mount" if index == 0 else "back_mount"
        # Mount binding carries the PBS's old position + rotation +
        # tunable_axes. Becomes the rotating frame the PBS lives in.
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
                    'mount', 0, 0, :z,
                    0, :ry, 0,
                    CAST(:tunable AS jsonb), :sort, CAST(:props AS jsonb)
                ) RETURNING id
                """
            ),
            {
                "c": tornos_id,
                "root": root_id,
                "z": pbs.local_z_mm,
                "ry": pbs.local_ry_deg,
                "tunable": json.dumps(dict(pbs.tunable_axes)),
                "sort": pbs.sort_order,
                "props": json.dumps({"role_label": label}),
            },
        ).scalar_one()

        # Flatten the PBS binding: identity transform, no tunable,
        # reparent under its Mount.
        bind.execute(
            sa.text(
                """
                UPDATE component_bindings
                   SET parent_binding_id = :mount,
                       local_x_mm = 0, local_y_mm = 0, local_z_mm = 0,
                       local_rx_deg = 0, local_ry_deg = 0, local_rz_deg = 0,
                       tunable_axes = '{}'::jsonb
                 WHERE id = :id
                """
            ),
            {"mount": mount_id, "id": pbs.id},
        )


def downgrade() -> None:
    bind = op.get_bind()

    tornos_id = bind.execute(
        sa.text("SELECT id FROM components WHERE model = :m LIMIT 1"),
        {"m": TORNOS_MODEL},
    ).scalar_one_or_none()
    if tornos_id is None:
        return

    # Flatten back: copy each Mount's (z, ry, tunable_axes) onto its
    # PBS child, then delete the Mount.
    mounts = bind.execute(
        sa.text(
            "SELECT id, local_z_mm, local_ry_deg, tunable_axes "
            " FROM component_bindings "
            " WHERE component_id = :c AND target_kind = 'empty'"
        ),
        {"c": tornos_id},
    ).fetchall()
    root_id = bind.execute(
        sa.text(
            "SELECT id FROM component_bindings "
            " WHERE component_id = :c AND parent_binding_id IS NULL LIMIT 1"
        ),
        {"c": tornos_id},
    ).scalar_one_or_none()
    for mount in mounts:
        bind.execute(
            sa.text(
                """
                UPDATE component_bindings
                   SET parent_binding_id = :root,
                       local_z_mm = :z, local_ry_deg = :ry,
                       tunable_axes = CAST(:tunable AS jsonb)
                 WHERE parent_binding_id = :mount
                """
            ),
            {
                "root": root_id,
                "z": mount.local_z_mm,
                "ry": mount.local_ry_deg,
                "tunable": json.dumps(dict(mount.tunable_axes)),
                "mount": mount.id,
            },
        )
        bind.execute(
            sa.text("DELETE FROM component_bindings WHERE id = :id"),
            {"id": mount.id},
        )

    # Repoint TORNOS back to the old primitive asset (if still around).
    legacy_id = bind.execute(
        sa.text("SELECT id FROM assets_3d WHERE name = :n LIMIT 1"),
        {"n": LEGACY_ASSET_NAME},
    ).scalar_one_or_none()
    if legacy_id is not None:
        bind.execute(
            sa.text("UPDATE components SET asset_3d_id = :a WHERE id = :c"),
            {"a": legacy_id, "c": tornos_id},
        )
        bind.execute(
            sa.text(
                "UPDATE component_bindings SET asset_3d_id = :a "
                " WHERE component_id = :c AND parent_binding_id IS NULL "
                "   AND target_kind = 'asset'"
            ),
            {"a": legacy_id, "c": tornos_id},
        )
