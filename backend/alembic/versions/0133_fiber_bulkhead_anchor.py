"""Give a fibre bulkhead its own anchor, and gender the fibre connector types

Until now a fibre receptacle was an ``intercept_in`` that happened to carry
``connectorType: "fc_pc"``. That conflated two things the hardware keeps apart:

* an **intercept** is an optical FACE — something you can fly a free-space beam
  onto, and that is exactly what ``alignVariant: "translate_anchor_to_beam"``
  does with it;
* a **bulkhead** is a CONNECTION — a female socket on a chassis that a male
  ferrule mates into. Light only ever reaches it down a patch cable. Aligning
  the whole instrument so its socket lands on a beam is meaningless.

So the bulkhead gets its own role, ``fiber_in`` / ``fiber_out``, the same way
coax never overloaded an optical face and always had ``rf_in`` / ``rf_out``.
Both are added to ``anchor_tracer.PRIMARY_ANCHOR_IDS``: a receptacle is where
the mating patch cable's ferrule stops and the coupling is traced as a real
(~10 um) segment across the mating gap, so something hit-testable has to sit
there or the beam sails through and the part reads nothing. Ops are registered
per KIND, not per anchor id, so ``fiber_in`` on a detector lands in
``_terminal_sink_op`` with no new wiring.

``connector_type`` is **gendered** to match (``Anchor`` in ``app/schemas.py``):
``fc_pc`` / ``fc_apc`` become ``fc_pc_female`` / ``fc_apc_female`` on a
bulkhead, and the plug on a cable or pigtail end is ``*_male``. This is not
cosmetic: ``collectFiberPortsLab`` filters candidate ports on
``isFiberPortConnectorType`` **alone** and never looks at the anchor id, so the
moment cable ends declare their own connector a gender-blind predicate would
advertise every one of them as a socket and let two patch cables be plugged
into each other. The predicate is now female-only.

Three things land:

* the ``detector`` kind row is re-synced from ``backend/data/kinds.json`` — it
  gains the optional ``fiber_in`` role (direction + aperture) and
  ``intercept_in`` drops to optional, because a fibre-coupled receiver has no
  free-space face at all and a build has one or the other, never both. Same
  one-row form as 0129-0132; ``kinds`` must equal the manifest
  (``tests/test_kind_manifest_sync.py``), so this lands with the re-export.
* the ``rxm15ef`` **device** row: anchor role ``intercept_in`` -> ``fiber_in``,
  ``connector_type`` ``fc_pc`` -> ``fc_pc_female``.
* the ``rxm15ef_step`` **asset** row, whose anchors were materialised from that
  device: anchor id ``intercept_in`` -> ``fiber_in``, ``connectorType``
  ``fc_pc`` -> ``fc_pc_female``.

Position, direction and the 1.25 mm ferrule-bore aperture are carried over
untouched, so **no traced number changes** — the anchor the mating-gap segment
terminates on is the same point in space under a different id.

Those two rows are the ONLY carriers of a fibre connector type in the catalog
(the RXM15EF was built in the PHY Editor on 2026-08-21 and nothing else ever
declared one), which is why no sweep is needed here. Note what is deliberately
NOT in this migration: the ``*_male`` values belong on the ``fiber_connector``
assets' ``connect_in``, and ``pm_apc_780`` / ``pm_pc_780`` / ``sm_apc_780`` /
``sm_pc_780`` are all ``locked`` — see CLAUDE.md. That half needs a human to
unlock them first.

Forward-only like 0129-0132: the kind row has no stored prior to restore.

Revision ID: 0133_fiber_bulkhead_anchor
Revises: 0132_eom_per_end_align
"""

from __future__ import annotations

import json
import logging

import sqlalchemy as sa

from alembic import op


revision = "0133_fiber_bulkhead_anchor"
down_revision = "0132_eom_per_end_align"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

KIND = "detector"
DEVICE_SLUG = "rxm15ef"
ASSET_CATALOG_ID = "rxm15ef_step"
# Columns stored as JSONB — need an explicit cast on the way in.
_JSON_COLUMNS = ("default_params", "anchor_template")

_CONNECTOR_REMAP = {"fc_pc": "fc_pc_female", "fc_apc": "fc_apc_female"}


def _resync_detector_kind(conn) -> None:
    # Import inside upgrade() so alembic offline mode doesn't load the
    # manifest during SQL generation (mirrors 0126 / 0130 / 0131).
    from app.kinds_manifest import (
        MANIFEST_OWNED_KIND_COLUMNS,
        kind_rows_from_manifest,
    )

    target = kind_rows_from_manifest().get(KIND)
    if target is None:
        log.warning("0133: %r is not in the manifest — nothing to resync", KIND)
        return

    assignments = ", ".join(
        f"{c} = CAST(:{c} AS JSONB)" if c in _JSON_COLUMNS else f"{c} = :{c}"
        for c in MANIFEST_OWNED_KIND_COLUMNS
    )
    params = {"name": KIND, **{c: target[c] for c in MANIFEST_OWNED_KIND_COLUMNS}}
    for col in _JSON_COLUMNS:
        params[col] = json.dumps(params[col])

    result = conn.execute(
        sa.text(f"UPDATE kinds SET {assignments} WHERE name = :name"), params
    )
    if result.rowcount:
        log.info("0133: resynced kind %r from the manifest", KIND)
    else:
        log.warning("0133: no %r row to resync", KIND)


