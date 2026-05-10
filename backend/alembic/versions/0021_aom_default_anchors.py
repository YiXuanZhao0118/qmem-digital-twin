"""seed default intercept_in / intercept_out anchors on existing AOM assets

Revision ID: 0021_aom_default_anchors
Revises: 0020_norm_comp_props

Phase 7 of the AOM align rewrite: the previous align algorithm used a
6-face bbox of the wrapper geometry to find which face the beam should
enter. The new algorithm requires the asset to declare two semantic
anchors — `intercept_in` and `intercept_out` — with an `apertureMm`
on each. The user-defined entry/exit ports then drive both align target
selection (whichever the upstream beam reaches first) and the Bragg
rotation pivot (midpoint = acousto-optic interaction point).

Backfill strategy
-----------------
For every Asset3D row that backs at least one Component of type "aom":

* If the asset already has BOTH `intercept_in` and `intercept_out`
  anchors → leave it alone (idempotent).

* Otherwise, derive defaults from the AOM Component's properties:

  - `bodyLengthMm` (or `dimensionsMm[0]`) gives the body length.
  - `opticalAxisFromEndMm` (typical 18 mm for MT80) puts each port at
    `±(bodyLengthMm/2 - opticalAxisFromEndMm)` along the body Y axis
    (Blender frame → Y forward, Z up). Falls back to the body ends.
  - `opticalAxisHeightMm` (8 mm for MT80) sits the optical axis above
    the housing bottom. The anchor Z is set so the axis lies on the
    body's geometric centre (`heightMm/2 - opticalAxisHeightMm`); for
    GLB authored at the optical axis (= 0) this resolves to 0.
  - Aperture defaults to `activeApertureMm` (1.5 mm for MT80) /2
    interpreted as a half-aperture radius; falls back to
    `clearApertureMm/2` then `min(dimensionsMm)/4`, finally to 1.0 mm.

After this migration, opening the PHY Editor for an AOM shows the two
ports already placed at sensible locations; users can refine in the
viewport. Without this backfill, every existing AOM would refuse to
align (the new contract makes both anchors required).

Idempotent: re-running this migration is a no-op for assets that
already carry a complete (intercept_in, intercept_out) pair.

Downgrade
---------
Removes any anchor whose `id` is in {intercept_in, intercept_out} from
AOM assets. This is destructive of user-edited anchors, so downgrade
should only be run in dev — but it is symmetric with the upgrade so
the migration history stays consistent.
"""

from __future__ import annotations

import json
from typing import Any

import sqlalchemy as sa

from alembic import op


revision = "0021_aom_default_anchors"
down_revision = "0020_norm_comp_props"
branch_labels = None
depends_on = None


_PORT_IDS = ("intercept_in", "intercept_out")


