"""V2 Phase 5: rename `lens_spherical` element_kind → `lens_biconvex`

Revision ID: 0031_lens_v2_split
Revises: 0030_wp_pol_v2_cutov

V2 schema (docs/optical-schema-v2.md §3) splits the generic spherical lens
into ``lens_biconvex`` and ``lens_plano_convex`` to make surface geometry
explicit (thick-lens models will need it). This migration renames every
existing ``lens_spherical`` row to ``lens_biconvex`` (the safer default —
biconvex shape works for both spherical convex and concave thin-lens
focal-length models).

``lens_plano_convex`` is registered as a new kind in code; existing rows
stay biconvex. Future plano-convex lens components can be created
explicitly by the user via /api/components.

``lens_cylindrical`` is left untouched — V2 doesn't supersede it, and
cylindrical optics genuinely behave differently from spherical.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op


revision = "0031_lens_v2_split"
down_revision = "0030_wp_pol_v2_cutov"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE optical_elements SET element_kind = 'lens_biconvex' WHERE element_kind = 'lens_spherical'"
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE optical_elements SET element_kind = 'lens_spherical' WHERE element_kind = 'lens_biconvex'"
        )
    )
