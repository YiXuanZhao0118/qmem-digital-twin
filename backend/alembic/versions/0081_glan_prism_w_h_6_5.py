"""GlanLaserCalcitePrism: refine body cross-section to 6.5 mm × 6.5 mm

Revision ID: 0081_glan_w_h_6_5
Revises: 0080_isolator_nested

Phase 21 — refines the catalogue GlanLaserCalcitePrism body dimensions
to the user-specified compact prism spec:

    Length L = 7.5 mm   (already set by 0079 — unchanged)
    Width W  = 6.5 mm   (was 8.5; this migration overrides)
    Height H = 6.5 mm   (was 8.5; this migration overrides)
    Wedge    = 38.5°    (already set by 0079 — unchanged)

The procedural renderer (``glan_polarizer_prism.ts``) reads
``component.properties.sizeMm`` for the body cross-section (single value
since W == H). With W = H = 6.5 mm the rendered prism becomes a
compact 6.5 × 6.5 × 7.5 mm crystal — slightly narrower than the prior
GL5-B-class 8.5 mm body. The 5×5 ABCD operator (m_glan_slab) is
unaffected: it uses lengthMm (Z), refractiveIndex, wedgeAngleDeg, and
the airGap astigmatism correction — none of which depend on the
transverse W/H dimension.

Idempotent — re-running just refreshes sizeMm. Downgrade reverts to
the previous 8.5 mm baseline set by 0079.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0081_glan_w_h_6_5"
down_revision = "0080_isolator_nested"
branch_labels = None
depends_on = None


GLAN_COMPONENT_NAME = "GlanLaserCalcitePrism"


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            """
            UPDATE components
               SET properties = COALESCE(properties, '{}'::jsonb) || CAST(:patch AS jsonb)
             WHERE name = :name
            """
        ),
        {"name": GLAN_COMPONENT_NAME, "patch": json.dumps({"sizeMm": 6.5})},
    )


def downgrade() -> None:
    bind = op.get_bind()
    # Restore the 8.5 mm baseline that migration 0079 originally set.
    bind.execute(
        sa.text(
            """
            UPDATE components
               SET properties = COALESCE(properties, '{}'::jsonb) || CAST(:patch AS jsonb)
             WHERE name = :name
            """
        ),
        {"name": GLAN_COMPONENT_NAME, "patch": json.dumps({"sizeMm": 8.5})},
    )
