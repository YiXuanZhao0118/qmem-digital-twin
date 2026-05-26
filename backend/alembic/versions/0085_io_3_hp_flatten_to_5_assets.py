"""IO-3-850-HP: flatten to 5-binding tree, retire workaround Asset3Ds

Revision ID: 0085_io_3_hp_flatten
Revises: 0084_rf_v3_backfill

Replaces the legacy 7-binding mount/partition tree (alembic 0071 + 0074)
and the single-asset workaround (``thorlabs_io_3_850_faraday_rod`` that
held the FULL assembly STL on one Asset3D) with the new catalog shape:

  Component IO-3-850-HP
  ├─ hp_root      → thorlabs_io_3_850_hp_root      (kind=faraday_rotator)
  ├─ glan_front   → glan_laser_io3_850             (kind=pbs)
  ├─ glan_back    → glan_laser_io3_850             (kind=pbs)
  ├─ front_piece  → io_3_850_hp_front_piece        (mechanical-only)
  └─ back_piece   → io_3_850_hp_back_piece         (mechanical-only)

All 5 are sibling bindings (parent_binding_id = NULL) under the Component
origin. Each Asset3D owns its own STL slice — no Asset3D holds the full
assembly any more.

This migration only **cleans up** the DB state. The new bindings + new
Asset3Ds are then populated by re-running
``backend/scripts/seed_v3_assets.py`` (which reads the updated JSON
catalog). The 3 new STL slice files are produced by
``backend/scripts/split_io_3_hp_stl.py``.

Cleanup steps:
  1. Wipe IO-3-850-HP's ComponentBindings (the 7-binding 0071+0074 tree).
  2. Clear Component.asset_3d_id (legacy single-FK pointer; the new
     5-binding shape leaves it null and uses bindings exclusively).
  3. Delete the workaround ``thorlabs_io_3_850_faraday_rod`` Asset3D.
  4. Delete the 0074-created legacy partition Asset3Ds (named
     ``io_3_850_hp_front_piece`` / ``io_3_850_hp_back_piece`` with no
     catalog_id — seed_v3 will create fresh rows with catalog_id set).

IO-5-850-HP is intentionally NOT touched here — it shares the
GlanLaserCalcitePrism sub-Component path and may still need the legacy
structure until a similar follow-up arrives.

Idempotent. Downgrade is a no-op (restoring the workaround would require
re-deriving 0071+0074's binding data, which is not worth carrying).
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op


revision = "0085_io_3_hp_flatten"
down_revision = "0084_rf_v3_backfill"
branch_labels = None
depends_on = None


TARGET_MODEL = "IO-3-850-HP"
WORKAROUND_ASSET_NAMES = (
    # Old full-assembly workaround Asset3D (catalog file deleted in this commit).
    "FaradayRod_IO3_850",
    # 0074-created per-partition Asset3Ds (no catalog_id; recreated by seed_v3 fresh).
    "io_3_850_hp_front_piece",
    "io_3_850_hp_back_piece",
)


def upgrade() -> None:
    bind = op.get_bind()

    comp = bind.execute(
        sa.text(
            "SELECT id FROM components "
            " WHERE model = :m AND archived_at IS NULL "
            " ORDER BY created_at ASC LIMIT 1"
        ),
        {"m": TARGET_MODEL},
    ).first()
    if comp is None:
        # Component not seeded yet — nothing to clean up. seed_v3_assets.py
        # will create it directly in the new 5-binding shape.
        return

    # 1. Wipe IO-3-850-HP's bindings. ON DELETE CASCADE on
    #    parent_binding_id handles child rows automatically; we just
    #    issue the bulk delete here.
    bind.execute(
        sa.text("DELETE FROM component_bindings WHERE component_id = :cid"),
        {"cid": comp.id},
    )

    # 2. Clear legacy single-asset FK so we can drop the workaround
    #    Asset3D without ON DELETE NO ACTION blocking us.
    bind.execute(
        sa.text("UPDATE components SET asset_3d_id = NULL WHERE id = :cid"),
        {"cid": comp.id},
    )

    # 3+4. Drop the workaround + 0074 partition Asset3Ds. They have no
    #     catalog_id, so seed_v3 won't recreate them; the new catalog
    #     ids (thorlabs_io_3_850_hp_root, io_3_850_hp_front_piece,
    #     io_3_850_hp_back_piece) become the source of truth.
    bind.execute(
        sa.text(
            "DELETE FROM assets_3d "
            " WHERE name = ANY(:names) AND catalog_id IS NULL"
        ),
        {"names": list(WORKAROUND_ASSET_NAMES)},
    )


def downgrade() -> None:
    # Restoring the workaround would mean re-deriving 0071+0074's binding
    # tree, partition centroid filtering, and the full-assembly STL
    # mapping — not worth carrying. Run seed_v3_assets.py to rebuild
    # whichever catalog state is desired.
    pass
