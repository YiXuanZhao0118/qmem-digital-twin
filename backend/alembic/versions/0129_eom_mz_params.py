"""Resync the ``eom`` kind row after the Mach-Zehnder / pigtail extension.

The ``eom`` plugin gained five params and one optional role so a real
fibre-pigtailed intensity modulator (the EOSpace AZ-0S5-20-PFA-PFA-850/900)
can be catalogued:

* ``biasVPiV`` / ``insertionLossDb`` / ``extinctionRatioDb`` — the three
  datasheet numbers a Mach-Zehnder is specified by, none of which had
  anywhere to live before (the op only knew ``vPiV``).
* ``fiberPigtailed`` / ``coreMfdUm`` — geometry, not modulation: a pigtailed
  part guides the light across the package, so its output leaves
  ``intercept_out`` as the pigtail's fundamental mode rather than as a
  free-space beam that diffracted the length of the housing.
* role ``rf_in`` (min 0, direction) — the RF drive jack on the housing, the
  same cable-routing-only anchor the AOM already declares. Optional, so no
  existing eom asset is forced to grow one.

``kinds`` must equal ``backend/data/kinds.json`` (alembic 0126, pinned by
``tests/test_kind_manifest_sync.py``), so the manifest re-export needs this
migration to land with it. Scope is one row: only ``eom`` is touched, and
only the ``MANIFEST_OWNED_KIND_COLUMNS``.

Forward-only, like 0126 — the pre-image is the manifest before the plugin
edit and there is nothing worth restoring, so ``downgrade`` is a no-op.

Revision ID: 0129_eom_mz_params
Revises: 0128_component_locked
"""

from __future__ import annotations

import json
import logging

import sqlalchemy as sa

from alembic import op


revision = "0129_eom_mz_params"
down_revision = "0128_component_locked"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

KIND = "eom"
# Columns stored as JSONB — need an explicit cast on the way in.
_JSON_COLUMNS = ("default_params", "anchor_template")


def upgrade() -> None:
    # Import inside upgrade() so alembic offline mode doesn't load the
    # manifest during SQL generation (mirrors 0086 / 0092 / 0126).
    from app.kinds_manifest import (
        MANIFEST_OWNED_KIND_COLUMNS,
        kind_rows_from_manifest,
    )

    conn = op.get_bind()
    target = kind_rows_from_manifest().get(KIND)
    if target is None:
        log.warning("0129: %r is not in the manifest — nothing to resync", KIND)
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
        log.info("0129: resynced kind %r from the manifest", KIND)
    else:
        log.warning("0129: no %r row to resync", KIND)


def downgrade() -> None:
    """Forward-only — see the module docstring."""
