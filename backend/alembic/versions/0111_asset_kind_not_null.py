"""Forbid kindless Asset3D — kind_id NOT NULL, default 'unclassified'.

Every Asset3D must carry a kind (at minimum the all-domain, no-physics
``unclassified`` placeholder from migration 0110). Backfills any legacy
NULL / 'none'-sentinel rows, sets a server default, then locks the
column NOT NULL so no path (upload, JSON create, agent tool) can land a
kindless asset.

NOTE: only ``assets_3d.kind_id`` is constrained. ``components.kind_id``
stays nullable — a composite Component legitimately has kind=NULL +
asset=NULL (renders via the binding tree).

Revision ID: 0111_asset_kind_not_null
Revises: 0110_unclassified_kind
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op


revision = "0111_asset_kind_not_null"
down_revision = "0110_unclassified_kind"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text(
            "UPDATE assets_3d SET kind_id = 'unclassified' "
            "WHERE kind_id IS NULL OR kind_id = 'none'"
        )
    )
    op.alter_column(
        "assets_3d",
        "kind_id",
        existing_type=sa.Text(),
        nullable=False,
        server_default="unclassified",
    )


def downgrade() -> None:
    op.alter_column(
        "assets_3d",
        "kind_id",
        existing_type=sa.Text(),
        nullable=True,
        server_default=None,
    )
