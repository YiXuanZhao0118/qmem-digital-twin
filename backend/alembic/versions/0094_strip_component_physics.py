"""Strip physics duplicates from components.properties.

Revision ID: 0094_strip_component_physics
Revises: 0093_flatten_asset_frame_anchors

Retirement Phase 2: physics lives on Asset3D.default_params. The Component
carried duplicate physics keys (wavelengthCenterNm, waveplateKindParamsOverride)
solely to seed the now-removed legacy per-object physics path. Remove them from
existing rows. The authoritative copies remain on the bound Asset3D, so no
correct data is lost.
"""

from __future__ import annotations

from alembic import op


revision = "0094_strip_component_physics"
down_revision = "0093_flatten_asset_frame_anchors"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE components
        SET properties = (properties - 'wavelengthCenterNm')
                                     - 'waveplateKindParamsOverride'
        WHERE properties ? 'wavelengthCenterNm'
           OR properties ? 'waveplateKindParamsOverride'
        """
    )


def downgrade() -> None:
    # Irreversible: the removed keys were exact duplicates of the bound
    # Asset3D.default_params and are not restorable from this table alone.
    pass