def _rename_device_anchor(conn) -> None:
    """``devices.anchors`` keeps the exporter's snake_case shape (``role`` /
    ``connector_type``) so ``materialize_device_anchors`` consumes a row
    unchanged — see the device section of docs/introduce/kinds.md."""
    row = conn.execute(
        sa.text("SELECT anchors FROM devices WHERE slug = :slug"),
        {"slug": DEVICE_SLUG},
    ).fetchone()
    if row is None:
        log.warning("0133: no %r device row — skipping", DEVICE_SLUG)
        return

    anchors = row[0]
    if isinstance(anchors, str):
        anchors = json.loads(anchors)
    changed = False
    for a in anchors or []:
        if a.get("role") == "intercept_in":
            a["role"] = "fiber_in"
            changed = True
        remapped = _CONNECTOR_REMAP.get(a.get("connector_type"))
        if remapped is not None:
            a["connector_type"] = remapped
            changed = True
    if not changed:
        log.info("0133: %r device anchors already migrated", DEVICE_SLUG)
        return

    conn.execute(
        sa.text(
            "UPDATE devices SET anchors = CAST(:anchors AS JSONB) WHERE slug = :slug"
        ),
        {"slug": DEVICE_SLUG, "anchors": json.dumps(anchors)},
    )
    log.info("0133: %r device anchor intercept_in -> fiber_in", DEVICE_SLUG)


def _rename_asset_anchor(conn) -> None:
    """``assets_3d.anchors`` is the camelCase materialised form (``id`` /
    ``connectorType``)."""
    row = conn.execute(
        sa.text("SELECT anchors FROM assets_3d WHERE catalog_id = :cid"),
        {"cid": ASSET_CATALOG_ID},
    ).fetchone()
    if row is None:
        log.warning("0133: no %r asset row — skipping", ASSET_CATALOG_ID)
        return

    anchors = row[0]
    if isinstance(anchors, str):
        anchors = json.loads(anchors)
    changed = False
    for a in anchors or []:
        if a.get("id") == "intercept_in":
            a["id"] = "fiber_in"
            changed = True
        remapped = _CONNECTOR_REMAP.get(a.get("connectorType"))
        if remapped is not None:
            a["connectorType"] = remapped
            changed = True
    if not changed:
        log.info("0133: %r asset anchors already migrated", ASSET_CATALOG_ID)
        return

    conn.execute(
        sa.text(
            "UPDATE assets_3d SET anchors = CAST(:anchors AS JSONB) "
            "WHERE catalog_id = :cid"
        ),
        {"cid": ASSET_CATALOG_ID, "anchors": json.dumps(anchors)},
    )
    log.info("0133: %r asset anchor intercept_in -> fiber_in", ASSET_CATALOG_ID)


def _remap_fiber_endpoint_links(conn) -> None:
    """Follow the rename into the per-instance links that point AT the port.

    A plugged-in patch cable stores ``SceneObject.properties.fiberEndpoints[
    A|B] = {targetObjectId, targetAnchorId, targetAnchorName}`` — the link is
    kept on the CABLE because a cable has two ends and one identity while a
    port has many possible cables (docs/introduce/fiber.md). Renaming the
    anchor without rewriting the links leaves them dangling: the solver still
    reads the pose out of ``kindParams.endA/endB`` so the beam does not go
    dark, but ``resolveLinkedFiberEndpoint`` can no longer find the anchor, so
    the cable silently stops following the instrument when it is dragged.

    Scoped to objects that actually resolve to ``rxm15ef_step``: a link naming
    ``intercept_in`` on an EOSpace pigtail port is still correct and must not
    be touched.
    """
    targets = {
        str(r[0])
        for r in conn.execute(
            sa.text(
                "SELECT DISTINCT o.id FROM objects o "
                "JOIN component_bindings cb ON cb.component_id = o.component_id "
                "JOIN assets_3d a ON a.id = cb.asset_3d_id "
                "WHERE a.catalog_id = :cid"
            ),
            {"cid": ASSET_CATALOG_ID},
        )
    }
    if not targets:
        log.info("0133: no scene object resolves to %r — no links to remap", ASSET_CATALOG_ID)
        return

    remap = {"intercept_in": "fiber_in", "intercept_out": "fiber_out"}
    rows = conn.execute(
        sa.text(
            "SELECT id, properties FROM objects "
            "WHERE properties::text LIKE '%fiberEndpoints%'"
        )
    ).fetchall()
    for obj_id, props in rows:
        if isinstance(props, str):
            props = json.loads(props)
        endpoints = (props or {}).get("fiberEndpoints")
        if not isinstance(endpoints, dict):
            continue
        changed = False
        for link in endpoints.values():
            if not isinstance(link, dict):
                continue
            if str(link.get("targetObjectId")) not in targets:
                continue
            renamed = remap.get(link.get("targetAnchorId"))
            if renamed is not None:
                link["targetAnchorId"] = renamed
                changed = True
        if not changed:
            continue
        conn.execute(
            sa.text(
                "UPDATE objects SET properties = CAST(:props AS JSONB) WHERE id = :id"
            ),
            {"id": obj_id, "props": json.dumps(props)},
        )
        log.info("0133: remapped fiberEndpoints link on object %s", obj_id)


def upgrade() -> None:
    conn = op.get_bind()
    _resync_detector_kind(conn)
    _rename_device_anchor(conn)
    _rename_asset_anchor(conn)
    _remap_fiber_endpoint_links(conn)


def downgrade() -> None:
    """Forward-only — see the module docstring."""
