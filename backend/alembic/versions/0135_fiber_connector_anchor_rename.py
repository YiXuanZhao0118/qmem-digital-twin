"""Rename the fibre connector's anchors so the whole fibre vocabulary agrees

After 0133/0134 the fibre world spoke three unrelated dialects for the same
subject. A chassis socket was ``fiber_in``; the ferrule that mates into it was
``connect_in``; the junction where the fibre enters the cable was
``connect_out``. Nothing about ``connect_in`` said "fibre", and its ``in`` was
about the CONNECTOR's topology (the end that plugs in) while ``fiber_in``'s
``in`` was about the INSTRUMENT. Two anchors a millimetre apart, both called
"in", meaning opposite things.

The fibre pair is renamed to read from the FIBRE's point of view:

    fiber_root ── the fibre is anchored into the cable here   (was connect_out)
    fiber_out  ── the fibre comes out of its connector here   (was connect_in)
    fiber_in   ── a fibre goes into an instrument here        (0133, unchanged)

Read as "where the fibre is", never "which way the light goes": both ends of a
patch cable use the SAME connector asset, so one end's ``fiber_out`` emits and
the other's receives. Direction is carried by each anchor's axisX, as always.

**Coax deliberately keeps ``connect_in`` / ``connect_out``.** The two connector
kinds shared one anchor convention; a ``fiber_*`` id would be a lie on an SMA,
and forking the shared code (``connectorBake``, ``bindingTreeObject``, the
viewer's connector resolvers) was judged worse than one lookup that accepts
both spellings — ``utils/connectorAnchors.ts`` on the frontend,
``db_scene_loader._find_anchor`` on the backend.

**``fiber_out`` is REMOVED from ``anchor_tracer.PRIMARY_ANCHOR_IDS`` in the
same change**, which is the one behavioural consequence worth stating plainly.
0133 had added ``fiber_in``/``fiber_out`` as a matched pair of chassis
bulkheads, but ``fiber_out``-as-bulkhead never got a single user, and the id
now means a CONNECTOR's mating face — which must not be hit-testable, exactly
as ``connect_in`` never was. The connector is passthrough; the traced coupling
happens on the synthesized ``intercept_in/out`` that ``_synth_fiber_slot``
derives FROM the mating face. Leaving it primary would put two hit-testable
anchors at the same point in space and make the hit order undefined.
``fiber_in`` remains the only fibre id in the set.

What this migration writes:

* the ``fiber_connector`` kind row, re-synced from ``backend/data/kinds.json``
  (its ``anchor_template`` is what changes) — same one-row form as 0129-0133;
* the 5 ``fiber_connector`` **asset** rows: anchor id ``connect_in`` ->
  ``fiber_out``, ``connect_out`` -> ``fiber_root``;
* the 5 ``fiber_connector`` **device** rows: the same, on ``role``.

No coordinate, aperture, axis or connector type is touched, and no anchor
changes which point in space it names — so no traced number moves. Verified
trace-identical against the live scene before and after.

**Writes the same four ``locked`` rows as 0134** (``pm_apc_780`` /
``pm_pc_780`` / ``sm_apc_780`` / ``sm_pc_780``) under the same explicit user
authorisation, and again leaves the ``locked`` flags ON.

Forward-only, matching 0133/0134.

Revision ID: 0135_fiber_conn_anchor_rename
Revises: 0134_fiber_connector_male_types
"""

from __future__ import annotations

import json
import logging

import sqlalchemy as sa

from alembic import op


revision = "0135_fiber_conn_anchor_rename"
down_revision = "0134_fiber_connector_male_types"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

KIND = "fiber_connector"
# Columns stored as JSONB — need an explicit cast on the way in.
_JSON_COLUMNS = ("default_params", "anchor_template")

RENAMES = {"connect_in": "fiber_out", "connect_out": "fiber_root"}


def _resync_kind(conn) -> None:
    # Import inside upgrade() so alembic offline mode doesn't load the
    # manifest during SQL generation (mirrors 0126 / 0130 / 0131 / 0133).
    from app.kinds_manifest import (
        MANIFEST_OWNED_KIND_COLUMNS,
        kind_rows_from_manifest,
    )

    target = kind_rows_from_manifest().get(KIND)
    if target is None:
        log.warning("0135: %r is not in the manifest — nothing to resync", KIND)
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
        log.info("0135: resynced kind %r from the manifest", KIND)
    else:
        log.warning("0135: no %r row to resync", KIND)


def _rename(conn, *, table: str, key_col: str, id_key: str, where: str) -> None:
    """``devices.anchors`` keeps the exporter's snake_case shape (keyed by
    ``role``); ``assets_3d.anchors`` is the materialised camelCase form (keyed
    by ``id``). Same walk, two spellings — as in 0133/0134."""
    rows = conn.execute(
        sa.text(f"SELECT {key_col}, anchors FROM {table} WHERE {where}")
    ).fetchall()
    for key, anchors in rows:
        if isinstance(anchors, str):
            anchors = json.loads(anchors)
        changed = False
        for a in anchors or []:
            renamed = RENAMES.get(a.get(id_key))
            if renamed is not None:
                a[id_key] = renamed
                changed = True
        if not changed:
            log.info("0135: %s %r already renamed", table, key)
            continue
        conn.execute(
            sa.text(
                f"UPDATE {table} SET anchors = CAST(:anchors AS JSONB) "
                f"WHERE {key_col} = :key"
            ),
            {"key": key, "anchors": json.dumps(anchors)},
        )
        log.info("0135: %s %r connect_in/out -> fiber_out/fiber_root", table, key)


def upgrade() -> None:
    conn = op.get_bind()
    _resync_kind(conn)
    _rename(
        conn, table="devices", key_col="slug", id_key="role",
        where="behavioral_kind = 'fiber_connector'",
    )
    _rename(
        conn, table="assets_3d", key_col="catalog_id", id_key="id",
        where="kind_id = 'fiber_connector'",
    )


def downgrade() -> None:
    """Forward-only — see the module docstring."""
