"""IO-3-850-HP: flatten empty-Mount intermediate, hang PBS + piece directly under root

Revision ID: 0075_io_3_hp_flatten_mounts
Revises: 0074_io_3_hp_bake_partitions

User asked for the 5-element tree (no Mount layer):

    root (body)
    ├─ front_glan_laser  (subcomp PBS, was under front_mount)
    ├─ front_piece       (asset STL subset, was under front_mount)
    ├─ back_glan_laser   (subcomp PBS, was under back_mount)
    └─ back_piece        (asset STL subset, was under back_mount)

Each of the 5 (root + 4 children) is now independently positionable
via the Bindings panel. The Mount intermediate was useful when PBS
and piece needed to rotate together via a shared tunable_axes; the
user prefers individual control here.

Transformation
--------------
For each Mount binding:
  * Its child bindings get the Mount's local pose copied onto them
    (they were at identity local relative to the Mount, so the
    composition collapses to the Mount's pose).
  * Tunable_axes is copied onto each child so per-instance rotation
    is still possible per-child if the user wants it (independent
    rotation of PBS vs STL piece).
  * Children get reparented to the Mount's parent (the root body
    binding).
  * Mount binding is then deleted.

Visual contract is preserved: every leaf binding (PBS or piece)
lands at the same world position + rotation as before, just one
fewer nesting layer.

Idempotent — skips if no empty-Mount bindings remain.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0075_io_3_hp_flatten_mounts"
down_revision = "0074_io_3_hp_bake_partitions"
branch_labels = None
depends_on = None


TARGET_MODEL = "IO-3-850-HP"


def upgrade() -> None:
    bind = op.get_bind()

    comp_id = bind.execute(
        sa.text(
            "SELECT id FROM components "
            " WHERE model = :m AND archived_at IS NULL "
            " ORDER BY created_at ASC LIMIT 1"
        ),
        {"m": TARGET_MODEL},
    ).scalar_one_or_none()
    if comp_id is None:
        return

    mounts = bind.execute(
        sa.text(
            "SELECT id, parent_binding_id, local_x_mm, local_y_mm, local_z_mm, "
            "       local_rx_deg, local_ry_deg, local_rz_deg, tunable_axes "
            "  FROM component_bindings "
            " WHERE component_id = :cid AND target_kind = 'empty'"
        ),
        {"cid": comp_id},
    ).fetchall()
    if not mounts:
        return  # already flattened

    for m in mounts:
        children = bind.execute(
            sa.text(
                "SELECT id FROM component_bindings "
                " WHERE parent_binding_id = :mid"
            ),
            {"mid": m.id},
        ).fetchall()
        for child in children:
            bind.execute(
                sa.text(
                    """
                    UPDATE component_bindings
                       SET parent_binding_id = :new_parent,
                           local_x_mm   = :x,  local_y_mm   = :y,  local_z_mm   = :z,
                           local_rx_deg = :rx, local_ry_deg = :ry, local_rz_deg = :rz,
                           tunable_axes = CAST(:tun AS jsonb)
                     WHERE id = :id
                    """
                ),
                {
                    "id": child.id,
                    "new_parent": m.parent_binding_id,
                    "x": m.local_x_mm, "y": m.local_y_mm, "z": m.local_z_mm,
                    "rx": m.local_rx_deg, "ry": m.local_ry_deg, "rz": m.local_rz_deg,
                    "tun": json.dumps(dict(m.tunable_axes or {})),
                },
            )
        bind.execute(
            sa.text("DELETE FROM component_bindings WHERE id = :id"),
            {"id": m.id},
        )


def downgrade() -> None:
    # Re-introduces the Mount layer by grouping children by (front_/back_)
    # role_label prefix and inserting an empty Mount binding using the
    # children's common pose (assumes they were flattened from the same
    # Mount, which is the invariant 0075 produced).
    bind = op.get_bind()

    comp_id = bind.execute(
        sa.text(
            "SELECT id FROM components WHERE model = :m "
            " ORDER BY created_at ASC LIMIT 1"
        ),
        {"m": TARGET_MODEL},
    ).scalar_one_or_none()
    if comp_id is None:
        return

    root_id = bind.execute(
        sa.text(
            "SELECT id FROM component_bindings WHERE component_id = :cid "
            " AND parent_binding_id IS NULL LIMIT 1"
        ),
        {"cid": comp_id},
    ).scalar_one_or_none()
    if root_id is None:
        return

    for side in ("front", "back"):
        # All bindings whose role_label starts with this side's prefix.
        rows = bind.execute(
            sa.text(
                "SELECT id, local_x_mm, local_y_mm, local_z_mm, "
                "       local_rx_deg, local_ry_deg, local_rz_deg, tunable_axes "
                "  FROM component_bindings "
                " WHERE component_id = :cid AND parent_binding_id = :root "
                "   AND properties->>'role_label' LIKE :pat"
            ),
            {"cid": comp_id, "root": root_id, "pat": f"{side}_%"},
        ).fetchall()
        if not rows:
            continue
        # Use the first child's pose as the Mount pose (children share
        # the same pose post-flatten by construction).
        ref = rows[0]
        mount_id = bind.execute(
            sa.text(
                """
                INSERT INTO component_bindings (
                    component_id, parent_binding_id, target_kind, role,
                    local_x_mm, local_y_mm, local_z_mm,
                    local_rx_deg, local_ry_deg, local_rz_deg,
                    tunable_axes, sort_order, properties
                ) VALUES (
                    :cid, :root, 'empty', 'mount',
                    :x, :y, :z, :rx, :ry, :rz,
                    CAST(:tun AS jsonb), 1, CAST(:props AS jsonb)
                ) RETURNING id
                """
            ),
            {
                "cid": comp_id, "root": root_id,
                "x": ref.local_x_mm, "y": ref.local_y_mm, "z": ref.local_z_mm,
                "rx": ref.local_rx_deg, "ry": ref.local_ry_deg, "rz": ref.local_rz_deg,
                "tun": json.dumps(dict(ref.tunable_axes or {})),
                "props": json.dumps({"role_label": f"{side}_mount"}),
            },
        ).scalar_one()
        # Reparent every side row under the new Mount, identity local.
        bind.execute(
            sa.text(
                """
                UPDATE component_bindings
                   SET parent_binding_id = :mid,
                       local_x_mm = 0, local_y_mm = 0, local_z_mm = 0,
                       local_rx_deg = 0, local_ry_deg = 0, local_rz_deg = 0,
                       tunable_axes = '{}'::jsonb
                 WHERE id = ANY(:ids)
                """
            ),
            {"mid": mount_id, "ids": [r.id for r in rows]},
        )
