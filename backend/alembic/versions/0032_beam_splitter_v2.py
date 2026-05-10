"""V2 Phase 6: cut beam_splitter coating normal + PBS axis to bindings

Revision ID: 0032_bs_v2_cutover
Revises: 0031_lens_v2_split

V2 schema (docs/optical-schema-v2.md §3) puts the beam splitter's internal
coating normal on an ``opticalSurface`` binding instead of
``kindParams.coatingNormalBodyLocal``. When the splitter is polarising
(``polarizing=true``, i.e. PBS), the transmission-axis angle also moves
to a ``polarizationReference`` binding (role="transmission") — same
mechanism as the polarizer cutover in alembic 0030.

The face-selectable port model from V2 §3 ("which face of the cube is
the incident input") is intentionally NOT done here — that requires solver
changes. This migration only relocates the existing per-instance geometry
fields; the existing port wiring stays unchanged.

`splitRatioTransmitted`, `polarizing`, `extinctionRatioDb`, `transmission`
remain on kindParams (transfer physics, not geometry).
"""

from __future__ import annotations

import json
import os
import time
import uuid

import sqlalchemy as sa

from alembic import op


revision = "0032_bs_v2_cutover"
down_revision = "0031_lens_v2_split"
branch_labels = None
depends_on = None


KIND = "beam_splitter"
COATING_FIELD = "coatingNormalBodyLocal"
PBS_AXIS_FIELD = "transmissionAxisDegBeamLocal"
OPTICAL_SURFACE_KIND = "opticalSurface"
POLARIZATION_REFERENCE_KIND = "polarizationReference"


def _uuid7() -> str:
    ts_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    rand = int.from_bytes(os.urandom(10), "big")
    rand_a = rand & ((1 << 12) - 1)
    rand_b = (rand >> 12) & ((1 << 62) - 1)
    return str(uuid.UUID(int=(ts_ms << 80) | (0x7 << 76) | (rand_a << 64) | (0b10 << 62) | rand_b))


def _pick_anchor_id(asset_anchors: list) -> str | None:
    if not asset_anchors:
        return None
    by_id = {a.get("id"): a for a in asset_anchors if isinstance(a, dict)}
    if "optical_anchor" in by_id:
        return "optical_anchor"
    for hint in ("intercept_face", "intercept_in", "intercept_out", "optical"):
        for a in asset_anchors:
            if not isinstance(a, dict):
                continue
            if a.get("id") == hint:
                return hint
            name = (a.get("name") or "").lower()
            if hint in name:
                return a.get("id")
    for a in asset_anchors:
        if isinstance(a, dict) and a.get("id"):
            return a["id"]
    return None


