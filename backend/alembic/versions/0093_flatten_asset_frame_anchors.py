"""Flatten Asset3D body-frame transform into asset-local anchors.

Revision ID: 0093_flatten_asset_frame_anchors
Revises: 0092_kind_multi_domain

The runtime frame model is now:

    Lab frame <- SceneObject pose <- ComponentBinding pose <- Asset/CAD anchor

There is no separate Asset3D body frame at runtime.  Existing rows that
used ``body_frame_rotation`` and/or ``properties.bodyFramePositionMm`` are
baked into the stored anchor coordinates, then the transform fields are
removed.
"""

from __future__ import annotations

import math
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op


revision = "0093_flatten_asset_frame_anchors"
down_revision = "0092_kind_multi_domain"
branch_labels = None
depends_on = None


def _vec(value: Any) -> tuple[float, float, float] | None:
    if not isinstance(value, dict):
        return None
    try:
        return (
            float(value.get("x", 0) or 0),
            float(value.get("y", 0) or 0),
            float(value.get("z", 0) or 0),
        )
    except (TypeError, ValueError):
        return None


def _dict_vec(value: tuple[float, float, float]) -> dict[str, float]:
    return {"x": value[0], "y": value[1], "z": value[2]}


def _quat(value: Any) -> tuple[float, float, float, float] | None:
    if not isinstance(value, dict):
        return None
    try:
        qx = float(value.get("x", 0) or 0)
        qy = float(value.get("y", 0) or 0)
        qz = float(value.get("z", 0) or 0)
        qw = float(value.get("w", 1) if value.get("w") is not None else 1)
    except (TypeError, ValueError):
        return None
    norm = math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
    if norm <= 0:
        return None
    return (qx / norm, qy / norm, qz / norm, qw / norm)


def _is_identity_quat(q: tuple[float, float, float, float] | None) -> bool:
    if q is None:
        return True
    qx, qy, qz, qw = q
    return (
        abs(qx) < 1e-12
        and abs(qy) < 1e-12
        and abs(qz) < 1e-12
        and abs(abs(qw) - 1) < 1e-12
    )


def _rotate(q: tuple[float, float, float, float] | None, v: tuple[float, float, float]) -> tuple[float, float, float]:
    if _is_identity_quat(q):
        return v
    assert q is not None
    qx, qy, qz, qw = q
    vx, vy, vz = v
    c1x = qy * vz - qz * vy
    c1y = qz * vx - qx * vz
    c1z = qx * vy - qy * vx
    tx = c1x + qw * vx
    ty = c1y + qw * vy
    tz = c1z + qw * vz
    c2x = qy * tz - qz * ty
    c2y = qz * tx - qx * tz
    c2z = qx * ty - qy * tx
    return (vx + 2 * c2x, vy + 2 * c2y, vz + 2 * c2z)


def _add(a: tuple[float, float, float], b: tuple[float, float, float]) -> tuple[float, float, float]:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _bake_anchor(anchor: Any, q: tuple[float, float, float, float] | None, bfp: tuple[float, float, float]) -> Any:
    if not isinstance(anchor, dict):
        return anchor
    out = dict(anchor)
    for key in ("positionMmBodyLocal", "position_mm_body_local"):
        pos = _vec(out.get(key))
        if pos is not None:
            out[key] = _dict_vec(_add(_rotate(q, pos), bfp))
    for key in (
        "directionBodyLocal",
        "direction_body_local",
        "axisXBodyLocal",
        "axisYBodyLocal",
        "axisZBodyLocal",
        "normalBodyLocal",
        "normal_body_local",
    ):
        direction = _vec(out.get(key))
        if direction is not None:
            out[key] = _dict_vec(_rotate(q, direction))
    return out


def _bake_list(items: Any, q: tuple[float, float, float, float] | None, bfp: tuple[float, float, float]) -> Any:
    if not isinstance(items, list):
        return items
    return [_bake_anchor(item, q, bfp) for item in items]


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id, anchors, faces, properties, body_frame_rotation FROM assets_3d")).mappings()
    for row in rows:
        props = dict(row["properties"] or {})
        bfp = _vec(props.get("bodyFramePositionMm")) or (0.0, 0.0, 0.0)
        q = _quat(row["body_frame_rotation"])

        anchors = row["anchors"]
        faces = row["faces"]
        if not _is_identity_quat(q) or any(abs(v) > 1e-12 for v in bfp):
            anchors = _bake_list(anchors, q, bfp)
            faces = _bake_list(faces, q, bfp)

        props.pop("bodyFramePositionMm", None)
        bind.execute(
            sa.text(
                "UPDATE assets_3d "
                "SET anchors = :anchors, faces = :faces, properties = :properties "
                "WHERE id = :id"
            ).bindparams(
                sa.bindparam("anchors", type_=JSONB),
                sa.bindparam("faces", type_=JSONB),
                sa.bindparam("properties", type_=JSONB),
            ),
            {"id": row["id"], "anchors": anchors, "faces": faces, "properties": props},
        )

    op.drop_column("assets_3d", "body_frame_rotation")


def downgrade() -> None:
    op.add_column("assets_3d", sa.Column("body_frame_rotation", JSONB(), nullable=True))
