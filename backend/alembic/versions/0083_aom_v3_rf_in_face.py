"""Add v3 rf_in face to AOM Asset3D rows (Phase RF.2 increment)

Revision ID: 0083_aom_v3_rf_in_face
Revises: 0082_v3_physics

Per asset-physics-model.md §14.1, an AOM Asset3D must carry three faces —
two optical (A / B along the body +z optical axis) and one RF sink
(`rf_in`, domain="rf", normal perpendicular to the A→B axis). The legacy
side-channel `defaultParams.rfPropagationDirectionBodyLocal` is now
superseded by `rf_in.normalBodyLocal`; the legacy field stays for
back-compat but the face is the source of truth.

Backfill strategy
-----------------
For every assets_3d row with `physics_kind = 'aom'`:

* If `faces` already contains an entry with `id = "rf_in"` → skip
  (idempotent — re-running this migration is a no-op).

* Otherwise, append:
    {
      "id": "rf_in",
      "domain": "rf",
      "positionMmBodyLocal": offset * dir,
      "normalBodyLocal": dir,          // unit-normalised
      "apertureMm": 0,
      "apertureShape": "circle"
    }
  where:
    - `dir` = defaultParams.rfPropagationDirectionBodyLocal
              (fallback (1, 0, 0) — body +x is the AOM acoustic axis convention)
    - `offset` = defaultParams.transducerOffsetFromCenterMmX
                 (fallback 15.0 mm — typical MT80 housing half-width minus wall)

The new face does NOT appear in `transitions[]` — rf_in is an RF sink
read by the AOM PhysicsOp from §7.5 RF tracer's `signalAtPort`, not
a ray-tracer entry/exit face.

Idempotent. Downgrade removes any face with `id = "rf_in"` from AOM rows
(destructive of user-edited rf_in face placements — dev-only).

Row selection
-------------
Match by EITHER ``a.physics_kind = 'aom'`` (v3 source of truth, used by
catalog-id rows that may not have a backing Component) OR
``c.component_type = 'aom'`` (legacy source of truth, used by every
GLB-backed AOM Component). Some DBs have orphan v3 rows (catalog_id set
but no Component pointing to them — created via the PHY Editor's v3
PUT flow) and some have legacy rows (Component points to an Asset3D
whose ``physics_kind`` is still null because v3 hasn't been edited
yet). The OR matches both and the per-row idempotency guard prevents
double-insertion.
"""

from __future__ import annotations

import json
import math
from typing import Any

import sqlalchemy as sa

from alembic import op


revision = "0083_aom_v3_rf_in_face"
down_revision = "0082_v3_physics"
branch_labels = None
depends_on = None


_RF_IN_ID = "rf_in"
_DEFAULT_OFFSET_MM = 15.0
_DEFAULT_DIR = (1.0, 0.0, 0.0)


def _coerce_number(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def _coerce_vec3(value: Any) -> tuple[float, float, float] | None:
    if isinstance(value, list) and len(value) == 3:
        coerced = [_coerce_number(v) for v in value]
        if all(v is not None for v in coerced):
            return (coerced[0], coerced[1], coerced[2])  # type: ignore[return-value]
    if isinstance(value, dict):
        x = _coerce_number(value.get("x"))
        y = _coerce_number(value.get("y"))
        z = _coerce_number(value.get("z"))
        if x is not None and y is not None and z is not None:
            return (x, y, z)
    return None


def _normalise(v: tuple[float, float, float]) -> tuple[float, float, float]:
    norm = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
    if norm < 1e-12:
        return _DEFAULT_DIR
    return (v[0] / norm, v[1] / norm, v[2] / norm)


def _build_rf_in_face(default_params: dict[str, Any]) -> dict[str, Any]:
    raw_dir = default_params.get("rfPropagationDirectionBodyLocal")
    dir_vec = _coerce_vec3(raw_dir) or _DEFAULT_DIR
    dir_vec = _normalise(dir_vec)

    offset = _coerce_number(default_params.get("transducerOffsetFromCenterMmX"))
    if offset is None or offset <= 0:
        offset = _DEFAULT_OFFSET_MM

    return {
        "id": _RF_IN_ID,
        "domain": "rf",
        "positionMmBodyLocal": {
            "x": offset * dir_vec[0],
            "y": offset * dir_vec[1],
            "z": offset * dir_vec[2],
        },
        "normalBodyLocal": {
            "x": dir_vec[0],
            "y": dir_vec[1],
            "z": dir_vec[2],
        },
        "apertureMm": 0,
        "apertureShape": "circle",
    }


def _has_rf_in(faces: list[Any]) -> bool:
    for face in faces:
        if isinstance(face, dict) and face.get("id") == _RF_IN_ID:
            return True
    return False


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            """
            SELECT DISTINCT a.id             AS asset_id,
                            a.faces          AS faces,
                            a.default_params AS default_params,
                            c.properties     AS component_properties
              FROM assets_3d a
              LEFT JOIN components c ON c.asset_3d_id = a.id
             WHERE a.physics_kind = 'aom' OR c.component_type = 'aom'
            """
        )
    ).fetchall()

    for row in rows:
        faces = list(row.faces or [])
        if _has_rf_in(faces):
            continue
        # Prefer asset-level default_params (the v3 source of truth for
        # this field); fall back to component.properties for pre-v3 rows
        # whose direction lived in kindParams.
        params: dict[str, Any] = {}
        if row.default_params:
            params.update(row.default_params)
        if row.component_properties and "rfPropagationDirectionBodyLocal" not in params:
            cp_dir = (row.component_properties or {}).get(
                "rfPropagationDirectionBodyLocal"
            )
            if cp_dir is not None:
                params["rfPropagationDirectionBodyLocal"] = cp_dir
        faces.append(_build_rf_in_face(params))
        bind.execute(
            sa.text(
                "UPDATE assets_3d SET faces = CAST(:new AS JSONB) WHERE id = :id"
            ),
            {"new": json.dumps(faces), "id": row.asset_id},
        )


def downgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            """
            SELECT DISTINCT a.id    AS asset_id,
                            a.faces AS faces
              FROM assets_3d a
              LEFT JOIN components c ON c.asset_3d_id = a.id
             WHERE a.physics_kind = 'aom' OR c.component_type = 'aom'
            """
        )
    ).fetchall()

    for row in rows:
        faces = list(row.faces or [])
        filtered = [
            f for f in faces
            if not (isinstance(f, dict) and f.get("id") == _RF_IN_ID)
        ]
        if filtered == faces:
            continue
        bind.execute(
            sa.text(
                "UPDATE assets_3d SET faces = CAST(:new AS JSONB) WHERE id = :id"
            ),
            {"new": json.dumps(filtered), "id": row.asset_id},
        )
