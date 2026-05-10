"""Backfill fiber Component.properties.radiusMm 1.5 -> 0.5 (1 mm diameter)

Revision ID: 0022_fiber_radius_1mm_default
Revises: 0021_aom_default_anchors

User asked for the default fiber jacket diameter to be 1 mm rather than the
3 mm look the seed defaulted to (radius 1.5 mm). The frontend renderer +
seed.py + per-component fiber-edit overlay all default to 0.5 mm now; this
migration brings existing DB rows in line.

The update is conservative: only fiber components whose `radiusMm` is
exactly 1.5 (the old default) are rewritten. Fibers the user already
adjusted via the Jacket-radius slider keep their custom value.

`downgrade()` restores 0.5 -> 1.5 on the same conservative criterion so
rollback doesn't clobber any user changes made between deploys.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0022_fiber_radius_1mm"
down_revision = "0021_aom_default_anchors"
branch_labels = None
depends_on = None


_OLD_DEFAULT = 1.5
_NEW_DEFAULT = 0.5


def _rewrite(from_value: float, to_value: float) -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT id, properties FROM components "
            "WHERE component_type = 'fiber' AND properties IS NOT NULL"
        )
    ).fetchall()
    for row in rows:
        props = row.properties
        if not isinstance(props, dict):
            continue
        current = props.get("radiusMm")
        # Strict equality on float — only touch rows still on the old
        # default. User-set radii (e.g. 0.9, 2.0, 3.0) are left alone.
        if not isinstance(current, (int, float)):
            continue
        if abs(float(current) - from_value) > 1e-9:
            continue
        new_props = dict(props)
        new_props["radiusMm"] = to_value
        bind.execute(
            sa.text(
                "UPDATE components SET properties = CAST(:p AS JSONB) WHERE id = :cid"
            ),
            {"p": json.dumps(new_props), "cid": row.id},
        )


def upgrade() -> None:
    _rewrite(_OLD_DEFAULT, _NEW_DEFAULT)


def downgrade() -> None:
    _rewrite(_NEW_DEFAULT, _OLD_DEFAULT)
