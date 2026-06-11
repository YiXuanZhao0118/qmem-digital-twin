"""Add the ``unclassified`` placeholder kind (BUILD default).

A no-physics, all-domain kind used as the default for freshly imported
BUILD geometry. ``op_set_name='none'`` (no tracer op — same passive
pattern as ``isolator``), empty ``default_params`` / ``anchor_template``,
and ``domains=['optical','rf','mechanical']`` so a new import surfaces
under every PHY Editor rail until the user assigns a real kind.

Pairs with:
  - backend ``v3_catalog.upload_asset3d_v3`` fallback (kind_id default)
  - frontend ``GeometryBuilder`` kind dropdown initial selection

Revision ID: 0110_unclassified_kind
Revises: 0109_drop_circuits_em_runs
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op


revision = "0110_unclassified_kind"
down_revision = "0109_drop_circuits_em_runs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text(
            "INSERT INTO kinds ("
            "name, display_name, op_set_name, domains, "
            "default_params, anchor_template, needs_aperture, "
            "wavelength_range_nm, frequency_range_mhz, description"
            ") VALUES ("
            ":name, :display_name, :op_set_name, "
            "ARRAY['optical','rf','mechanical']::text[], "
            "CAST(:default_params AS JSONB), CAST(:anchor_template AS JSONB), "
            ":needs_aperture, NULL, NULL, :description"
            ") ON CONFLICT (name) DO NOTHING"
        ),
        {
            "name": "unclassified",
            "display_name": "Unclassified",
            "op_set_name": "none",
            "default_params": "{}",
            "anchor_template": "{}",
            "needs_aperture": False,
            "description": "All-domain, no-physics placeholder. Default kind "
            "for newly imported BUILD geometry until a real kind is assigned.",
        },
    )


def downgrade() -> None:
    op.get_bind().execute(
        sa.text("DELETE FROM kinds WHERE name = 'unclassified'")
    )
