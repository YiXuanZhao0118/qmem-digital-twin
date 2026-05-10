"""V2 Phase 2: cut `mirror` over to anchorBindings (hard cutover).

Revision ID: 0028_mirror_v2_cutov
Revises: 0027_v2_phase1_base

V2 schema (docs/optical-schema-v2.md §3) puts a mirror's reflective-surface
normal in ``objects.properties.anchorBindings[]`` instead of
``optical_elements.kind_params.surfaceNormalBodyLocal``. This is the first
per-kind cutover. Subsequent phases follow the same shape, kind by kind.

Mirror also covers ``dichroic_mirror`` — same field, same migration.

Per-row migration:
1. For every SceneObject whose OpticalElement.element_kind ∈ {mirror, dichroic_mirror}:
   a. Read kind_params.surfaceNormalBodyLocal (default [1, 0, 0]).
   b. Pick a binding anchor on the parent Asset3D (preference order):
      "optical_anchor" → first anchor whose name suggests "optical"/"surface"
      → first anchor → None (skip the row).
   c. If no anchors at all on the asset, skip the binding-creation step but
      still strip the kindParams field — solver falls back to the
      asset_anchor / kind_default_mirror chain.
   d. Append a {kind: "opticalSurface"} binding to
      objects.properties.anchorBindings (init [] if missing).
   e. Strip surfaceNormalBodyLocal from kind_params.
2. Hard cutover — old field is GONE post-upgrade. The Pydantic shim that
   accepted "normalLocal" / "normal_local" is dropped in the same release.

Downgrade reverses the operation: read the binding payload back into
kind_params, drop the binding row.
"""

from __future__ import annotations

import json
import os
import time
import uuid

import sqlalchemy as sa

from alembic import op


revision = "0028_mirror_v2_cutov"
down_revision = "0027_v2_phase1_base"
branch_labels = None
depends_on = None


MIRROR_KINDS = ("mirror", "dichroic_mirror")
LEGACY_FIELD_CAMEL = "surfaceNormalBodyLocal"
BINDING_KIND = "opticalSurface"


def _uuid7() -> str:
    """Local UUIDv7 — duplicated from app/uuid7.py so the migration has no
    runtime dep on app code (alembic env may import models, not utils)."""
    ts_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    rand = int.from_bytes(os.urandom(10), "big")
    rand_a = rand & ((1 << 12) - 1)
    rand_b = (rand >> 12) & ((1 << 62) - 1)
    value = (ts_ms << 80) | (0x7 << 76) | (rand_a << 64) | (0b10 << 62) | rand_b
    return str(uuid.UUID(int=value))


def _pick_anchor_id(asset_anchors: list) -> str | None:
    """Choose the binding anchor for a mirror surface."""
    if not asset_anchors:
        return None
    by_id = {a.get("id"): a for a in asset_anchors if isinstance(a, dict)}

    # Preferred: explicit optical_anchor.
    if "optical_anchor" in by_id:
        return "optical_anchor"

    # Next: anything name- or id-suggestive of an optical surface.
    for hint in ("intercept_face", "intercept_in", "intercept_out", "optical"):
        for a in asset_anchors:
            if not isinstance(a, dict):
                continue
            if a.get("id") == hint:
                return hint
            name = (a.get("name") or "").lower()
            if hint in name:
                return a.get("id")

    # Fallback: first anchor with an id, regardless of meaning.
    for a in asset_anchors:
        if isinstance(a, dict) and a.get("id"):
            return a["id"]
    return None


