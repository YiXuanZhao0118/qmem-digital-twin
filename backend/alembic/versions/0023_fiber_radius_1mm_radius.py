"""Backfill fiber Component.properties.radiusMm 0.5 -> 1.0 (1 mm radius)

Revision ID: 0023_fiber_radius_1mm_radius
Revises: 0022_fiber_radius_1mm

Follow-up to 0022. The user originally asked for "1 mm" fiber and 0022
read it as diameter (radius 0.5 mm). They clarified "半徑 1mm" — they
meant 1 mm radius (= 2 mm diameter). The frontend defaults + seed.py
were also corrected from 0.5 to 1.0; this migration brings existing DB
rows in line.

Same conservative criterion as 0022: only fibers whose radiusMm is
exactly 0.5 (the brief intermediate default introduced in 0022) get
updated. Anything else — including any user-set custom value — is left
alone.

`downgrade()` reverses 1.0 -> 0.5 on the same conservative criterion.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0023_fiber_radius_r1"
down_revision = "0022_fiber_radius_1mm"
branch_labels = None
depends_on = None


_OLD_DEFAULT = 0.5
_NEW_DEFAULT = 1.0


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
