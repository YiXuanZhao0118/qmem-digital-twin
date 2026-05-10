"""Backfill fiber Component.properties.fiberAnchors with intercept_in / out

Revision ID: 0024_fiber_anchors_default
Revises: 0023_fiber_radius_r1

2026-05-09: fiber finally joins the standard anchor model. The optical port
positions (where the mode exits the ferrule) move from the legacy
`OpticalElement.kindParams.endA/B.facePositionMmBodyLocal` (Layer 4) to
`Component.properties.fiberAnchors[]` (Layer 2 — chip-intrinsic geometry).

Storage rationale: fiber has no Asset3D, so anchors can't live on
`assets.anchors` like every other kind. Each fiber has a 1:1 component
template (1 component = 1 placed object), so storing on Component.properties
behaves like per-instance per-physical-unit anyway.

Migration strategy:
- For every fiber Component, build the two AssetAnchor records
  (intercept_in and intercept_out).
- Position: pull from kindParams.endA/B.facePositionMmBodyLocal if a value
  is set there (legacy data from FiberInspector); otherwise use the
  ferrule-tip default (0, 36.28, 0) in connector body-local mm.
- Direction: outward = (0, 1, 0) — connector body-local +Y points along
  the ferrule axis.
- apertureMm: 2.5 — the FC ferrule's metal-sleeve OD (geometric clipping
  aperture, NOT the mode-field diameter).
- Idempotent: rows that already have a non-empty fiberAnchors are
  skipped.

`downgrade()` removes the fiberAnchors key (legacy kindParams data is left
in place by upgrade(), so downgrade just drops what upgrade added).
"""

from __future__ import annotations

import json
from typing import Any

import sqlalchemy as sa

from alembic import op


revision = "0024_fiber_anchors"
down_revision = "0023_fiber_radius_r1"
branch_labels = None
depends_on = None


_DEFAULT_FERRULE_TIP = {"x": 0.0, "y": 36.28, "z": 0.0}
_DEFAULT_OUTWARD = {"x": 0.0, "y": 1.0, "z": 0.0}
_DEFAULT_APERTURE_MM = 2.5


def _legacy_face_pos(opt_el_kp: dict, end: str) -> dict:
    """Return facePositionMmBodyLocal from the legacy kindParams.endA/B path,
    or the ferrule-tip default. Coerces shape errors silently."""
    end_kp = opt_el_kp.get(end) if isinstance(opt_el_kp, dict) else None
    if not isinstance(end_kp, dict):
        return dict(_DEFAULT_FERRULE_TIP)
    raw = end_kp.get("facePositionMmBodyLocal")
    if not isinstance(raw, dict):
        return dict(_DEFAULT_FERRULE_TIP)
    out = {}
    for k in ("x", "y", "z"):
        v = raw.get(k)
        out[k] = float(v) if isinstance(v, (int, float)) else _DEFAULT_FERRULE_TIP[k]
    return out


def _build_anchor(anchor_id: str, position: dict) -> dict[str, Any]:
    return {
        "id": anchor_id,
        "positionMmBodyLocal": position,
        "directionBodyLocal": dict(_DEFAULT_OUTWARD),
        "apertureMm": _DEFAULT_APERTURE_MM,
    }


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            """
            SELECT
                c.id AS component_id,
                c.properties AS component_properties,
                COALESCE(
                    (
                        SELECT oe.kind_params
                        FROM optical_elements oe
                        JOIN objects so ON so.id = oe.object_id
                        WHERE so.component_id = c.id
                        LIMIT 1
                    ),
                    '{}'::jsonb
                ) AS opt_kind_params
            FROM components c
            WHERE c.component_type = 'fiber'
            """
        )
    ).fetchall()
    for row in rows:
        props = row.component_properties or {}
        if not isinstance(props, dict):
            continue
        existing = props.get("fiberAnchors")
        if isinstance(existing, list) and len(existing) > 0:
            # Already migrated — leave as-is (idempotent).
            continue
        kp = row.opt_kind_params or {}
        if not isinstance(kp, dict):
            kp = {}
        fiber_anchors = [
            _build_anchor("intercept_in", _legacy_face_pos(kp, "endA")),
            _build_anchor("intercept_out", _legacy_face_pos(kp, "endB")),
        ]
        new_props = dict(props)
        new_props["fiberAnchors"] = fiber_anchors
        bind.execute(
            sa.text(
                "UPDATE components SET properties = CAST(:p AS JSONB) WHERE id = :cid"
            ),
            {"p": json.dumps(new_props), "cid": row.component_id},
        )


def downgrade() -> None:
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
        if "fiberAnchors" not in props:
            continue
        new_props = dict(props)
        new_props.pop("fiberAnchors", None)
        bind.execute(
            sa.text(
                "UPDATE components SET properties = CAST(:p AS JSONB) WHERE id = :cid"
            ),
            {"p": json.dumps(new_props), "cid": row.id},
        )
