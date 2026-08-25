"""Resync the ``laser_source`` kind row: a fibre bulkhead on an emitter

A laser source could only ever emit into free space. Its roles were ``out``
and ``intercept_out``, both bare optical faces, so a **fibre-coupled** source
— a pigtailed diode, a fibre-launch module, or the handheld visual fault
locator this migration was written for — had nowhere to declare the socket
its patch cable actually plugs into. Modelling it as an ``intercept_out``
wearing a connector is exactly the conflation alembic 0133 undid for the
``detector``: an intercept is an optical FACE you can fly a free-space beam
onto, a bulkhead is a CONNECTION a male ferrule mates into and light only
ever reaches down a cable.

So ``laser_source`` gains the same role the detector got, with the same
meaning:

* ``fiber_in`` — optional (``min: 0``; a bare TOSA facet has no socket at
  all), domain ``optical``, needs a direction and an aperture. Read the name
  from the FIBRE's point of view, not the light's (``anchor_tracer``'s
  ``PRIMARY_ANCHOR_IDS`` note): ``fiber_in`` is where a fibre goes INTO an
  instrument, which is what a socket on an emitter is. Light direction is
  carried by the anchor's axisX, and on a source that points OUT of the body.

**No physics changes here, and none is possible without one more anchor.**
``emit_anchor_source_rays`` (``optical/anchor_ops/emit_laser_source.py``)
spawns a laser's seed ray only from an anchor whose id is ``intercept_out``,
so a build carrying the bulkhead ALONE emits nothing at all. A fibre-coupled
source therefore carries BOTH, coincident at the ferrule-bore face: the
``intercept_out`` is the emit point, the ``fiber_in`` is the socket that puts
the part in ``collectFiberPortsLab``'s port list (that predicate filters on
``isFiberPortConnectorType`` alone, which is female-only since 0133). Putting
two hit-testable anchors at one point is safe in this one direction: the ray
starts exactly on its own slot's ``fiber_in`` plane, so ``intersect_anchor``
computes ``t = 0`` and drops it under ``t_min = 1e-9``. The emitter cannot hit
its own socket.

``domains`` is untouched — the derivation still yields ``["optical"]``, unlike
0131 where the detector's new coax port pulled in ``rf``.

Nothing in the catalog changes meaning: ``ts_2000_a`` is the only existing
``laser_source`` asset and it is a free-space TOSA facet with a single
``intercept_out``. The first user of the new role is the ``fiber_checker``
device/asset pair, created through the API after this lands.

⚠ **``laser_source`` is a ``locked`` kind row.** ``lock_guard`` is API-layer
only, so this migration bypasses it silently — the same situation 0126 / 0127
/ 0134 were in, and the same resolution: done with the user's explicit
authorisation (2026-08-24), leaving ``locked`` ON. See the locked-rows note in
``docs/introduce/migrations.md``.

``kinds`` must equal ``backend/data/kinds.json`` (0126, pinned by
``tests/test_kind_manifest_sync.py``), so this lands with the re-export.
One row, only the ``MANIFEST_OWNED_KIND_COLUMNS``. Forward-only like 0130-0133.

Revision ID: 0137_laser_source_fiber_bulkhead
Revises: 0136_kinds_insert_missing
"""

from __future__ import annotations

import json
import logging

import sqlalchemy as sa

from alembic import op


revision = "0137_laser_source_fiber_bulkhead"
down_revision = "0136_kinds_insert_missing"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

KIND = "laser_source"
# Columns stored as JSONB — need an explicit cast on the way in.
_JSON_COLUMNS = ("default_params", "anchor_template")


def upgrade() -> None:
    # Import inside upgrade() so alembic offline mode doesn't load the
    # manifest during SQL generation (mirrors 0126 / 0130 / 0131 / 0133).
    from app.kinds_manifest import (
        MANIFEST_OWNED_KIND_COLUMNS,
        kind_rows_from_manifest,
    )

    conn = op.get_bind()
    target = kind_rows_from_manifest().get(KIND)
    if target is None:
        log.warning("0137: %r is not in the manifest — nothing to resync", KIND)
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
        log.info("0137: resynced kind %r from the manifest", KIND)
    else:
        log.warning("0137: no %r row to resync", KIND)


def downgrade() -> None:
    """Forward-only — see the module docstring."""
