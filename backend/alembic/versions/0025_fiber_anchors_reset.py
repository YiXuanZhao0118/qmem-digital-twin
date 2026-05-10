"""Reset fiber Component.properties.fiberAnchors to ferrule-tip defaults

Revision ID: 0025_fiber_anchors_reset
Revises: 0024_fiber_anchors

2026-05-09 follow-up to 0024: the legacy backfill from
`OpticalElement.kindParams.endA/B.facePositionMmBodyLocal` turned out to
read polluted values (lab-frame spline endpoint coordinates with computed
unit-vector directions, not the connector body-local face position the
field name implied). Browser inspection showed every fiber ended up with
positions like (328, 0, 50) instead of the intended ferrule tip
(0, 36.28, 0).

Since fiber anchors had no proper editor before today, no user has
edited them — it's safe to overwrite ALL fiber anchors with defaults.
The new PHY Editor anchor flow lets the user adjust per-fiber from
here onward.

Heuristic guard: only reset positions that look "clearly wrong" — any
component of |x|, |y - 36.28|, or |z| greater than 30 mm. (A correctly
edited anchor stays within ~30 mm of the ferrule tip, since the FC
connector housing is ~36 mm long.) Anchors that are already plausible
are left untouched.
"""

from __future__ import annotations

import json
from typing import Any

import sqlalchemy as sa

from alembic import op


revision = "0025_fiber_anchors_rs"
down_revision = "0024_fiber_anchors"
branch_labels = None
depends_on = None


_DEFAULT_FERRULE_TIP = {"x": 0.0, "y": 36.28, "z": 0.0}
_DEFAULT_OUTWARD = {"x": 0.0, "y": 1.0, "z": 0.0}
_DEFAULT_APERTURE_MM = 2.5


def _looks_implausible(pos: dict | None) -> bool:
    """True if the position is outside ~30 mm of the ferrule tip in any
    axis, suggesting it was filled from polluted legacy data rather than
    a real user edit. Same threshold used by 0024 backfill."""
    if not isinstance(pos, dict):
        return True
    try:
        x = float(pos.get("x", 0))
        y = float(pos.get("y", 0))
        z = float(pos.get("z", 0))
    except (TypeError, ValueError):
        return True
    return abs(x) > 30 or abs(y - 36.28) > 30 or abs(z) > 30


def _default_anchor(anchor_id: str) -> dict[str, Any]:
    return {
        "id": anchor_id,
        "positionMmBodyLocal": dict(_DEFAULT_FERRULE_TIP),
        "directionBodyLocal": dict(_DEFAULT_OUTWARD),
        "apertureMm": _DEFAULT_APERTURE_MM,
    }


def upgrade() -> None:
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
        anchors = props.get("fiberAnchors")
        if not isinstance(anchors, list):
            anchors = []
        rebuilt: list[dict[str, Any]] = []
        any_changed = False
        for wanted_id in ("intercept_in", "intercept_out"):
            existing = next(
                (a for a in anchors if isinstance(a, dict) and a.get("id") == wanted_id),
                None,
            )
            if existing and not _looks_implausible(existing.get("positionMmBodyLocal")):
                rebuilt.append(existing)
            else:
                rebuilt.append(_default_anchor(wanted_id))
                any_changed = True
        if not any_changed and len(rebuilt) == len(anchors):
            continue
        new_props = dict(props)
        new_props["fiberAnchors"] = rebuilt
        bind.execute(
            sa.text(
                "UPDATE components SET properties = CAST(:p AS JSONB) WHERE id = :cid"
            ),
            {"p": json.dumps(new_props), "cid": row.id},
        )


def downgrade() -> None:
    # No-op: 0024's downgrade already drops fiberAnchors entirely. Nothing
    # this migration writes is preserved as "user data" worth rolling back.
    pass
