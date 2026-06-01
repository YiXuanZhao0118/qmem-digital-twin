"""Restore ``connectorType`` on RF / AOM Asset3D anchors

Revision ID: 0098_rf_anchor_connector_type
Revises: 0097_repair_dynamic_sources

The Phase 9.1 anchor rebuild (scripts/backfill_asset_anchors.py) regenerated
``assets_3d.anchors`` from the legacy ``faces[]`` but the ``_anchor`` helper
never copied each port's ``connectorType``. Result: every RF / AOM anchor ended
up with ``connectorType = null``.

The RF Link panel reads the connector family straight off the anchor
(``connectorFamilyFromAnchor`` → ``anchor.connectorType``); a null family
renders "NO CONN", hard-blocks the drag-to-connect commit
(``connectorUndefined`` guard), and makes "create PPG at port" fail with
"No matching PPG catalog row" because the auto-PPG lookup matches on
``connectorType``. So with null connectors:

  * AOM ``rf_in`` cannot accept an RF cable, and
  * the switch ``ttl_in`` (and every other device port) cannot spawn a PPG.

Backfill strategy
-----------------
For every ``assets_3d`` row whose ``kind_id`` is an RF / AOM device kind, set
each RF-port anchor's ``connectorType`` to a female chassis jack matching the
asset's ``default_params.connectorType`` family (falling back to ``"sma"`` —
all of this hardware is SMA: MT80 RF input, ZYSWA SMA-F ports, ZHL amplifiers,
AD9959 SMA outputs).

Idempotent: anchors that already carry a non-null ``connectorType`` are left
untouched, so re-running is a no-op. ``rf_cable`` is intentionally excluded —
cable nodes are not shown in the RF Link panel and cable-variant resolution
reads ``properties.connectorType`` / ``endAConnector`` instead. Optical anchors
(the AOM's intercept_in / intercept_out) are skipped — only true RF ports.

Downgrade clears ``connectorType`` back to null on the same rows.
"""

from __future__ import annotations

import json
from typing import Any

import sqlalchemy as sa

from alembic import op


revision = "0098_rf_anchor_connector_type"
down_revision = "0097_repair_dynamic_sources"
branch_labels = None
depends_on = None


_RF_DEVICE_KINDS = ("aom", "rf_switch", "rf_amplifier", "rf_source")
# Only coax RF ports get a connector — the AOM's optical anchors
# (intercept_in / intercept_out) are not RF and must stay untouched.
_RF_PORT_IDS = ("rf_in", "rf_out", "ttl_in", "trigger_in")
# Device chassis ports are SMA female jacks (cables carry the male plug);
# all of this hardware is SMA per the seed notes ("SMA female on each
# end"). Gender is added to whatever connector family the kind declares.
_DEFAULT_CONNECTOR = "sma_female"


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            """
            SELECT id, anchors, default_params
              FROM assets_3d
             WHERE kind_id = ANY(:kinds)
            """
        ),
        {"kinds": list(_RF_DEVICE_KINDS)},
    ).mappings().fetchall()

    for row in rows:
        anchors: list[Any] = list(row["anchors"] or [])
        if not anchors:
            continue
        params = row["default_params"] or {}
        family = params.get("connectorType")
        # Map the declared family ("sma" / "bnc") to a female chassis jack;
        # fall back to SMA female when the kind declares nothing.
        if isinstance(family, str) and family.lower().startswith("bnc"):
            connector = "bnc_female"
        else:
            connector = _DEFAULT_CONNECTOR

        changed = False
        for anchor in anchors:
            if not isinstance(anchor, dict):
                continue
            if anchor.get("id") not in _RF_PORT_IDS:
                continue  # skip optical / non-RF anchors
            if anchor.get("connectorType"):
                continue  # idempotent — keep any value already present
            anchor["connectorType"] = connector
            changed = True

        if changed:
            bind.execute(
                sa.text(
                    "UPDATE assets_3d SET anchors = CAST(:a AS JSONB) WHERE id = :id"
                ),
                {"a": json.dumps(anchors), "id": row["id"]},
            )


def downgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            """
            SELECT id, anchors
              FROM assets_3d
             WHERE kind_id = ANY(:kinds)
            """
        ),
        {"kinds": list(_RF_DEVICE_KINDS)},
    ).mappings().fetchall()

    for row in rows:
        anchors: list[Any] = list(row["anchors"] or [])
        changed = False
        for anchor in anchors:
            if isinstance(anchor, dict) and "connectorType" in anchor:
                anchor["connectorType"] = None
                changed = True
        if changed:
            bind.execute(
                sa.text(
                    "UPDATE assets_3d SET anchors = CAST(:a AS JSONB) WHERE id = :id"
                ),
                {"a": json.dumps(anchors), "id": row["id"]},
            )
