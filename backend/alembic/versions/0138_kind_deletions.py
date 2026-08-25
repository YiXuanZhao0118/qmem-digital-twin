"""Deleting a kind is permanent — ``kind_deletions`` tombstones

Until now a kind deleted in the Kinds editor came back. Not because anything
at FastAPI startup re-creates it (nothing does), but because
``restart-stack.ps1`` runs ``alembic upgrade head`` first, and two migrations
insert whatever ``backend/data/kinds.json`` has and the table lacks: 0126's
insert path and 0136 wholesale. 0136's own docstring is the evidence — it
claims ``fiber`` / ``fiber_coupler`` / ``glan_polarizer`` / ``rf_cable``
"were never inserted" and that "nothing deletes them", when in fact
``DELETE /api/kinds/{id}`` had deleted them and 0136 put them back.

Only manifest-backed kinds ever resurrected, which is why the behaviour read
as arbitrary: delete ``isolator`` or ``unclassified`` (no plugin) and it stays
deleted; delete ``spectrometer`` and it is back after the next migration runs.

A tombstone makes the rule uniform for EVERY kind: the manifest proposes, a
user deletion disposes. ``kind_deletions`` holds one row per deleted name, and
a BEFORE INSERT trigger on ``kinds`` silently skips any insert whose name is
tombstoned.

**Why a trigger rather than filtering in each migration.** The filter would
have to be remembered by every future migration author, and this table's
history is precisely that failure mode — 0086 inlined its backfill, nothing
re-ran it, and 24 of 31 rows had fossilised by the time anyone diffed them.
A trigger cannot be forgotten. It skips rather than raises so that an
"insert whatever is missing" migration stays runnable: raising would abort
``alembic upgrade head``, and then the backend does not start at all.

Re-creating a deleted kind is still possible and is the tombstone's release
valve — ``POST /api/kinds`` drops the tombstone before inserting, so the
Kinds editor can bring a kind back by hand at any time.

**Why the tombstone is written by the API and not by an AFTER DELETE
trigger.** A trigger would catch every delete, including the delete half of a
migration that removes a kind in order to re-insert it under a new shape (a
rename, a split). The re-insert would then be skipped and the migration would
half-apply. Tombstoning is a statement of intent — "the user decided this kind
does not belong in the catalog" — and only the API layer knows that.

Three data steps, in order:

  1. Restore ``fiber`` and ``rf_cable`` from the manifest if absent. Both had
     been deleted but are still in use: 9 components reference ``fiber`` and 3
     reference ``rf_cable``, and ``fiber`` has real ray-tracing ops registered
     in ``app/optical/kinds/fiber/physics.py``. There is no FK from
     ``components.kind_id`` to ``kinds.name``, which is why those 12 rows
     could sit there pointing at nothing.
  2. Delete and tombstone the seven in ``_TOMBSTONE`` — the kinds deleted in
     the editor on 2026-08-24, none of them referenced by any Asset3D or
     Component. Named explicitly rather than "whatever is missing right now"
     so the migration lands the same way on any checkout; deriving the list
     from live table state would record one machine's accident as everyone's
     intent. A kind that turns out to be referenced is left alone with a
     warning — resurrecting the dangling-reference bug 0136 documented would
     be a poor trade for tidiness.
  3. Install the table + trigger.

The plugins stay in the frontend registry. Removing one is an 8-14 file change
across the ``ElementKind`` union, ``optical/registry.ts``, ``rayTrace.ts``,
``materials.ts``, ``beamPlacement.ts`` and two exhaustiveness test lists, and
it deletes the kind's physics model outright. The tombstone gets the same
catalog result while keeping the model available for the day the hardware
shows up.

Revision ID: 0138_kind_deletions
Revises: 0137_laser_source_fiber_bulkhead
"""

from __future__ import annotations

import json
import logging

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY

from alembic import op


revision = "0138_kind_deletions"
down_revision = "0137_laser_source_fiber_bulkhead"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

# Deleted, but still referenced by components — restore rather than tombstone.
_RESTORE = ("fiber", "rf_cable")

# Deleted deliberately in the Kinds editor, unreferenced anywhere.
_TOMBSTONE = (
    "beam_dump",
    "fiber_coupler",
    "glan_polarizer",
    "horn_antenna",
    "nonlinear_crystal",
    "saturable_absorber",
    "spectrometer",
)

_NOTE = "deleted in the Kinds editor 2026-08-24; recorded by 0138"

# Columns stored as JSONB — need an explicit cast on the way in.
_JSON_COLUMNS = ("default_params", "anchor_template")

