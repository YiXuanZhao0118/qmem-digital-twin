"""Resync the ``eom`` kind row: the modulator stops aligning as one body.

A fibre-pigtailed modulator has no bare optical face — each of its ports is
an FC/APC connector on a flexible pigtail, and
``db_scene_loader._port_connector_anchors`` re-seats ``intercept_in`` /
``intercept_out`` onto those connectors' ``connect_in``. So "align the EOM"
was never really one operation: pointing the whole part at a beam drags the
OTHER end off whatever it was already plugged into.

The plugin's ``alignVariant`` therefore drops to ``"none"`` (joining
``fiber``, which opted out for the same reason) and the UI gains a per-end
control — Object panel → Align → "Align End A / End B",
``frontend/src/components/physics/PigtailEndAlignControls.tsx``. Each end
snaps its own connector to a beam or a fibre receptacle within 25 mm and
persists as an ``ObjectBinding`` delta on that connector's binding, so the
instrument body never moves and the catalog baseline is untouched. Only
``align_summary`` (stored as ``kinds.description``) actually changes value
here; the rest of the row is re-written from the manifest for free.

``kinds`` must equal ``backend/data/kinds.json`` (0126, pinned by
``tests/test_kind_manifest_sync.py``), so this lands with the re-export.
That re-export also picks up the ``eom`` / ``detector`` manifest entries
that 0129–0131 already installed in the DB while ``kinds.json`` itself was
left stale — the table was ahead, not behind, so those need no migration.

One row, only the ``MANIFEST_OWNED_KIND_COLUMNS``. Forward-only like 0126.
The row is not ``locked``.

Revision ID: 0132_eom_per_end_align
Revises: 0131_detector_photoreceiver
"""

from __future__ import annotations

import json
import logging

import sqlalchemy as sa

from alembic import op


revision = "0132_eom_per_end_align"
down_revision = "0131_detector_photoreceiver"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

KIND = "eom"
# Columns stored as JSONB — need an explicit cast on the way in.
_JSON_COLUMNS = ("default_params", "anchor_template")


def upgrade() -> None:
    # Import inside upgrade() so alembic offline mode doesn't load the
    # manifest during SQL generation (mirrors 0086 / 0092 / 0126 / 0130).
    from app.kinds_manifest import (
        MANIFEST_OWNED_KIND_COLUMNS,
        kind_rows_from_manifest,
    )

    conn = op.get_bind()
    target = kind_rows_from_manifest().get(KIND)
    if target is None:
        log.warning("0132: %r is not in the manifest — nothing to resync", KIND)
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
        log.info("0132: resynced kind %r from the manifest", KIND)
    else:
        log.warning("0132: no %r row to resync", KIND)


def downgrade() -> None:
    """Forward-only — see the module docstring."""
