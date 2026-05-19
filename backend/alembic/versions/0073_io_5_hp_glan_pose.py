"""IO-5-850-HP: lock Glan-Laser pose to match IO-3-850-HP

Revision ID: 0073_io_5_hp_glan_pose
Revises: 0072_io_3_hp_glan_pose

User asked for the same Glan-Laser pose as IO-3-850-HP (same chassis
family). Mirrors A''.11.followup-0072's UPDATE but targets the
IO-5-850-HP Mount bindings instead.

Values::

  front_mount: pos=(0, 11, 0)  rotDeg=(0, 270, 0)
  back_mount:  pos=(0, 84, 0)  rotDeg=(0, 225, 0)

Idempotent (keyed on properties->>'role_label'). Downgrade restores
the original 0071 IO-5-850-HP values.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op


revision = "0073_io_5_hp_glan_pose"
down_revision = "0072_io_3_hp_glan_pose"
branch_labels = None
depends_on = None


TARGET_MODEL = "IO-5-850-HP"

NEW_POSES: list[tuple[str, float, float, float, float, float, float]] = [
    ("front_mount", 0.0, 11.0, 0.0, 0.0, 270.0, 0.0),
    ("back_mount",  0.0, 84.0, 0.0, 0.0, 225.0, 0.0),
]

# Pre-0073 (A''.11) values for downgrade.
OLD_POSES: list[tuple[str, float, float, float, float, float, float]] = [
    ("front_mount", 0.0,  0.0, -18.0, 0.0,  0.0, 0.0),
    ("back_mount",  0.0,  0.0, +18.0, 0.0, 90.0, 0.0),
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
