"""GlanLaserCalcitePrism: set physical specs (L=7.5mm, n_e=1.48, wedge=38.5°)

Revision ID: 0079_glan_prism_physical
Revises: 0078_io_5_hp_clone

Pins the catalogue GlanLaserCalcitePrism Component to the user-specified
compact calcite prism geometry:

    Body length L  = 7.5 mm       (along optical axis)
    Body W = H     = 8.5 mm       (Thorlabs GL5-B body cross-section)
    Wedge angle    = 38.5°        (standard calcite Glan-Laser at 850 nm)
    n_e (E-ray)    = 1.48         (calcite at 850 nm)

These values land on Component.properties so the procedural 3D renderer
picks them up (sizeMm / lengthMm / wedgeAngleDeg are read by
``buildGlanPolarizerPrismObject``) AND so the backend optical solver
seeds new PhysicsElement.kindParams with the same dimensions when an
operator drops a fresh GlanLaserCalcitePrism instance into a scene.

The optical-physics params (refractiveIndex, airGapAstigmatismMm,
augmentedOffsetXMm) live in the plugin defaultParams — every new
PhysicsElement for this kind inherits them automatically, so no
per-Component override is needed for those today. The 3D-geometry
params (lengthMm, wedgeAngleDeg, sizeMm) DO need to live on the
Component because the procedural renderer reads from
``component.properties`` not from the plugin manifest.

Idempotent — re-running just refreshes the properties to the canonical
values. Downgrade clears the keys to fall back to plugin defaults.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0079_glan_prism_physical"
down_revision = "0078_io_5_hp_clone"
branch_labels = None
depends_on = None


GLAN_COMPONENT_NAME = "GlanLaserCalcitePrism"

PHYSICAL_SPECS = {
    "sizeMm": 8.5,
    "lengthMm": 7.5,
    "wedgeAngleDeg": 38.5,
    # airGapMm intentionally LEFT to plugin default (0.05 mm) —
    # the visualisation exaggerates it for legibility.
}


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            """
            UPDATE components
               SET properties = COALESCE(properties, '{}'::jsonb) || CAST(:specs AS jsonb)
             WHERE name = :name
            """
        ),
        {"name": GLAN_COMPONENT_NAME, "specs": json.dumps(PHYSICAL_SPECS)},
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            """
            UPDATE components
               SET properties = (properties - 'sizeMm' - 'lengthMm' - 'wedgeAngleDeg')
             WHERE name = :name
            """
        ),
        {"name": GLAN_COMPONENT_NAME},
    )
