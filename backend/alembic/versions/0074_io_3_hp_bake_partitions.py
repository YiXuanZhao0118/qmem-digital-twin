"""IO-3-850-HP: bake front/back STL partitions into sub-Asset3Ds

Revision ID: 0074_io_3_hp_bake_partitions
Revises: 0073_io_5_hp_glan_pose

User defined the IO-3-850-HP front (~1937 tris) and back (~2174 tris)
partitions via IsolatorDevPage's Ctrl/Alt + drag box-select. This
migration bakes those marks into two new Asset3Ds + binds them
under the matching Mount bindings so the Lab viewer's binding tree
renders them as separate sub-Assets that move + rotate rigidly
with their Mount (= rigid to the Glan-Laser sub-Component sharing
the same Mount parent).

Per-partition transformation
----------------------------
Each new Asset3D references the SAME housing STL file as the body
asset, but with two viewerHints fields that select + recenter the
geometry at load time:

  viewerHints.includeOnlyCentroids
      Keep only the partition's centroid keys, drop the rest.
  viewerHints.recenterOrigin
      Translate the kept geometry by -(Mount's body-local pose) so
      its effective origin lands at the Mount. Without this, the
      sub-asset's STL coords would double-offset under the Mount
      binding's own local translation.

For IO-3-850-HP::

  front_piece: recenterOrigin = (0, 11, 0)   = front_mount.local
  back_piece:  recenterOrigin = (0, 84, 0)   = back_mount.local

Body asset update
-----------------
After baking, the body asset's ``viewerHints.deletedCentroids`` is
extended to also exclude the partition centroids. Without that, the
front/back triangles would render TWICE — once via the body asset's
unfiltered geometry, once via the per-partition sub-asset.

Binding tree shape after this migration (IO-3-850-HP)::

  root (asset=body, viewerHints.deletedCentroids ⊇ front + back)
  ├─ front_mount (empty, tunable.ry_deg)
  │   ├─ front_pbs (subcomp=GlanLaserCalcitePrism)
  │   └─ front_piece (asset=new, identity local) ← NEW
  └─ back_mount  (empty, tunable.ry_deg)
      ├─ back_pbs  (subcomp=GlanLaserCalcitePrism)
      └─ back_piece  (asset=new, identity local) ← NEW

Idempotent — skips per-side if a binding with the matching
role_label already exists.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0074_io_3_hp_bake_partitions"
down_revision = "0073_io_5_hp_glan_pose"
branch_labels = None
depends_on = None


TARGET_MODEL = "IO-3-850-HP"


def _bake_side(
    bind,
    comp_id,
    body_asset_id,
    body_file_path: str,
    body_asset_type: str,
    mount_id,
    mount_local: tuple[float, float, float],
    partition: list[str],
    side: str,
) -> list[str]:
    """Bake one partition (front or back). Returns the centroid keys
    that need to be added to the body asset's deletedCentroids (so
    the body stops rendering this partition)."""
    if not partition or not mount_id:
        return []

    label = f"{side}_piece"

    # Idempotency: skip if this piece is already bound under the mount.
    existing = bind.execute(
        sa.text(
            "SELECT 1 FROM component_bindings "
            " WHERE component_id = :cid "
            "   AND parent_binding_id = :mid "
            "   AND target_kind = 'asset' "
            "   AND properties->>'role_label' = :label "
            " LIMIT 1"
        ),
        {"cid": comp_id, "mid": mount_id, "label": label},
    ).first()
    if existing is not None:
        return []

    # Create the sub-Asset3D: same STL file, viewerHints isolate the
    # partition and recenter its origin to the Mount's body pose.
    asset_props = {
        "viewerHints": {
            "includeOnlyCentroids": list(partition),
            "recenterOrigin": list(mount_local),
        }
    }
    new_asset_id = bind.execute(
        sa.text(
            """
            INSERT INTO assets_3d (
                name, asset_type, file_path, unit, scale_factor,
                anchors, properties
            ) VALUES (
                :name, :atype, :fp, 'mm', 1.0,
                '[]'::jsonb, CAST(:props AS jsonb)
            ) RETURNING id
            """
        ),
        {
            "name": f"io_3_850_hp_{label}",
            "atype": body_asset_type,
            "fp": body_file_path,
            "props": json.dumps(asset_props),
        },
    ).scalar_one()

    # Bind the new asset under the Mount, identity local transform.
    # sort_order=2 keeps it after the PBS sub-Component (sort_order=1
    # from A''.9 / A''.11) in the listing.
    bind.execute(
        sa.text(
            """
            INSERT INTO component_bindings (
                component_id, parent_binding_id, target_kind, asset_3d_id,
                role, local_x_mm, local_y_mm, local_z_mm,
                local_rx_deg, local_ry_deg, local_rz_deg,
                tunable_axes, sort_order, properties
            ) VALUES (
                :cid, :mid, 'asset', :aid,
                'internal_part', 0, 0, 0, 0, 0, 0,
                '{}'::jsonb, 2, CAST(:props AS jsonb)
            )
            """
        ),
        {
            "cid": comp_id,
            "mid": mount_id,
            "aid": new_asset_id,
            "props": json.dumps({"role_label": label}),
        },
    )

    return list(partition)


def upgrade() -> None:
    bind = op.get_bind()

    comp = bind.execute(
        sa.text(
            "SELECT id, asset_3d_id, properties FROM components "
            " WHERE model = :m AND archived_at IS NULL "
            " ORDER BY created_at ASC LIMIT 1"
        ),
        {"m": TARGET_MODEL},
    ).first()
    if comp is None or comp.asset_3d_id is None:
        return

    front_centroids = list(
        (comp.properties or {}).get("isolatorFrontPartCentroids", [])
    )
    back_centroids = list(
        (comp.properties or {}).get("isolatorBackPartCentroids", [])
    )
    if not front_centroids and not back_centroids:
        return  # nothing to bake

    body_asset = bind.execute(
        sa.text(
            "SELECT id, file_path, asset_type, properties "
            " FROM assets_3d WHERE id = :id"
        ),
        {"id": comp.asset_3d_id},
    ).first()
    if body_asset is None:
        return

    # Locate the Mount bindings + their local pose.
    mounts = bind.execute(
        sa.text(
            "SELECT id, properties->>'role_label' AS label, "
            "       local_x_mm, local_y_mm, local_z_mm "
            "  FROM component_bindings "
            " WHERE component_id = :cid AND target_kind = 'empty'"
        ),
        {"cid": comp.id},
    ).fetchall()
    front_mount = next((m for m in mounts if m.label == "front_mount"), None)
    back_mount = next((m for m in mounts if m.label == "back_mount"), None)

    excluded: list[str] = []
    if front_mount is not None:
        excluded.extend(
            _bake_side(
                bind, comp.id, body_asset.id, body_asset.file_path,
                body_asset.asset_type, front_mount.id,
                (front_mount.local_x_mm, front_mount.local_y_mm, front_mount.local_z_mm),
                front_centroids, "front",
            )
        )
    if back_mount is not None:
        excluded.extend(
            _bake_side(
                bind, comp.id, body_asset.id, body_asset.file_path,
                body_asset.asset_type, back_mount.id,
                (back_mount.local_x_mm, back_mount.local_y_mm, back_mount.local_z_mm),
                back_centroids, "back",
            )
        )

    if not excluded:
        return

    # Extend body asset's viewerHints.deletedCentroids with the baked
    # partitions (union, preserve order isn't important for set
    # semantics). Without this, the body's unfiltered render would
    # double-render the front/back triangles on top of the sub-assets.
    current_hints = (body_asset.properties or {}).get("viewerHints", {})
    current_deletions = list(current_hints.get("deletedCentroids", []))
    merged = sorted(set(current_deletions) | set(excluded))

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
                     '{viewerHints,deletedCentroids}',
                     CAST(:list AS jsonb),
                     true
                   )
             WHERE id = :id
            """
        ),
        {"id": body_asset.id, "list": json.dumps(merged)},
    )


