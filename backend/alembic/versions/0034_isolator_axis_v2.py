"""V2 Phase 8: cut isolator transmission axis to a polarizationReference binding

Revision ID: 0034_isolator_v2_cut
Revises: 0033_aom_rf_v2_cutov

V2 schema (docs/optical-schema-v2.md §3) treats the isolator's polarisation
reference axis the same way as the polarizer (role="transmission" on a
``polarizationReference`` binding). Mirrors alembic 0030 for waveplate /
polarizer.

`forwardLossDb`, `isolationDb`, `groupDelayPs` stay on kindParams (pure
transfer physics).

This is the last per-kind axis/normal cutover; the remaining kinds
(eom, fiber, fiber_coupler, tapered_amplifier, detectors, etc.) carry
no simple vector/axis field that fits the binding pattern.
"""

from __future__ import annotations

import json
import os
import time
import uuid

import sqlalchemy as sa

from alembic import op


revision = "0034_isolator_v2_cut"
down_revision = "0033_aom_rf_v2_cutov"
branch_labels = None
depends_on = None


KIND = "isolator"
AXIS_FIELD = "transmissionAxisDegBeamLocal"
BINDING_KIND = "polarizationReference"
ROLE = "transmission"


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

        try:
            angle = float(kp.pop(AXIS_FIELD, 0.0) or 0.0)
        except (TypeError, ValueError):
            angle = 0.0
        # Drop the pre-Phase-5 alias too.
        kp.pop("transmissionAxisDeg", None)

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
        if anchor_id is not None and not any(
            isinstance(b, dict)
            and b.get("kind") == BINDING_KIND
            and (b.get("payload") or {}).get("role") == ROLE
            for b in bindings
        ):
            bindings.append({
                "id": _uuid7(),
                "name": "Isolator transmission axis",
                "anchorId": anchor_id,
                "kind": BINDING_KIND,
                "frame": "anchorLocalXY",
                "payload": {"role": ROLE, "axisDegBeamLocal": angle},
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
        angle: float | None = None
        kept: list = []
        for b in bindings:
            if (
                isinstance(b, dict)
                and b.get("kind") == BINDING_KIND
                and (b.get("payload") or {}).get("role") == ROLE
                and angle is None
            ):
                try:
                    angle = float((b.get("payload") or {}).get("axisDegBeamLocal", 0.0))
                except (TypeError, ValueError):
                    angle = 0.0
                continue
            kept.append(b)
        if kept != bindings:
            props["anchorBindings"] = kept
            bind.execute(
                sa.text(
                    "UPDATE objects SET properties = CAST(:p AS JSONB) WHERE id = :oid"
                ),
                {"p": json.dumps(props), "oid": object_id},
            )
        if angle is not None and AXIS_FIELD not in kp:
            kp[AXIS_FIELD] = angle
            bind.execute(
                sa.text(
                    "UPDATE optical_elements SET kind_params = CAST(:kp AS JSONB) WHERE object_id = :oid"
                ),
                {"kp": json.dumps(kp), "oid": object_id},
            )
