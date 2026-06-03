"""Add an ``acoustic_axis`` anchor to AOM Asset3D rows.

The Bragg diffraction orders fan along the acoustic (RF traveling-wave)
propagation direction, which is perpendicular to the optical axis
(intercept_in -> intercept_out). That direction used to live only as the
``rfPropagationDirectionBodyLocal`` param; this promotes it to a dedicated,
first-class, visualizable anchor ``acoustic_axis`` whose ``axisX`` IS the
acoustic direction (distinct from ``rf_in``, the cable connector).

Seeded from ``rfPropagationDirectionBodyLocal`` projected perpendicular to the
optical axis, positioned at the crystal centre. Idempotent: rows that already
carry an ``acoustic_axis`` anchor are left untouched.
"""

from __future__ import annotations

import json
import math
from typing import Any, Optional

import sqlalchemy as sa
from alembic import op

revision = "0099_aom_acoustic_axis_anchor"
down_revision = "0098_rf_anchor_connector_type"
branch_labels = None
depends_on = None


Vec = tuple


def _vec(d: dict) -> Vec:
    return (float(d.get("x", 0.0)), float(d.get("y", 0.0)), float(d.get("z", 0.0)))


def _dot(a: Vec, b: Vec) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _sub(a: Vec, b: Vec) -> Vec:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _scale(a: Vec, s: float) -> Vec:
    return (a[0] * s, a[1] * s, a[2] * s)


def _cross(a: Vec, b: Vec) -> Vec:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _norm(a: Vec) -> Vec:
    m = math.sqrt(_dot(a, a))
    return (a[0] / m, a[1] / m, a[2] / m) if m > 1e-12 else a


def _vd(a: Vec) -> dict:
    return {"x": a[0], "y": a[1], "z": a[2]}


def _by_id(anchors: list, aid: str) -> Optional[dict]:
    return next((x for x in anchors if isinstance(x, dict) and x.get("id") == aid), None)


def _transverse(axis_x: Vec) -> tuple[Vec, Vec]:
    for c in [(0.0, 1.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0)]:
        d = _dot(c, axis_x)
        proj = _sub(c, _scale(axis_x, d))
        if _dot(proj, proj) > 1e-9:
            ay = _norm(proj)
            return ay, _norm(_cross(axis_x, ay))
    return (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT id, anchors, default_params FROM assets_3d WHERE kind_id = 'aom'"
        )
    ).mappings().fetchall()

    for row in rows:
        anchors: list[Any] = list(row["anchors"] or [])
        if not anchors or _by_id(anchors, "acoustic_axis"):
            continue  # nothing to anchor on, or idempotent skip
        params = row["default_params"] or {}
        rf = params.get("rfPropagationDirectionBodyLocal")
        if not (isinstance(rf, (list, tuple)) and len(rf) == 3):
            continue
        rf_dir = (float(rf[0]), float(rf[1]), float(rf[2]))

        ic = _by_id(anchors, "interaction_center")
        a_in = _by_id(anchors, "intercept_in")
        a_out = _by_id(anchors, "intercept_out")

        # Optical axis (in -> out).
        if ic and ic.get("axisXBodyLocal"):
            optical = _norm(_vec(ic["axisXBodyLocal"]))
        elif a_in and a_in.get("axisXBodyLocal"):
            optical = _norm(_vec(a_in["axisXBodyLocal"]))
        elif a_in and a_out:
            optical = _norm(_sub(_vec(a_out["positionMmBodyLocal"]),
                                 _vec(a_in["positionMmBodyLocal"])))
        else:
            continue

        # Acoustic direction = rf_dir projected perpendicular to the optical axis.
        d = _dot(rf_dir, optical)
        a_perp = _sub(rf_dir, _scale(optical, d))
        if _dot(a_perp, a_perp) < 1e-12:
            continue
        acoustic = _norm(a_perp)

        # Position = crystal centre.
        if ic and ic.get("positionMmBodyLocal"):
            pos = _vec(ic["positionMmBodyLocal"])
        elif a_in and a_out:
            pi = _vec(a_in["positionMmBodyLocal"])
            po = _vec(a_out["positionMmBodyLocal"])
            pos = ((pi[0] + po[0]) / 2, (pi[1] + po[1]) / 2, (pi[2] + po[2]) / 2)
        else:
            pos = (0.0, 0.0, 0.0)

        ay, az = _transverse(acoustic)
        anchors.append({
            "id": "acoustic_axis",
            "positionMmBodyLocal": _vd(pos),
            "axisXBodyLocal": _vd(acoustic),
            "axisYBodyLocal": _vd(ay),
            "axisZBodyLocal": _vd(az),
            "apertureMm": 0.0,
            "apertureShape": "circle",
        })
        bind.execute(
            sa.text("UPDATE assets_3d SET anchors = CAST(:a AS JSONB) WHERE id = :id"),
            {"a": json.dumps(anchors), "id": row["id"]},
        )


def downgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text("SELECT id, anchors FROM assets_3d WHERE kind_id = 'aom'")
    ).mappings().fetchall()
    for row in rows:
        anchors = list(row["anchors"] or [])
        kept = [x for x in anchors
                if not (isinstance(x, dict) and x.get("id") == "acoustic_axis")]
        if len(kept) != len(anchors):
            bind.execute(
                sa.text("UPDATE assets_3d SET anchors = CAST(:a AS JSONB) WHERE id = :id"),
                {"a": json.dumps(kept), "id": row["id"]},
            )
