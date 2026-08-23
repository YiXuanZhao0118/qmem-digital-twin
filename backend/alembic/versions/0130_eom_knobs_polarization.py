"""Resync the ``eom`` kind row again: the two drive knobs + waveguide PER.

Three params land on the kind, and each closes a hole 0129 left open:

* ``driveVoltageV`` / ``biasVoltageV`` — they were only ever read out of
  ``dynamic_sources``, which no UI could write for this kind: they are not
  ``default_params`` keys, so ``tunable_params`` (the thing that puts a field
  in the Object panel) had nothing to point at. They are now real params with
  a baseline on the asset, declared as the kind's ``stateParamKeys``, and the
  op reads them through ``ctx.params`` — asset default, overridden per
  instance by ``dynamic_sources``, which is the normal ownership rule.
* ``polarizationExtinctionRatioDb`` — a guided modulator is
  single-polarization, which the op did not model at all: light on the wrong
  axis used to sail through a Mach-Zehnder untouched. Only the component on
  ``intercept_in``'s axisY is guided now; the rest survives at this floor.

Also the first time ``eom`` declares ``intrinsicParamKeys`` /
``stateParamKeys`` — before this every key counted as state.

``kinds`` must equal ``backend/data/kinds.json`` (0126, pinned by
``tests/test_kind_manifest_sync.py``), so this lands with the re-export.
One row, only the ``MANIFEST_OWNED_KIND_COLUMNS``. Forward-only like 0126.

Revision ID: 0130_eom_knobs_polarization
Revises: 0129_eom_mz_params
"""

from __future__ import annotations

import json
import logging

import sqlalchemy as sa

from alembic import op


revision = "0130_eom_knobs_polarization"
down_revision = "0129_eom_mz_params"
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
        log.warning("0130: %r is not in the manifest — nothing to resync", KIND)
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
        log.info("0130: resynced kind %r from the manifest", KIND)
    else:
        log.warning("0130: no %r row to resync", KIND)


def downgrade() -> None:
    """Forward-only — see the module docstring."""