def upgrade() -> None:
    bind = op.get_bind()
    asset_cache: dict[str, list] = {}

    rows = bind.execute(
        sa.text(
            """
            SELECT oe.object_id, oe.kind_params, o.properties, c.asset_3d_id
            FROM optical_elements oe
            JOIN objects o    ON o.id = oe.object_id
            JOIN components c ON c.id = o.component_id
            WHERE oe.element_kind = :kind
            """
        ),
        {"kind": KIND},
    ).fetchall()

    for object_id, kp_raw, props_raw, asset_3d_id in rows:
        kp = kp_raw if isinstance(kp_raw, dict) else (json.loads(kp_raw) if kp_raw else {})
        props = props_raw if isinstance(props_raw, dict) else (json.loads(props_raw) if props_raw else {})
        kp = dict(kp or {})
        props = dict(props or {})

        # 1. Coating normal → opticalSurface binding payload.
        raw_normal = kp.pop(COATING_FIELD, None)
        if raw_normal is None:
            normal = [0.7071067811865475, 0.7071067811865475, 0.0]
        else:
            try:
                normal = [float(raw_normal[0]), float(raw_normal[1]), float(raw_normal[2])]
            except (TypeError, ValueError, IndexError):
                normal = [0.7071067811865475, 0.7071067811865475, 0.0]

        # 2. PBS transmission axis → polarizationReference (only when polarizing).
        is_polarizing = bool(kp.get("polarizing", False))
        try:
            axis_deg = float(kp.pop(PBS_AXIS_FIELD, 0.0) or 0.0)
        except (TypeError, ValueError):
            axis_deg = 0.0

        # Resolve an anchor for the bindings.
        anchors: list = []
        if asset_3d_id is not None:
            cached = asset_cache.get(str(asset_3d_id))
            if cached is None:
                row = bind.execute(
                    sa.text("SELECT anchors FROM assets_3d WHERE id = :id"),
                    {"id": asset_3d_id},
                ).fetchone()
                cached = row[0] if row else []
                if isinstance(cached, str):
                    cached = json.loads(cached)
                cached = cached or []
                asset_cache[str(asset_3d_id)] = cached
            anchors = cached
        anchor_id = _pick_anchor_id(anchors)

        bindings = list(props.get("anchorBindings") or [])

        # Add opticalSurface binding (idempotent).
        if anchor_id is not None and not any(
            isinstance(b, dict) and b.get("kind") == OPTICAL_SURFACE_KIND for b in bindings
        ):
            bindings.append({
                "id": _uuid7(),
                "name": "Internal coating",
                "anchorId": anchor_id,
                "kind": OPTICAL_SURFACE_KIND,
                "frame": "anchorLocalXY",
                "payload": {"normalBodyLocal": normal},
            })

        # Add polarizationReference binding only when polarizing (idempotent).
        if is_polarizing and anchor_id is not None and not any(
            isinstance(b, dict)
            and b.get("kind") == POLARIZATION_REFERENCE_KIND
            and (b.get("payload") or {}).get("role") == "transmission"
            for b in bindings
        ):
            bindings.append({
                "id": _uuid7(),
                "name": "PBS transmission axis",
                "anchorId": anchor_id,
                "kind": POLARIZATION_REFERENCE_KIND,
                "frame": "anchorLocalXY",
                "payload": {"role": "transmission", "axisDegBeamLocal": axis_deg},
            })

        props["anchorBindings"] = bindings
        bind.execute(
            sa.text(
                "UPDATE optical_elements SET kind_params = CAST(:kp AS JSONB) WHERE object_id = :oid"
            ),
            {"kp": json.dumps(kp), "oid": object_id},
        )
        bind.execute(
            sa.text(
                "UPDATE objects SET properties = CAST(:p AS JSONB) WHERE id = :oid"
            ),
            {"p": json.dumps(props), "oid": object_id},
        )


def downgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            """
            SELECT oe.object_id, oe.kind_params, o.properties
            FROM optical_elements oe
            JOIN objects o ON o.id = oe.object_id
            WHERE oe.element_kind = :kind
            """
        ),
        {"kind": KIND},
    ).fetchall()

    for object_id, kp_raw, props_raw in rows:
        kp = kp_raw if isinstance(kp_raw, dict) else (json.loads(kp_raw) if kp_raw else {})
        props = props_raw if isinstance(props_raw, dict) else (json.loads(props_raw) if props_raw else {})
        kp = dict(kp or {})
        props = dict(props or {})

        bindings = props.get("anchorBindings") or []
        normal: list[float] | None = None
        axis: float | None = None
        kept: list = []
        for b in bindings:
            if (
                isinstance(b, dict)
                and b.get("kind") == OPTICAL_SURFACE_KIND
                and isinstance(b.get("payload"), dict)
                and isinstance(b["payload"].get("normalBodyLocal"), list)
                and normal is None
            ):
                normal = b["payload"]["normalBodyLocal"]
                continue
            if (
                isinstance(b, dict)
                and b.get("kind") == POLARIZATION_REFERENCE_KIND
                and (b.get("payload") or {}).get("role") == "transmission"
                and axis is None
            ):
                try:
                    axis = float((b.get("payload") or {}).get("axisDegBeamLocal", 0.0))
                except (TypeError, ValueError):
                    axis = 0.0
                continue
            kept.append(b)
        if kept != bindings:
            props["anchorBindings"] = kept
            bind.execute(
                sa.text("UPDATE objects SET properties = CAST(:p AS JSONB) WHERE id = :oid"),
                {"p": json.dumps(props), "oid": object_id},
            )
        if normal is not None and COATING_FIELD not in kp:
            kp[COATING_FIELD] = normal
        if axis is not None and PBS_AXIS_FIELD not in kp:
            kp[PBS_AXIS_FIELD] = axis
        bind.execute(
            sa.text(
                "UPDATE optical_elements SET kind_params = CAST(:kp AS JSONB) WHERE object_id = :oid"
            ),
            {"kp": json.dumps(kp), "oid": object_id},
        )
