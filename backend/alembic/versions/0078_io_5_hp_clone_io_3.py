"""IO-5-850-HP: clone IO-3-850-HP's geometry + piece bindings

Revision ID: 0078_io_5_hp_clone
Revises: 0077_io_5_hp_link

User confirmed IO-5-850-HP and IO-3-850-HP are the same physical
isolator — same housing, same internal optics — differing only in max
power rating. Cheapest way to bring IO-5 to feature parity with IO-3
(piece sub-meshes that rotate together with their prism via linkGroup):
have IO-5 share IO-3's geometry + viewerHints + piece-asset rows.

What this migration does
------------------------

1. **Repoint IO-5 body asset's filePath** to ``thorlabs_io_3_850_hp.stl``
   (the IO-3 STL). Copies the IO-3 body asset's viewerHints
   (deletedCentroids, bundledOverlay) onto IO-5's body asset so the
   housing renders identically. We keep the IO-5 Asset3D row (renaming
   the file pointer rather than dropping the row) so foreign keys
   pointing at IO-5's body asset don't dangle.

2. **Update IO-5 root body binding** to point at IO-5's (now-repointed)
   body asset — no-op for the binding's asset_3d_id (still IO-5's body
   asset id) since we changed the asset's filePath in step 1.

3. **Create IO-5 piece Asset3D rows** (``io_5_850_hp_front_piece``,
   ``io_5_850_hp_back_piece``) mirroring IO-3's piece asset shape:
   pointing at the IO-3 STL, with viewerHints copied byte-for-byte
   from IO-3's piece assets (includeOnlyCentroids + recenterOrigin).

4. **Create IO-5 piece bindings** under the root body, with pose +
   tunable_axes + properties (linkGroup, role_label) copied from IO-3's
   piece bindings. The front_glan_laser / back_glan_laser subcomponent
   bindings already exist (linkGroup was applied by 0077) so we leave
   them alone.

5. **Copy IO-3 component.properties.isolator*** values into IO-5's
   properties so the dev page sees the same partition data when the
   user selects IO-5 (lets them tweak from a working baseline rather
   than starting empty).

Idempotent — each step checks for the target state and skips if
already present. Safe to rerun.

Downgrade
---------
Restores IO-5's body asset filePath to thorlabs_io_5_850_hp.stl,
drops the IO-5 piece assets + bindings, clears the copied properties.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0078_io_5_hp_clone"
down_revision = "0077_io_5_hp_link"
branch_labels = None
depends_on = None


SOURCE_MODEL = "IO-3-850-HP"
TARGET_MODEL = "IO-5-850-HP"
SOURCE_STL = "files/stl/thorlabs_io_3_850_hp.stl"
TARGET_STL = "files/stl/thorlabs_io_5_850_hp.stl"


def _comp(bind, model: str):
    return bind.execute(
        sa.text(
            "SELECT id, asset_3d_id, properties FROM components"
            " WHERE model = :m AND archived_at IS NULL"
            " ORDER BY created_at ASC LIMIT 1"
        ),
        {"m": model},
    ).fetchone()


def _asset(bind, asset_id):
    return bind.execute(
        sa.text(
            "SELECT id, name, asset_type, file_path, source, source_url,"
            "       unit, scale_factor, anchors, properties"
            "  FROM assets_3d WHERE id = :id"
        ),
        {"id": asset_id},
    ).fetchone()


def _piece_bindings(bind, comp_id, side: str):
    """Return IO-3's piece binding rows for a side ('front' or 'back')."""
    return bind.execute(
        sa.text(
            "SELECT id, parent_binding_id, target_kind, asset_3d_id,"
            "       sub_component_id, role,"
            "       local_x_mm, local_y_mm, local_z_mm,"
            "       local_rx_deg, local_ry_deg, local_rz_deg,"
            "       tunable_axes, sort_order, properties"
            "  FROM component_bindings"
            " WHERE component_id = :cid"
            "   AND properties->>'role_label' = :role"
            " LIMIT 1"
        ),
        {"cid": comp_id, "role": f"{side}_piece"},
    ).fetchone()