def _coerce_number(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def _derive_anchor_geometry(props: dict[str, Any]) -> dict[str, float]:
    """Pick anchor coordinates + aperture from Component.properties.

    Returns a dict with:
      * `body_y_offset` — Blender +Y mm; the distance from body-local
        centre to each anchor along the optical axis (anchor positions
        will be ±body_y_offset).
      * `aperture_mm` — radius / half-width of active aperture in mm.

    Convention assumed: GLB authored with optical axis along body +Y, no
    z-offset (`apertureForwardMmBodyLocal` not used → wrapper anchor =
    GLB bbox centre, so anchor positions are measured from bbox centre).
    Users with non-standard GLB conventions can tune in PHY Editor.

    Property precedence:
      1. `dimensionsMm[0]` = housing length → use with
         `opticalAxisFromEndMm` (typically the spec's "axis is N mm in
         from each end" — measured from housing end).
      2. `bodyLengthMm` = inner body, fallback when housing length is
         missing.
      3. Generic 50 mm fallback when neither is set.
    """
    dims = props.get("dimensionsMm") if isinstance(props.get("dimensionsMm"), list) else None

    housing_length_mm: float | None = None
    if dims and len(dims) >= 1 and _coerce_number(dims[0]) is not None:
        housing_length_mm = float(dims[0])
    body_length_mm = _coerce_number(props.get("bodyLengthMm"))
    length_for_anchors_mm = housing_length_mm if housing_length_mm is not None else body_length_mm
    if length_for_anchors_mm is None:
        length_for_anchors_mm = 50.0

    optical_axis_from_end_mm = _coerce_number(props.get("opticalAxisFromEndMm"))
    if optical_axis_from_end_mm is None:
        optical_axis_from_end_mm = 0.0

    body_y_offset = length_for_anchors_mm / 2.0 - optical_axis_from_end_mm
    if body_y_offset < length_for_anchors_mm / 8.0:
        # Safety floor so bad property combinations don't collapse the
        # two anchors onto each other (collapsed pivot = midpoint
        # equation degenerates).
        body_y_offset = length_for_anchors_mm / 4.0

    aperture_mm = _coerce_number(props.get("activeApertureMm"))
    if aperture_mm is not None:
        aperture_mm = aperture_mm / 2.0
    else:
        clear = _coerce_number(props.get("clearApertureMm"))
        if clear is not None:
            aperture_mm = clear / 2.0
        elif dims:
            shortest = min(
                (float(d) for d in dims if _coerce_number(d) is not None),
                default=4.0,
            )
            aperture_mm = shortest / 4.0
        else:
            aperture_mm = 1.0

    return {
        "body_y_offset": float(body_y_offset),
        "aperture_mm": float(aperture_mm),
    }


def _build_default_port_anchors(props: dict[str, Any]) -> list[dict[str, Any]]:
    geom = _derive_anchor_geometry(props)
    bo = geom["body_y_offset"]
    ap = geom["aperture_mm"]
    return [
        {
            "id": "intercept_in",
            "positionMmBodyLocal": {"x": 0.0, "y": -bo, "z": 0.0},
            "directionBodyLocal": {"x": 0.0, "y": 1.0, "z": 0.0},
            "apertureMm": ap,
        },
        {
            "id": "intercept_out",
            "positionMmBodyLocal": {"x": 0.0, "y": bo, "z": 0.0},
            "directionBodyLocal": {"x": 0.0, "y": -1.0, "z": 0.0},
            "apertureMm": ap,
        },
    ]


def _existing_ids(anchors: list[Any]) -> set[str]:
    out: set[str] = set()
    for a in anchors:
        if isinstance(a, dict) and isinstance(a.get("id"), str):
            out.add(a["id"])
    return out


def upgrade() -> None:
    bind = op.get_bind()
    # Find every Asset3D row backing at least one AOM Component. Joining
    # via component_type keeps the migration narrowly scoped — non-AOM
    # assets (mirrors, lenses, primitives) are not touched.
    rows = bind.execute(
        sa.text(
            """
            SELECT DISTINCT a.id          AS asset_id,
                            a.anchors     AS anchors,
                            c.properties  AS properties
              FROM assets_3d a
              JOIN components c ON c.asset_3d_id = a.id
             WHERE c.component_type = 'aom'
            """
        )
    ).fetchall()

    for row in rows:
        anchors = list(row.anchors or [])
        existing = _existing_ids(anchors)
        if all(pid in existing for pid in _PORT_IDS):
            continue
        defaults = _build_default_port_anchors(row.properties or {})
        for d in defaults:
            if d["id"] not in existing:
                anchors.append(d)
        bind.execute(
            sa.text(
                "UPDATE assets_3d SET anchors = CAST(:new AS JSONB) WHERE id = :id"
            ),
            {"new": json.dumps(anchors), "id": row.asset_id},
        )


def downgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            """
            SELECT DISTINCT a.id      AS asset_id,
                            a.anchors AS anchors
              FROM assets_3d a
              JOIN components c ON c.asset_3d_id = a.id
             WHERE c.component_type = 'aom'
            """
        )
    ).fetchall()

    for row in rows:
        anchors = list(row.anchors or [])
        filtered = [
            a for a in anchors
            if not (isinstance(a, dict) and a.get("id") in _PORT_IDS)
        ]
        if filtered == anchors:
            continue
        bind.execute(
            sa.text(
                "UPDATE assets_3d SET anchors = CAST(:new AS JSONB) WHERE id = :id"
            ),
            {"new": json.dumps(filtered), "id": row.asset_id},
        )
