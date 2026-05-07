"""fix unit on AOM GLB asset records

Revision ID: 0017_fix_aom_glb_unit
Revises: 0016_unique_object_home

The AOM GLB at `assets/uploads/aom_aa_mt80.glb` was authored in Blender at
NATIVE METRES (Blender's default scene scale). The /api/assets/upload-component
endpoint defaults `unit="mm"`, so when the user uploaded the GLB through the
UI the asset row was stored as mm. The frontend's `applyAssetScale` then
divides by 100 (mm→three-units), producing a 1/1000-scale model that
visually disappears next to the rest of the lab.

This migration:
  1. updates any Asset3D row whose file_path looks like the AOM GLB and
     whose unit is currently "mm", switching it to "m".
  2. is idempotent — running it twice is a no-op.

If the user later uploads a *new* AOM GLB authored in mm, the migration
will not touch it because the unit is already correct.
"""

from __future__ import annotations

from alembic import op


revision = "0017_fix_aom_glb_unit"
down_revision = "0016_unique_object_home"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE assets_3d
        SET unit = 'm'
        WHERE asset_type = 'glb'
          AND file_path ILIKE '%aom_aa_mt80%.glb'
          AND unit = 'mm'
        """
    )


def downgrade() -> None:
    # Reverting would re-introduce the bug. Make downgrade a no-op rather
    # than re-corrupting working asset records.
    pass
