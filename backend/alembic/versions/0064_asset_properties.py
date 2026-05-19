"""add Asset3D.properties JSONB for viewerHints + asset-level metadata

Revision ID: 0064_asset_properties
Revises: 0063_unify_asset_paths

Stage A''.1 — gives Asset3D a per-row JSONB ``properties`` column so
asset-level metadata (viewer hints, future per-asset overrides) has a
canonical home. First consumer is ``viewerHints``::

    Asset3D.properties = {
      "viewerHints": {
        "deletedCentroids": ["12.5,0.0,-3.5", ...],   // STL triangle prune
        "axisRadiusFilterMm": 5,                       // bulk hide ≤Nmm of bbox-longest axis
        "material": { "type": "translucent_housing", "opacity": 0.35 }
      }
    }

The renderer's generic asset loader honours these hints regardless of
the consuming Component's componentType — so isolators (currently
served by a bespoke pbsOverlay path that does triangle-filtering +
translucent housing manually) and any other catalog asset with the
same needs use one code path.

Previously the deletion / filter data lived on
``Component.properties.isolatorDeletedCentroids`` and
``Component.properties.isolatorLinkedRotationGroup``. Stage A''.2
data-migrates those into the new ``Asset3D.properties.viewerHints``
location; this migration is just the empty column.

Idempotent — rerunning is a no-op once the column exists.
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op


revision = "0064_asset_properties"
down_revision = "0063_unify_asset_paths"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "assets_3d",
        sa.Column(
            "properties",
            JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("assets_3d", "properties")
