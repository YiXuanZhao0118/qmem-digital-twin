"""Backfill the ``acoustic_axis`` anchor on every AOM asset.

Since 2026-06-03 the acoustic propagation direction has a dedicated
``acoustic_axis`` anchor whose ``axisX`` is the single source of truth for
the Bragg fan direction — see ``anchor_ops/aom.py::_read_acoustic_dir`` and
``utils/objectBindings.ts::getRfDirectionBodyLocal``. Both resolvers still
fall back to the ``rfPropagationDirectionBodyLocal`` /
``acousticAxisBodyLocal`` params, with the frontend one saying so
explicitly: "so un-migrated rows keep working **until the alembic migration
drains them**". This is that migration; it was never written.

Nothing drained them because the ``kinds.aom.anchor_template`` that
``Asset3DEditor`` auto-seeds new assets from predated the anchor and so
never offered it (alembic 0126 fixed the template, but seeding is additive
and only fires on assets that lack the id — it does not revisit an asset
the user already saved). The result: ``aa_mt80_a1_5_ir``, the only AOM in
the catalog, has carried ``[intercept_in, intercept_out, rf_in]`` the whole
time and the Bragg solver has been running on the legacy fallback.

Behaviour-preserving by construction: ``axisX`` is read from the very param
the fallback resolves today, so the anchor installs the direction the trace
already uses. What changes is that the direction now lives where the editor
can show and rotate it, and a re-seed of the asset stops silently dropping
back a tier.

Geometry:
  axisX     the asset's rfPropagationDirectionBodyLocal (else
            acousticAxisBodyLocal, else the kind default [-1, 0, 0]),
            normalised. For the MT80 this is [-1, 0, 0] — RF enters the
            SMA jack at body +x and the acoustic wave travels toward -x.
  position  midpoint of intercept_in / intercept_out = the Bragg
            interaction point the plugin's alignSummary names as the
            rotation pivot. Origin when those anchors are absent. The
            solver reads only axisX; this is for the editor gizmo.
  axisY/Z   orthonormal complement, built the same way
            ``services.device_seed._frame_from_axis_x`` builds one, so a
            later device re-seed reproduces these axes instead of fighting
            them.

No aperture: ``acoustic_axis`` is a direction-only role
(``kinds/aom/index.ts`` lists it under needs_direction, not
needs_aperture).

The legacy params stay. They remain the documented fallback for assets
this migration cannot reach, and ``aomAlign`` reads them on other paths.

Applies to every ``kind_id = 'aom'`` asset missing the anchor, ``locked``
included — the flag guards the API layer, and leaving the catalog's one AOM
un-migrated because a human ticked "confirmed" would defeat the point.
Idempotent: an asset that already has the anchor is skipped.

Revision ID: 0127_aom_acoustic_axis_anchor
Revises: 0126_kinds_manifest_resync
"""

from __future__ import annotations

import json
import logging
import math

import sqlalchemy as sa

from alembic import op


revision = "0127_aom_acoustic_axis_anchor"
down_revision = "0126_kinds_manifest_resync"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

ANCHOR_ID = "acoustic_axis"
PORT_IDS = ("intercept_in", "intercept_out")
# kinds/aom/index.ts defaultParams — the MT80 convention, and what
# _read_acoustic_dir lands on when an asset declares neither param.
FALLBACK_AXIS = (-1.0, 0.0, 0.0)

Vec3 = tuple[float, float, float]


def _normalize(v: Vec3, fallback: Vec3 = FALLBACK_AXIS) -> Vec3:
    n = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    return fallback if n < 1e-9 else (v[0] / n, v[1] / n, v[2] / n)


def _cross(a: Vec3, b: Vec3) -> Vec3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _frame_from_axis_x(axis_x: Vec3) -> tuple[Vec3, Vec3, Vec3]:
    """Same construction as ``device_seed._frame_from_axis_x`` — kept in
    sync deliberately so a device re-seed reproduces these axes."""
    x = _normalize(axis_x)
    ref: Vec3 = (0.0, 0.0, 1.0)
    if abs(x[2]) > 0.9:
        ref = (0.0, 1.0, 0.0)
    y = _normalize(_cross(ref, x))
    z = _normalize(_cross(x, y))
    return x, y, z