def upgrade() -> None:
    bind = op.get_bind()

    src = _comp(bind, SOURCE_MODEL)
    dst = _comp(bind, TARGET_MODEL)
    if src is None or dst is None:
        return

    src_body_asset = _asset(bind, src.asset_3d_id)
    dst_body_asset = _asset(bind, dst.asset_3d_id)
    if src_body_asset is None or dst_body_asset is None:
        return

    # --- 1. Repoint IO-5 body asset's filePath + copy viewerHints ---------
    if dst_body_asset.file_path != SOURCE_STL:
        bind.execute(
            sa.text(
                "UPDATE assets_3d SET file_path = :fp,"
                " properties = CAST(:props AS jsonb)"
                " WHERE id = :id"
            ),
            {
                "id": dst_body_asset.id,
                "fp": SOURCE_STL,
                "props": json.dumps(dict(src_body_asset.properties or {})),
            },
        )

    # --- 3. Create IO-5 piece Asset3D rows mirroring IO-3's pieces --------
    dst_piece_asset_ids: dict[str, str] = {}
    for side in ("front", "back"):
        # Source: the IO-3 piece asset for this side, looked up by the
        # naming convention 0074 used (io_3_850_hp_<side>_piece).
        src_piece = bind.execute(
            sa.text(
                "SELECT id, name, asset_type, file_path, source, source_url,"
                "       unit, scale_factor, anchors, properties"
                "  FROM assets_3d WHERE name = :n"
            ),
            {"n": f"io_3_850_hp_{side}_piece"},
        ).fetchone()
        if src_piece is None:
            continue

        dst_name = f"io_5_850_hp_{side}_piece"
        existing = bind.execute(
            sa.text("SELECT id FROM assets_3d WHERE name = :n"),
            {"n": dst_name},
        ).fetchone()
        if existing is not None:
            dst_piece_asset_ids[side] = str(existing.id)
            continue

        new_id = bind.execute(
            sa.text(
                "INSERT INTO assets_3d ("
                "  name, asset_type, file_path, source, source_url,"
                "  unit, scale_factor, anchors, properties"
                ") VALUES ("
                "  :n, :t, :fp, :src, :srcu,"
                "  :u, :sf, CAST(:anc AS jsonb), CAST(:p AS jsonb)"
                ") RETURNING id"
            ),
            {
                "n": dst_name,
                "t": src_piece.asset_type,
                "fp": src_piece.file_path,
                "src": src_piece.source,
                "srcu": src_piece.source_url,
                "u": src_piece.unit,
                "sf": src_piece.scale_factor,
                "anc": json.dumps(list(src_piece.anchors or [])),
                "p": json.dumps(dict(src_piece.properties or {})),
            },
        ).scalar_one()
        dst_piece_asset_ids[side] = str(new_id)

    # --- 4. Create IO-5 piece bindings under root body --------------------
    dst_root = bind.execute(
        sa.text(
            "SELECT id FROM component_bindings"
            " WHERE component_id = :cid AND parent_binding_id IS NULL"
            " LIMIT 1"
        ),
        {"cid": dst.id},
    ).scalar_one_or_none()
    if dst_root is None:
        return

    for side in ("front", "back"):
        # Skip if IO-5 already has this side's piece binding.
        existing = bind.execute(
            sa.text(
                "SELECT id FROM component_bindings"
                " WHERE component_id = :cid"
                "   AND properties->>'role_label' = :role"
            ),
            {"cid": dst.id, "role": f"{side}_piece"},
        ).fetchone()
        if existing is not None:
            continue
        src_pb = _piece_bindings(bind, src.id, side)
        if src_pb is None:
            continue
        new_asset_id = dst_piece_asset_ids.get(side)
        if new_asset_id is None:
            continue
        bind.execute(
            sa.text(
                "INSERT INTO component_bindings ("
                "  component_id, parent_binding_id, target_kind,"
                "  asset_3d_id, sub_component_id, role,"
                "  local_x_mm, local_y_mm, local_z_mm,"
                "  local_rx_deg, local_ry_deg, local_rz_deg,"
                "  tunable_axes, sort_order, properties"
                ") VALUES ("
                "  :cid, :pid, :tk, :aid, NULL, :role,"
                "  :x, :y, :z, :rx, :ry, :rz,"
                "  CAST(:tun AS jsonb), :so, CAST(:p AS jsonb)"
                ")"
            ),
            {
                "cid": dst.id, "pid": dst_root,
                "tk": src_pb.target_kind,
                "aid": new_asset_id,
                "role": src_pb.role,
                "x": src_pb.local_x_mm, "y": src_pb.local_y_mm, "z": src_pb.local_z_mm,
                "rx": src_pb.local_rx_deg, "ry": src_pb.local_ry_deg, "rz": src_pb.local_rz_deg,
                "tun": json.dumps(dict(src_pb.tunable_axes or {})),
                "so": src_pb.sort_order,
                "p": json.dumps(dict(src_pb.properties or {})),
            },
        )

    # --- 5. Copy isolator* component.properties from IO-3 to IO-5 ---------
    src_props = dict(src.properties or {})
    dst_props = dict(dst.properties or {})
    for k in (
        "isolatorDeletedCentroids",
        "isolatorFrontPartCentroids",
        "isolatorBackPartCentroids",
        "isolatorLinkedRotationGroup",
    ):
        if k in src_props:
            dst_props[k] = src_props[k]
    bind.execute(
        sa.text("UPDATE components SET properties = CAST(:p AS jsonb) WHERE id = :id"),
        {"id": dst.id, "p": json.dumps(dst_props)},
    )


def downgrade() -> None:
    bind = op.get_bind()
    dst = _comp(bind, TARGET_MODEL)
    if dst is None:
        return

    # Drop the cloned piece bindings (cascades nothing — they have no
    # children). The asset_3d_id_override on object_bindings, if any,
    # would prevent asset deletion; piece bindings have no such refs.
    bind.execute(
        sa.text(
            "DELETE FROM component_bindings"
            " WHERE component_id = :cid"
            "   AND properties->>'role_label' IN ('front_piece', 'back_piece')"
        ),
        {"cid": dst.id},
    )
    # Drop the cloned piece assets.
    bind.execute(
        sa.text(
            "DELETE FROM assets_3d"
            " WHERE name IN ('io_5_850_hp_front_piece', 'io_5_850_hp_back_piece')"
        )
    )
    # Restore IO-5 body asset to its native STL file path; viewerHints
    # left as-is (IO-3 hints are still valid since the geometry is the
    # same; reverting them might leak partition data left in IO-5).
    bind.execute(
        sa.text(
            "UPDATE assets_3d SET file_path = :fp WHERE id = :id"
        ),
        {"id": dst.asset_3d_id, "fp": TARGET_STL},
    )
    # Clear the copied isolator* properties.
    dst_props = dict(dst.properties or {})
    for k in (
        "isolatorDeletedCentroids",
        "isolatorFrontPartCentroids",
        "isolatorBackPartCentroids",
        "isolatorLinkedRotationGroup",
    ):
        dst_props.pop(k, None)
    bind.execute(
        sa.text("UPDATE components SET properties = CAST(:p AS jsonb) WHERE id = :id"),
        {"id": dst.id, "p": json.dumps(dst_props)},
    )
