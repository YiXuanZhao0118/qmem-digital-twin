"""V2 Phase 4: cut `waveplate` + `polarizer` axes over to polarizationReference

Revision ID: 0030_wp_pol_v2_cutov
Revises: 0029_laser_v2_cutov

V2 schema (docs/optical-schema-v2.md §3) puts each instance's polarization
axis on a ``polarizationReference`` anchor binding instead of a scalar
``*AxisDegBeamLocal`` field on kindParams.

For now the binding payload still carries a scalar ``axisDegBeamLocal``
(the old beam-frame angle) — promoting it to a body-local vector is a
later phase that requires solver projection updates. The structural
boundary moves now; the numeric model can be refined later.

Per-row migration for every {waveplate, polarizer} OpticalElement:
1. Read kind_params['fastAxisDegBeamLocal'] (waveplate) or
   ['transmissionAxisDegBeamLocal'] (polarizer); default 0.
2. Pick a binding anchor on the parent Asset3D (same preference order
   as the mirror/laser cutovers).
3. Append a ``polarizationReference`` binding with
   payload = {axisDegBeamLocal, role}.
4. Strip the V2-tracked field from kindParams.

Downgrade lifts the angle back into kindParams and drops the binding.
"""

from __future__ import annotations

import json
import os
import time
import uuid

import sqlalchemy as sa

from alembic import op


revision = "0030_wp_pol_v2_cutov"
down_revision = "0029_laser_v2_cutov"
branch_labels = None
depends_on = None


KIND_TO_AXIS_FIELD = {
    "waveplate": ("fastAxisDegBeamLocal", "fast", "Fast axis"),
    "polarizer": ("transmissionAxisDegBeamLocal", "transmission", "Transmission axis"),
}
BINDING_KIND = "polarizationReference"


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

    for kind, (axis_field, role, name) in KIND_TO_AXIS_FIELD.items():
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
            {"kind": kind},
        ).fetchall()

        for object_id, kp_raw, props_raw, asset_3d_id in rows:
            kp = kp_raw if isinstance(kp_raw, dict) else (json.loads(kp_raw) if kp_raw else {})
            props = props_raw if isinstance(props_raw, dict) else (json.loads(props_raw) if props_raw else {})
            kp = dict(kp or {})
            props = dict(props or {})

            try:
                angle = float(kp.pop(axis_field, 0.0) or 0.0)
            except (TypeError, ValueError):
                angle = 0.0
            # Also drop the pre-Phase-5 alias if it survived 0019.
            kp.pop(axis_field.replace("BeamLocal", ""), None)

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

            bindings = props.get("anchorBindings") or []
            if not isinstance(bindings, list):
                bindings = []
            already = any(
                isinstance(b, dict)
                and b.get("kind") == BINDING_KIND
                and (b.get("payload") or {}).get("role") == role
                for b in bindings
            )
            if anchor_id is not None and not already:
                bindings.append({
                    "id": _uuid7(),
                    "name": name,
                    "anchorId": anchor_id,
                    "kind": BINDING_KIND,
                    "frame": "anchorLocalXY",
                    "payload": {"role": role, "axisDegBeamLocal": angle},
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
    for kind, (axis_field, role, _name) in KIND_TO_AXIS_FIELD.items():
        rows = bind.execute(
            sa.text(
                """
                SELECT oe.object_id, oe.kind_params, o.properties
                FROM optical_elements oe
                JOIN objects o ON o.id = oe.object_id
                WHERE oe.element_kind = :kind
                """
            ),
            {"kind": kind},
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
                    and (b.get("payload") or {}).get("role") == role
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
            if angle is not None and axis_field not in kp:
                kp[axis_field] = angle
                bind.execute(
                    sa.text(
                        "UPDATE optical_elements SET kind_params = CAST(:kp AS JSONB) WHERE object_id = :oid"
                    ),
                    {"kp": json.dumps(kp), "oid": object_id},
                )
