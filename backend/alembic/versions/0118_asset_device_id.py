"""Add assets_3d.device_id — the device-registry pointer.

RF_ARCHITECTURE_PLAN §2.3 / §6 Phase 2. Nullable Text column referencing a
device slug in the frontend `devices/` registry (mirrored to the kinds.json
`devices` block). When set, the PHY Editor seeds the asset's anchors from that
device's template and writes `kind_id` through from the device's
behavioralKind. The tracer keeps reading `anchors` directly, so this is a
metadata-only column add — no read-path change, no backfill (existing assets
stay device-less until a human assigns one in the editor).

Two-stage rollout (plan §7): this is stage 1 (add column + write-through
seed). Deriving kind at load time / dropping kind_id is a later, separate
migration.

Revision ID: 0118_asset_device_id
Revises: 0117_trim_connector_params
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op


revision = "0118_asset_device_id"
down_revision = "0117_trim_connector_params"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("assets_3d", sa.Column("device_id", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("assets_3d", "device_id")
