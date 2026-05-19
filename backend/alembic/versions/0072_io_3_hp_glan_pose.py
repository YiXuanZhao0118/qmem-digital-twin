"""IO-3-850-HP: lock in user-saved Glan-Laser pose (front + back)

Revision ID: 0072_io_3_hp_glan_pose
Revises: 0071_hp_glan_laser_bindings

User authored the IO-3-850-HP Glan-Laser pose via IsolatorDevPage
(3-axis Euler editor, Stage A''.11-followup). This migration writes
the same values into the Mount binding rows so the Lab viewer's
binding-tree render path matches the DevPage preview + the source
pose table.

Values (body-local Z-up mm + XYZ Euler degrees, copied verbatim
from the DevPage on 2026-05-19)::

  front_mount: pos=(0, 11, 0)  rotDeg=(0, 270, 0)
  back_mount:  pos=(0, 84, 0)  rotDeg=(0, 225, 0)

The Mount binding's tunable_axes.ry_deg slot stays open (user can
still fine-tune per-instance via SceneObject.properties.bindingOverrides).

Idempotent — uses UPDATE keyed on the role_label property stamped
when the Mount was created by A''.11.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op


revision = "0072_io_3_hp_glan_pose"
down_revision = "0071_hp_glan_laser_bindings"
branch_labels = None
depends_on = None


TARGET_MODEL = "IO-3-850-HP"

# (role_label, x, y, z, rx, ry, rz)
NEW_POSES: list[tuple[str, float, float, float, float, float, float]] = [
    ("front_mount", 0.0, 11.0, 0.0, 0.0, 270.0, 0.0),
    ("back_mount",  0.0, 84.0, 0.0, 0.0, 225.0, 0.0),
]

# Previous values from A''.11 — used by downgrade to restore the
# original 0071 state.
OLD_POSES: list[tuple[str, float, float, float, float, float, float]] = [
    ("front_mount", 0.0, 70.0, +13.0, 0.0, 135.0, 0.0),
    ("back_mount",  0.0,  0.0, +13.0, 0.0,   0.0, 0.0),
]


def _apply_poses(
    bind,
    model: str,
    poses: list[tuple[str, float, float, float, float, float, float]],
) -> None:
    comp_id = bind.execute(
        sa.text(
            "SELECT id FROM components WHERE model = :m "
            " AND archived_at IS NULL ORDER BY created_at ASC LIMIT 1"
        ),
        {"m": model},
    ).scalar_one_or_none()
    if comp_id is None:
        return
    for label, x, y, z, rx, ry, rz in poses:
        bind.execute(
            sa.text(
                """
                UPDATE component_bindings
                   SET local_x_mm = :x, local_y_mm = :y, local_z_mm = :z,
                       local_rx_deg = :rx, local_ry_deg = :ry, local_rz_deg = :rz
                 WHERE component_id = :cid
                   AND target_kind = 'empty'
                   AND properties->>'role_label' = :label
                """
            ),
            {
                "cid": comp_id, "label": label,
                "x": x, "y": y, "z": z,
                "rx": rx, "ry": ry, "rz": rz,
            },
        )


def upgrade() -> None:
    _apply_poses(op.get_bind(), TARGET_MODEL, NEW_POSES)


def downgrade() -> None:
    _apply_poses(op.get_bind(), TARGET_MODEL, OLD_POSES)
