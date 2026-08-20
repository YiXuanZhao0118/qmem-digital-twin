"""Re-sync every plugin-backed ``kinds`` row from the manifest.

Alembic 0086 created the ``kinds`` table and backfilled it from
``backend/data/kinds.json`` **once**. Nothing ever re-ran that backfill,
so the table fossilised at the early-2026 manifest while the frontend
plugin registry — the actual source of truth — kept moving. A full diff
found 29 of the 31 physics-plugin rows out of sync — 25 with a drifted
column, 4 with no row at all. Only ``dichroic_mirror`` and ``mirror``
matched on all five owned columns. Per column: ``default_params`` 20,
``anchor_template`` 18, ``description`` 4, and ``display_name`` /
``needs_aperture`` 0. What the param drift consisted of:

*  6 values silently wrong. ``laser_source.spatialModeX/Y`` are swapped
   (fast/slow axis inverted), ``beam_splitter.polarizing`` is false where
   the plugin now defaults to a PBS, ``aom.crystalLengthMm`` is 25 vs the
   datasheet 22.4.
*  1 stale key name. ``aom.acousticVelocityMPerS`` — alembic 0101 renamed
   this to ``acousticVelocityMps`` in ``assets_3d`` and
   ``physics_elements`` but missed ``kinds``, so the exact bug 0101 set
   out to kill ("edit the velocity, the trace never sees it") survived
   here untouched.
* 20 params missing and 68 undeclared leftovers from
   ``routers/components.py::DEFAULT_KIND_PARAMS`` (line 143), including renames the
   DB never followed (``focalMm`` -> ``focalLengthMm``, ``transmission``
   -> ``transmittance``, ``retardanceLambda`` -> ``retardanceDeg``).
* 18 stale ``anchor_template`` blobs. This one had already bitten:
   ``Asset3DEditor`` builds its anchor-id picker and auto-seeds a new
   asset's anchor rows from this column, and the ``aom`` template predates
   the dedicated ``acoustic_axis`` anchor — so the one AOM asset in the
   catalog (``aa_mt80_a1_5_ir``) has no ``acoustic_axis`` and the Bragg
   solver has been falling through to its
   ``rfPropagationDirectionBodyLocal`` fallback the whole time.

Plus 4 plugins with no row at all (``fiber``, ``fiber_coupler``,
``glan_polarizer``, ``rf_cable``). They hold zero assets, but the Asset3D
editor's kind dropdown is populated from this table, so those kinds were
simply unpickable.

Scope. Overwrites exactly ``kinds_manifest.MANIFEST_OWNED_KIND_COLUMNS``
on rows whose ``name`` matches a physics plugin, and inserts the missing
ones. Rows with no matching plugin (``isolator``, ``mechanical``,
``unclassified``, and any user-created variant) are never touched.
``domains`` / ``op_set_name`` / ``locked`` / the two band columns are left
alone on existing rows — see that constant for why each outranks the
manifest.

This DOES rewrite rows flagged ``locked``. ``locked`` is an API-layer
guard (``lock_guard``) meaning "a human confirmed these numbers"; five of
the six wrong values above sit on locked rows, so honouring the flag here
would leave the worst of the drift in place. The values being installed
are the ones the running solver already uses — the plugin defaults — so
this makes the table agree with behaviour rather than changing behaviour.

Forward-only. The pre-image is stale by construction and there is nothing
worth restoring, so ``downgrade`` is a no-op (same call 0101 made). Each
changed row is logged so the alembic output records what moved.

Revision ID: 0126_kinds_manifest_resync
Revises: 0125_annotation_catalog
"""

from __future__ import annotations

import json
import logging

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY

from alembic import op


revision = "0126_kinds_manifest_resync"
down_revision = "0125_annotation_catalog"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

# Columns stored as JSONB — need an explicit cast on the way in.
_JSON_COLUMNS = ("default_params", "anchor_template")


def upgrade() -> None:
    # Import inside upgrade() so alembic offline mode doesn't load the
    # manifest during SQL generation (mirrors 0086 / 0092).
    from app.kinds_manifest import (
        MANIFEST_OWNED_KIND_COLUMNS,
        kind_rows_from_manifest,
    )

    conn = op.get_bind()
    want = kind_rows_from_manifest()

    existing = {
        row["name"]: row
        for row in conn.execute(
            sa.text(
                "SELECT name, " + ", ".join(MANIFEST_OWNED_KIND_COLUMNS) + " FROM kinds"
            )
        ).mappings()
    }

    assignments = ", ".join(
        f"{c} = CAST(:{c} AS JSONB)" if c in _JSON_COLUMNS else f"{c} = :{c}"
        for c in MANIFEST_OWNED_KIND_COLUMNS
    )
    update_stmt = sa.text(f"UPDATE kinds SET {assignments} WHERE name = :name")

    insert_stmt = sa.text(
        "INSERT INTO kinds ("
        "name, display_name, op_set_name, domains, default_params, "
        "anchor_template, needs_aperture, description"
        ") VALUES ("
        ":name, :display_name, :op_set_name, :domains, "
        "CAST(:default_params AS JSONB), CAST(:anchor_template AS JSONB), "
        ":needs_aperture, :description"
        ") ON CONFLICT (name) DO NOTHING"
    ).bindparams(sa.bindparam("domains", type_=ARRAY(sa.Text())))

    updated = inserted = 0
    for name, target in sorted(want.items()):
        row = existing.get(name)

        if row is None:
            params = {"name": name, **target}
            for col in _JSON_COLUMNS:
                params[col] = json.dumps(params[col])
            conn.execute(insert_stmt, params)
            inserted += 1
            log.info("0126: inserted missing kind %r", name)
            continue

        changed = [
            c for c in MANIFEST_OWNED_KIND_COLUMNS if not _same(c, row[c], target[c])
        ]
        if not changed:
            continue

        params = {"name": name, **{c: target[c] for c in MANIFEST_OWNED_KIND_COLUMNS}}
        for col in _JSON_COLUMNS:
            params[col] = json.dumps(params[col])
        conn.execute(update_stmt, params)
        updated += 1
        log.info("0126: resynced kind %r (%s)", name, ", ".join(changed))

    log.info(
        "0126: %d kinds rows resynced, %d inserted, %d left alone (no plugin)",
        updated,
        inserted,
        len(set(existing) - set(want)),
    )


def _same(column: str, db_value: object, target: object) -> bool:
    """Is this column already what the manifest says?

    JSONB columns come back as a ``dict`` or as a JSON ``str`` depending on
    which driver alembic is running under, so decode those before
    comparing.
    """
    if column in _JSON_COLUMNS and isinstance(db_value, str):
        db_value = json.loads(db_value)
    return _normalize(db_value) == _normalize(target)


def _normalize(value: object) -> object:
    """Numeric-tolerant deep compare helper — 2 and 2.0 are not drift."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, dict):
        return {k: _normalize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_normalize(v) for v in value]
    return value


def downgrade() -> None:
    # No-op, forward-only. The pre-image was a 2026-early manifest snapshot
    # that disagreed with the solver on 6 values and shipped a stale
    # `aom` anchor template; restoring it would reintroduce the drift this
    # migration exists to remove. Same reasoning as 0101's downgrade.
    pass
