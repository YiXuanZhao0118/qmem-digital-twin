"""Phase 9.1 — add ``anchors`` JSONB column to ``assets_3d``

Revision ID: 0087_assets_anchors
Revises: 0086_kinds_table

Introduces the anchor-centric Asset3D schema (replaces faces[] +
transitions[] as the primary physics anchor structure). Each anchor =
{id, positionMmBodyLocal, axisXBodyLocal, axisYBodyLocal,
 axisZBodyLocal, apertureMm, apertureShape}.

This migration ADDS the column with default `'[]'`. Backfill is a
separate Python script (scripts/backfill_asset_anchors.py) so the
per-kind conversion logic can iterate without churning migrations.

`faces` and `transitions` remain in parallel; Phase 9.8 drops them
after the tracer + ops have been rewritten to consume `anchors`.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op


revision = "0087_assets_anchors"
down_revision = "0086_kinds_table"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ``anchors`` column already exists from legacy v1/v2 (carried forward
    # since the original schema). This migration is a version bump that
    # marks the column as the canonical Phase 9 anchor-centric store; the
    # data transformation happens in scripts/backfill_asset_anchors.py
    # (idempotent — safe to re-run as Rule 1-5 evolves).
    pass


def downgrade() -> None:
    # No DDL change to revert. Reverting anchor DATA is a manual rollback
    # via the backfill script with --from-legacy-anchors mode.
    pass