def _acoustic_axis_from_params(params: dict) -> Vec3:
    """The direction ``_read_acoustic_dir`` resolves today, in the same
    param priority order."""
    for key in ("rfPropagationDirectionBodyLocal", "acousticAxisBodyLocal"):
        raw = params.get(key)
        if isinstance(raw, (list, tuple)) and len(raw) >= 3:
            try:
                return _normalize((float(raw[0]), float(raw[1]), float(raw[2])))
            except (TypeError, ValueError):
                continue
    return FALLBACK_AXIS


def _interaction_center(anchors: list[dict]) -> Vec3:
    """Midpoint of the two optical ports — the Bragg pivot."""
    by_id = {a.get("id"): a for a in anchors if isinstance(a, dict)}
    points: list[Vec3] = []
    for port in PORT_IDS:
        pos = (by_id.get(port) or {}).get("positionMmBodyLocal")
        if isinstance(pos, dict):
            try:
                points.append(
                    (float(pos.get("x", 0.0)), float(pos.get("y", 0.0)), float(pos.get("z", 0.0)))
                )
            except (TypeError, ValueError):
                pass
    if len(points) != len(PORT_IDS):
        return (0.0, 0.0, 0.0)
    n = float(len(points))
    return (
        sum(p[0] for p in points) / n,
        sum(p[1] for p in points) / n,
        sum(p[2] for p in points) / n,
    )


def _vec(v: Vec3) -> dict:
    return {"x": v[0], "y": v[1], "z": v[2]}


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "SELECT id, name, anchors, default_params FROM assets_3d "
            "WHERE kind_id = 'aom'"
        )
    ).mappings().fetchall()

    added = 0
    for row in rows:
        anchors = _as_list(row["anchors"])
        if any(isinstance(a, dict) and a.get("id") == ANCHOR_ID for a in anchors):
            continue

        params = _as_dict(row["default_params"])
        axis_x, axis_y, axis_z = _frame_from_axis_x(_acoustic_axis_from_params(params))
        anchors.append(
            {
                "id": ANCHOR_ID,
                "positionMmBodyLocal": _vec(_interaction_center(anchors)),
                "axisXBodyLocal": _vec(axis_x),
                "axisYBodyLocal": _vec(axis_y),
                "axisZBodyLocal": _vec(axis_z),
            }
        )
        conn.execute(
            sa.text("UPDATE assets_3d SET anchors = CAST(:a AS JSONB) WHERE id = :id"),
            {"a": json.dumps(anchors), "id": row["id"]},
        )
        added += 1
        log.info(
            "0127: %s -> acoustic_axis axisX=(%.3f, %.3f, %.3f)",
            row["name"],
            *axis_x,
        )

    log.info("0127: %d of %d aom asset(s) backfilled", added, len(rows))


def downgrade() -> None:
    """Exact inverse — drop the anchor and the resolvers fall back to the
    params, which this migration never touched."""
    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id, anchors FROM assets_3d WHERE kind_id = 'aom'")
    ).mappings().fetchall()

    for row in rows:
        anchors = _as_list(row["anchors"])
        kept = [a for a in anchors if not (isinstance(a, dict) and a.get("id") == ANCHOR_ID)]
        if len(kept) == len(anchors):
            continue
        conn.execute(
            sa.text("UPDATE assets_3d SET anchors = CAST(:a AS JSONB) WHERE id = :id"),
            {"a": json.dumps(kept), "id": row["id"]},
        )


def _as_list(value: object) -> list:
    """JSONB arrives as list or as a JSON str depending on the driver."""
    if isinstance(value, str):
        value = json.loads(value)
    return list(value) if isinstance(value, list) else []


def _as_dict(value: object) -> dict:
    if isinstance(value, str):
        value = json.loads(value)
    return dict(value) if isinstance(value, dict) else {}