def downgrade() -> None:
    bind = op.get_bind()
    comp = bind.execute(
        sa.text(
            "SELECT id, asset_3d_id, properties FROM components "
            " WHERE model = :m ORDER BY created_at ASC LIMIT 1"
        ),
        {"m": TARGET_MODEL},
    ).first()
    if comp is None or comp.asset_3d_id is None:
        return

    baked = bind.execute(
        sa.text(
            "SELECT id, asset_3d_id FROM component_bindings "
            " WHERE component_id = :cid "
            "   AND target_kind = 'asset' "
            "   AND properties->>'role_label' IN ('front_piece', 'back_piece')"
        ),
        {"cid": comp.id},
    ).fetchall()
    if not baked:
        return

    binding_ids = [b.id for b in baked]
    asset_ids = [b.asset_3d_id for b in baked if b.asset_3d_id is not None]

    bind.execute(
        sa.text("DELETE FROM component_bindings WHERE id = ANY(:ids)"),
        {"ids": binding_ids},
    )
    if asset_ids:
        bind.execute(
            sa.text("DELETE FROM assets_3d WHERE id = ANY(:ids)"),
            {"ids": asset_ids},
        )

    # Remove the baked partitions from the body asset's
    # deletedCentroids (recover the original list).
    front_centroids = set(
        (comp.properties or {}).get("isolatorFrontPartCentroids", [])
    )
    back_centroids = set(
        (comp.properties or {}).get("isolatorBackPartCentroids", [])
    )
    excluded = front_centroids | back_centroids

    body_props = bind.execute(
        sa.text("SELECT properties FROM assets_3d WHERE id = :id"),
        {"id": comp.asset_3d_id},
    ).scalar_one_or_none()
    if body_props is None:
        return
    current = list(body_props.get("viewerHints", {}).get("deletedCentroids", []))
    restored = [k for k in current if k not in excluded]
    bind.execute(
        sa.text(
            "UPDATE assets_3d SET properties = jsonb_set("
            "    properties, '{viewerHints,deletedCentroids}', "
            "    CAST(:list AS jsonb), true"
            ") WHERE id = :id"
        ),
        {"id": comp.asset_3d_id, "list": json.dumps(restored)},
    )
