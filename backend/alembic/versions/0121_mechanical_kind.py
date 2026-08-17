"""Add the ``mechanical`` kind (passive mechanical hardware).

A no-physics, mechanical-domain-only kind for the lab's structural
hardware — kinematic mirror mounts, posts, post holders, clamping forks,
pedestals, adapters. Same passive pattern as ``optical_table`` /
``unclassified``: ``op_set_name='none'`` (the tracer runs no op for it),
empty ``default_params`` / ``anchor_template``, no wavelength or
frequency band.

Why a DB kind and not just a passive plugin: ``assets_3d.kind_id`` is
NOT NULL since 0111 and the asset's **domain is kind-authoritative**
(``kind.domains``, see docs/introduce/kinds.md), so a mount imported
through BUILD has no way to land on the PHY Editor's mechanical rail —
it stays on the all-domain ``unclassified`` placeholder. The frontend's
``passive_plugins`` (mirror_mount, optical_post, post_holder, …) are
*componentType* catalog entries, a different layer; they never gave the
asset layer a mechanical kind to point at.

No frontend physics plugin backs this kind — that is intended: an orphan
kind disables the per-anchor direction/aperture fields in the Asset3D
editor, which is exactly right for a part that never touches a beam.

Additive only: no asset is reassigned. Existing mounts (e.g. ``KS1T``)
keep ``kind_id='unclassified'`` until a human repoints them in the PHY
Editor's ASSET3D kind dropdown.

Revision ID: 0121_mechanical_kind
Revises: 0120_aom_crystal_length
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op


revision = "0121_mechanical_kind"
down_revision = "0120_aom_crystal_length"
branch_labels = None
depends_on = None


KIND_NAME = "mechanical"


def upgrade() -> None:
    op.get_bind().execute(
        sa.text(
            "INSERT INTO kinds ("
            "name, display_name, op_set_name, domains, "
            "default_params, anchor_template, needs_aperture, "
            "wavelength_range_nm, frequency_range_mhz, description"
            ") VALUES ("
            ":name, :display_name, :op_set_name, "
            "ARRAY['mechanical']::text[], "
            "CAST(:default_params AS JSONB), CAST(:anchor_template AS JSONB), "
            ":needs_aperture, NULL, NULL, :description"
            ") ON CONFLICT (name) DO NOTHING"
        ),
        {
            "name": KIND_NAME,
            "display_name": "Mechanical",
            "op_set_name": "none",
            "default_params": "{}",
            "anchor_template": "{}",
            "needs_aperture": False,
            "description": "Passive mechanical hardware with no physics — "
            "optical mounts, posts, post holders, clamps, pedestals, "
            "adapters. Mechanical domain only.",
        },
    )


def downgrade() -> None:
    op.get_bind().execute(
        sa.text("DELETE FROM kinds WHERE name = :name"), {"name": KIND_NAME}
    )