def upgrade() -> None:
    bind = op.get_bind()

    rows = bind.execute(
        sa.text(
            """
            SELECT oe.object_id, oe.kind_params, o.properties, c.asset_3d_id
            FROM optical_elements oe
            JOIN objects o    ON o.id = oe.object_id
            JOIN components c ON c.id = o.component_id
            WHERE oe.element_kind = ANY(:kinds)
            """
        ),
        {"kinds": list(MIRROR_KINDS)},
    ).fetchall()

    asset_anchors_cache: dict[str, list] = {}

    for object_id, kind_params, properties, asset_3d_id in rows:
        # Tolerate JSONB → str on some psycopg paths.
        if isinstance(kind_params, str):
            kind_params = json.loads(kind_params)
        if isinstance(properties, str):
            properties = json.loads(properties)
        kind_params = dict(kind_params or {})
        properties = dict(properties or {})

        # 1. Extract the legacy normal (default to [1, 0, 0] for rows with no field).
        raw = kind_params.pop(LEGACY_FIELD_CAMEL, None)
        # Also drop the old pre-Phase-5 alias if it survived 0019.
        kind_params.pop("normalLocal", None)
        if raw is None:
            normal = [1.0, 0.0, 0.0]
        else:
            try:
                normal = [float(raw[0]), float(raw[1]), float(raw[2])]
            except (TypeError, ValueError, IndexError):
                normal = [1.0, 0.0, 0.0]

        # 2. Look up the asset's anchors and pick a binding target.
        anchors: list = []
        if asset_3d_id is not None:
            cached = asset_anchors_cache.get(str(asset_3d_id))
            if cached is None:
                anchor_row = bind.execute(
                    sa.text("SELECT anchors FROM assets_3d WHERE id = :id"),
                    {"id": asset_3d_id},
                ).fetchone()
                cached = anchor_row[0] if anchor_row else []
                if isinstance(cached, str):
                    cached = json.loads(cached)
                cached = cached or []
                asset_anchors_cache[str(asset_3d_id)] = cached
            anchors = cached
        anchor_id = _pick_anchor_id(anchors)

        # 3. Build the binding (only if we found an anchor to bind to).
        if anchor_id is not None:
            binding = {
                "id": _uuid7(),
                "name": "Reflective surface",
                "anchorId": anchor_id,
                "kind": BINDING_KIND,
                "frame": "anchorLocalXY",
                "payload": {"normalBodyLocal": normal},
            }
            existing = properties.get("anchorBindings") or []
            if not isinstance(existing, list):
                existing = []
            # Idempotency guard: don't append a duplicate opticalSurface
            # binding if a previous run already added one for this object.
            already_has_optical_surface = any(
                isinstance(b, dict) and b.get("kind") == BINDING_KIND for b in existing
            )
            if not already_has_optical_surface:
                existing.append(binding)
                properties["anchorBindings"] = existing
        # 4. Persist (always — even if anchor_id is None, the kindParams
        #    field has been stripped above and must be written back).
        bind.execute(
            sa.text(
                """
                UPDATE optical_elements
                SET kind_params = CAST(:kp AS JSONB)
                WHERE object_id = :oid
                """
            ),
            {"kp": json.dumps(kind_params), "oid": object_id},
        )
        bind.execute(
            sa.text(
                """
                UPDATE objects
                SET properties = CAST(:props AS JSONB)
                WHERE id = :oid
                """
            ),
            {"props": json.dumps(properties), "oid": object_id},
        )


def downgrade() -> None:
    """Reverse the cutover: read normal back from binding into kind_params,
    drop the binding. Best-effort — bindings created post-upgrade by V2-aware
    code are also reaped here, which is the desired symmetry."""
    bind = op.get_bind()

    rows = bind.execute(
        sa.text(
            """
            SELECT oe.object_id, oe.kind_params, o.properties
            FROM optical_elements oe
            JOIN objects o ON o.id = oe.object_id
            WHERE oe.element_kind = ANY(:kinds)
            """
        ),
        {"kinds": list(MIRROR_KINDS)},
    ).fetchall()

    for object_id, kind_params, properties in rows:
        if isinstance(kind_params, str):
            kind_params = json.loads(kind_params)
        if isinstance(properties, str):
            properties = json.loads(properties)
        kind_params = dict(kind_params or {})
        properties = dict(properties or {})

        bindings = properties.get("anchorBindings") or []
        normal = None
        kept: list = []
        for b in bindings:
            if (
                isinstance(b, dict)
                and b.get("kind") == BINDING_KIND
                and isinstance(b.get("payload"), dict)
                and isinstance(b["payload"].get("normalBodyLocal"), list)
                and normal is None
            ):
                normal = b["payload"]["normalBodyLocal"]
                continue  # drop this binding
            kept.append(b)
        if kept != bindings:
            properties["anchorBindings"] = kept
            bind.execute(
                sa.text(
                    "UPDATE objects SET properties = CAST(:props AS JSONB) WHERE id = :oid"
                ),
                {"props": json.dumps(properties), "oid": object_id},
            )
        if normal is not None and LEGACY_FIELD_CAMEL not in kind_params:
            kind_params[LEGACY_FIELD_CAMEL] = normal
            bind.execute(
                sa.text(
                    "UPDATE optical_elements SET kind_params = CAST(:kp AS JSONB) WHERE object_id = :oid"
                ),
                {"kp": json.dumps(kind_params), "oid": object_id},
            )
