"""app_settings — shared singleton key/value settings.

First consumer: ``room_dimensions`` (Initial Setup). Was previously
client-side localStorage in App.tsx, which meant every browser had its
own room size; users now share one row stored on the backend so the
3D scene is identical for everyone.

The table is intentionally generic (text key + JSONB value) so future
Initial Setup fields can be added without a migration. Defaults are
not seeded here — the router returns built-in defaults when the row
is absent, which keeps the default values in one place (the API code).

Revision ID: 0043_app_settings
Revises: 0042_rename_optical_elements
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision = "0043_app_settings"
down_revision = "0042_rename_optical_elements"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "app_settings",
        sa.Column("key", sa.Text(), primary_key=True),
        sa.Column(
            "value",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )


def downgrade() -> None:
    op.drop_table("app_settings")
