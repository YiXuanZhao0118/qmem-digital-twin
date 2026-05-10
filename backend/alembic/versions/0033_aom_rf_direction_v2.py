"""V2 Phase 7: cut AOM rfPropagationDirectionBodyLocal to a binding

Revision ID: 0033_aom_rf_v2_cutov
Revises: 0032_bs_v2_cutover

V2 schema (docs/optical-schema-v2.md §3) puts the AOM's RF / acoustic
propagation direction on a per-instance ``rfDirection`` anchor binding
instead of ``kindParams.rfPropagationDirectionBodyLocal``.

The acoustic-axis duplicate field (``acousticAxisBodyLocal``) is also
migrated and dropped — both fields encoded the same body-local k-vector;
the binding payload is now the single source of truth.

Other AOM kindParams (centerFreqMhz, rfDrivePowerW, refractiveIndex,
crystalLengthMm, figureOfMeritM2, diffractionOrder, …) stay where they
are — those are RF / transfer physics, not geometry. The V2 nested
``rf`` / ``medium`` / ``orders`` groupings from §3 are purely cosmetic
restructure; deferred to the final V2 cleanup phase to avoid touching
the Phase 7.4 alignment internals.
"""

from __future__ import annotations

import json
import os
import time
import uuid

import sqlalchemy as sa

from alembic import op


revision = "0033_aom_rf_v2_cutov"
down_revision = "0032_bs_v2_cutover"
branch_labels = None
depends_on = None


KIND = "aom"
RF_FIELD = "rfPropagationDirectionBodyLocal"
ACOUSTIC_FIELD = "acousticAxisBodyLocal"
BINDING_KIND = "rfDirection"


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

        # Prefer rfPropagationDirectionBodyLocal, fall back to acousticAxisBodyLocal,
        # then to the historical default [-1, 0, 0] (MT80 convention: body -X
        # is transducer → absorber).
        raw = kp.pop(RF_FIELD, None)
        kp.pop(ACOUSTIC_FIELD, None)
        if raw is None:
            raw = kp.get(ACOUSTIC_FIELD)  # for the (rare) case it's still there
        # Also drop the pre-Phase-5 aliases.
        kp.pop("acousticAxisLocal", None)
        kp.pop("rfPropagationDirectionLocal", None)
        if raw is None:
            direction = [-1.0, 0.0, 0.0]
        else:
            try:
                direction = [float(raw[0]), float(raw[1]), float(raw[2])]
            except (TypeError, ValueError, IndexError):
                direction = [-1.0, 0.0, 0.0]

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
            isinstance(b, dict) and b.get("kind") == BINDING_KIND for b in bindings
        ):
            bindings.append({
                "id": _uuid7(),
                "name": "RF / acoustic propagation",
                "anchorId": anchor_id,
                "kind": BINDING_KIND,
                "frame": "anchorLocalXY",
                "payload": {"directionBodyLocal": direction},
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
        direction: list[float] | None = None
        kept: list = []
        for b in bindings:
            if (
                isinstance(b, dict)
                and b.get("kind") == BINDING_KIND
                and isinstance(b.get("payload"), dict)
                and direction is None
            ):
                raw = (b.get("payload") or {}).get("directionBodyLocal")
                if isinstance(raw, list) and len(raw) >= 3:
                    try:
                        direction = [float(raw[0]), float(raw[1]), float(raw[2])]
                    except (TypeError, ValueError):
                        direction = None
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
        if direction is not None and RF_FIELD not in kp:
            kp[RF_FIELD] = direction
            bind.execute(
                sa.text(
                    "UPDATE optical_elements SET kind_params = CAST(:kp AS JSONB) WHERE object_id = :oid"
                ),
                {"kp": json.dumps(kp), "oid": object_id},
            )
