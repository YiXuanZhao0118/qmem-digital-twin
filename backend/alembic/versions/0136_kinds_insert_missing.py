"""Insert the plugin-backed ``kinds`` rows that were never created

``kinds`` must equal ``backend/data/kinds.json`` (the invariant 0126
established, pinned by ``tests/test_kind_manifest_sync.py``). Four rows have
never satisfied it: ``fiber``, ``fiber_coupler``, ``glan_polarizer`` and
``rf_cable`` have no row at all, so
``TestKindsTableMatchesManifest::test_every_plugin_has_a_row`` has been failing
continuously — long enough that it was being read as background noise, which is
the real cost of leaving a red test standing.

0126 was supposed to be the fix and it does carry an insert path; these four
simply never went through it. Nothing deletes them either — every
``DELETE FROM kinds`` in the tree is in some other migration's ``downgrade``,
for a different kind. They were never inserted, and re-running 0126 today would
insert them, so this migration is that same insert, standing on its own.

**This is not only a red test.** A kind with no row is invisible to the Asset3D
editor's kind dropdown (it is built from this table), so the kind cannot be
assigned to an asset at all — and meanwhile **9 components already reference
``fiber`` and 3 reference ``rf_cable``**. There is no foreign key from
``components.kind_id`` to ``kinds.name``, which is exactly why a dangling
reference could sit there quietly. Those components have been pointing at
nothing.

Written generically — insert whatever the manifest has and the table lacks —
rather than hardcoding the four names, so the same body heals the next gap.
Only rows are ADDED; nothing existing is touched, including the six non-plugin
kinds that legitimately have no manifest entry (``unclassified``,
``mechanical``, ``optical_table``, ``isolator``, ``rect_annotation``,
``text_annotation``), which the invariant permits since it is
manifest-subset-of-table, not equality.

``domains`` is written here even though it is not one of
``MANIFEST_OWNED_KIND_COLUMNS`` (that column is user-editable, so a *resync*
deliberately leaves it alone). An INSERT has no prior value to preserve, and
the column is ``NOT NULL`` with a ``cardinality >= 1`` check, so it has to come
from the manifest derivation like every other column on a fresh row. Same
choice 0126's insert path makes.

Verified after applying: the live scene traces bit-identically (51 lab
segments, total path 12807.6443 mm, same per-segment powers) — adding a kind
row gives the components a definition they were already behaving as if they
had.

Forward-only, like 0129-0135. A generic "insert whatever is missing" has no
honest inverse: at downgrade time there is no record of which rows this
migration created versus which were already there, and deleting a kind an
asset has since been assigned to would leave that asset pointing at nothing
(again, no FK to stop it). Dropping four rows by hand is a one-liner if it is
ever actually wanted.

Revision ID: 0136_kinds_insert_missing
Revises: 0135_fiber_conn_anchor_rename
"""

from __future__ import annotations

import json
import logging

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY

from alembic import op


revision = "0136_kinds_insert_missing"
down_revision = "0135_fiber_conn_anchor_rename"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

# Columns stored as JSONB — need an explicit cast on the way in.
_JSON_COLUMNS = ("default_params", "anchor_template")


def _missing(conn) -> dict:
    from app.kinds_manifest import kind_rows_from_manifest

    want = kind_rows_from_manifest()
    have = {
        r[0] for r in conn.execute(sa.text("SELECT name FROM kinds")).fetchall()
    }
    return {name: row for name, row in sorted(want.items()) if name not in have}


def upgrade() -> None:
    # Import inside upgrade() so alembic offline mode doesn't load the
    # manifest during SQL generation (mirrors 0126 / 0130-0135).
    conn = op.get_bind()
    missing = _missing(conn)
    if not missing:
        log.info("0136: every manifest kind already has a row — nothing to do")
        return

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

    for name, target in missing.items():
        params = {"name": name, **target}
        for col in _JSON_COLUMNS:
            params[col] = json.dumps(params[col])
        conn.execute(insert_stmt, params)
        log.info(
            "0136: inserted missing kind %r (op_set=%s, domains=%s)",
            name, target["op_set_name"], target["domains"],
        )
    log.info("0136: %d kinds row(s) inserted", len(missing))


def downgrade() -> None:
    """Forward-only — see the module docstring."""