_INSERT_KIND = sa.text(
    "INSERT INTO kinds ("
    "name, display_name, op_set_name, domains, default_params, "
    "anchor_template, needs_aperture, description"
    ") VALUES ("
    ":name, :display_name, :op_set_name, :domains, "
    "CAST(:default_params AS JSONB), CAST(:anchor_template AS JSONB), "
    ":needs_aperture, :description"
    ") ON CONFLICT (name) DO NOTHING"
).bindparams(sa.bindparam("domains", type_=ARRAY(sa.Text())))


def _references(conn, name: str) -> int:
    """Rows pointing at this kind. Neither column has an FK to enforce it."""
    return conn.execute(
        sa.text(
            "SELECT (SELECT count(*) FROM assets_3d WHERE kind_id = :n)"
            "     + (SELECT count(*) FROM components WHERE kind_id = :n)"
        ),
        {"n": name},
    ).scalar_one()


def upgrade() -> None:
    # Import inside upgrade() so alembic offline mode doesn't load the
    # manifest during SQL generation (mirrors 0126 / 0136).
    from app.kinds_manifest import kind_rows_from_manifest

    conn = op.get_bind()
    want = kind_rows_from_manifest()
    have = {r[0] for r in conn.execute(sa.text("SELECT name FROM kinds")).fetchall()}

    # --- 1. restore the two in-use kinds --------------------------------
    for name in _RESTORE:
        if name in have:
            log.info("0138: %r already present — nothing to restore", name)
            continue
        target = want.get(name)
        if target is None:
            log.warning("0138: %r is not in the manifest — cannot restore", name)
            continue
        params = {"name": name, **target}
        for col in _JSON_COLUMNS:
            params[col] = json.dumps(params[col])
        conn.execute(_INSERT_KIND, params)
        log.info("0138: restored in-use kind %r", name)

    # --- 2. the tombstone table -----------------------------------------
    op.create_table(
        "kind_deletions",
        sa.Column("name", sa.Text(), primary_key=True),
        sa.Column(
            "deleted_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("note", sa.Text()),
    )

    tombstoned = 0
    for name in _TOMBSTONE:
        used = _references(conn, name)
        if used:
            log.warning(
                "0138: %r is referenced by %d asset/component row(s) — left in "
                "place, not tombstoned",
                name,
                used,
            )
            continue
        conn.execute(sa.text("DELETE FROM kinds WHERE name = :n"), {"n": name})
        conn.execute(
            sa.text(
                "INSERT INTO kind_deletions (name, note) VALUES (:name, :note) "
                "ON CONFLICT (name) DO NOTHING"
            ),
            {"name": name, "note": _NOTE},
        )
        tombstoned += 1
        log.info("0138: tombstoned %r", name)
    log.info("0138: %d of %d kind(s) tombstoned", tombstoned, len(_TOMBSTONE))

    # --- 3. the guard ----------------------------------------------------
    # Skip, don't raise: an "insert whatever is missing" migration must stay
    # runnable, and aborting `alembic upgrade head` would keep the backend
    # from starting at all.
    op.execute(
        sa.text(
            """
            CREATE FUNCTION kinds_skip_tombstoned() RETURNS trigger AS $$
            BEGIN
              IF EXISTS (SELECT 1 FROM kind_deletions d WHERE d.name = NEW.name)
              THEN
                RAISE NOTICE
                  'kinds: insert of % skipped - tombstoned in kind_deletions',
                  NEW.name;
                RETURN NULL;
              END IF;
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
            """
        )
    )
    op.execute(
        sa.text(
            "CREATE TRIGGER kinds_skip_tombstoned_trg "
            "BEFORE INSERT ON kinds FOR EACH ROW "
            "EXECUTE FUNCTION kinds_skip_tombstoned()"
        )
    )


def downgrade() -> None:
    """Drops the guard and the tombstones.

    Neither data step is reversed. The step-1 restore stays because those rows
    are what 12 components point at, and the step-2 deletions stay because
    re-inserting them is what this migration exists to stop — a downgrade that
    resurrected them would hand back the exact bug. Same forward-only stance
    0136 took. Re-inserting a kind by hand is a one-liner if it is ever wanted.
    """
    op.execute(sa.text("DROP TRIGGER IF EXISTS kinds_skip_tombstoned_trg ON kinds"))
    op.execute(sa.text("DROP FUNCTION IF EXISTS kinds_skip_tombstoned()"))
    op.drop_table("kind_deletions")
