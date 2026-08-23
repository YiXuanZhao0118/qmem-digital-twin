"""Resync the ``detector`` kind row: an electrical output port + its specs.

A detector is where light stops and a VOLTAGE starts, but the kind had no
way to say so: its only role was the optical ``intercept_in`` and its only
param was ``wavelengthRangeNm``. A fibre-coupled photoreceiver (the Thorlabs
RXM series — fibre in on an FC bulkhead, DC-15 GHz out on a coax jack) could
therefore not be modelled at all: the SMA output had no role to hang an
anchor on, and the responsivity / conversion gain / bandwidth / NEP that are
the whole point of the part had nowhere to live.

Two things land:

* ``rf_out`` — optional (``min: 0``; a bare photodiode has no connector of
  its own), domain ``rf``, needs a direction. Like the AOM's ``rf_in`` it is
  cable-routing geometry: ``_terminal_sink_op`` still absorbs the beam and
  there is no optical -> RF conversion in the solver, so this anchor changes
  no physics. ``default_physics`` gains ``rf`` to match.
* ``responsivityAPerW`` / ``conversionGainVPerW`` / ``bandwidthHz`` /
  ``nepWPerRtHz`` — spec-sheet record, all intrinsic (a detector has no
  knob to dial, so ``state_param_keys`` stays empty). ``conversionGainVPerW``
  is signed: negative means an inverting output.

``domains`` is written too, which is NOT one of ``MANIFEST_OWNED_KIND_COLUMNS``
— that column is user-editable in the Kinds editor, so a resync deliberately
leaves it alone. It is set here explicitly because the manifest derivation
(``kind_domains_for_plugin``) now yields ``["optical", "rf"]`` for this kind and
the column is what puts an asset on the PHY Editor's RF rail: leave it at
``["optical"]`` and the receiver's SMA output cannot be cabled at all, which is
the whole point of the change. Same shape the ``aom`` / ``eom`` rows already
have. A fresh DB seeds it from the same derivation, so this only repairs the
pre-existing row.

Nothing points at this kind yet (``rxm15ef_step`` is the first, and it is
``unclassified`` until the ``rxm15ef`` device is attached), so no existing
asset row changes meaning.

``kinds`` must equal ``backend/data/kinds.json`` (0126, pinned by
``tests/test_kind_manifest_sync.py``), so this lands with the re-export.
One row, only the ``MANIFEST_OWNED_KIND_COLUMNS``. Forward-only like 0130.

Revision ID: 0131_detector_photoreceiver
Revises: 0130_eom_knobs_polarization
"""

from __future__ import annotations

import json
import logging

import sqlalchemy as sa

from alembic import op


revision = "0131_detector_photoreceiver"
down_revision = "0130_eom_knobs_polarization"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

KIND = "detector"
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
        log.warning("0131: %r is not in the manifest — nothing to resync", KIND)
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
        log.info("0131: resynced kind %r from the manifest", KIND)
    else:
        log.warning("0131: no %r row to resync", KIND)

    # domains — outside MANIFEST_OWNED_KIND_COLUMNS on purpose; see the
    # module docstring for why this one is written anyway.
    conn.execute(
        sa.text("UPDATE kinds SET domains = :domains WHERE name = :name"),
        {"name": KIND, "domains": target["domains"]},
    )
    log.info("0131: kind %r domains -> %r", KIND, target["domains"])


def downgrade() -> None:
    """Forward-only — see the module docstring."""
