"""Add ``locked`` flag to kinds + assets_3d.

A locked row is one a human has reviewed and frozen ("confirmed complete,
do not adjust"). The PHY Editor renders it read-only and the API rejects
any write that changes a field other than ``locked`` itself (so a locked
row can still be unlocked, but nothing else can be patched while locked).
The flag also signals automated agents not to touch the row — see the
"locked" convention in CLAUDE.md / docs/introduce/kinds.md.

Boolean NOT NULL DEFAULT false on both tables; every existing row starts
unlocked.

Revision ID: 0112_add_locked_flag
Revises: 0111_asset_kind_not_null
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op


revision = "0112_add_locked_flag"
down_revision = "0111_asset_kind_not_null"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for table in ("kinds", "assets_3d"):
        op.add_column(
            table,
            sa.Column(
                "locked",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )


def downgrade() -> None:
    for table in ("kinds", "assets_3d"):
        op.drop_column(table, "locked")
