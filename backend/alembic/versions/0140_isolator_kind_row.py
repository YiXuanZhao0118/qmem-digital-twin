"""Insert the ``isolator`` kind row on a database built from migrations

The ``isolator`` kind was created by hand in the Kinds editor (2026-05-27) and
has never been in a migration. The dev DB has it, so nothing looked wrong
there. A database built from ``alembic upgrade head`` alone (CI, a fresh
install) does not have it, and that is not only a red
``test_unbacked_rows_are_the_known_placeholders``. The row is load-bearing:
0123 seeds four devices with ``behavioral_kind='isolator'``
(``io5_850_front`` / ``io5_850_back`` / ``tornos_front`` / ``tornos_back``),
and pointing an asset at one of them makes ``v3_catalog.py`` write
``kind_id='isolator'`` onto that asset. With no ``kinds`` row that asset
points at nothing. ``assets_3d.kind_id`` has no FK, so nothing stops it,
and the Asset3D editor's kind dropdown is built from this table, so the
editor cannot show or pick the kind either.

The row inserted here is the live one copied column for column (read via
``GET /api/kinds`` on 2026-09-22). ``id`` / ``created_at`` / ``updated_at``
are left to their server defaults because they are row identity, not
content. ``locked`` is copied as well. A human confirmed this row and froze
it, and a fresh install should get the same frozen row, not an editable
copy of it.

It only ever adds the row, never changes one:

  * the row exists (the dev DB and any DB that has it) -> nothing happens.
    The pre-check returns early, and ``ON CONFLICT (name) DO NOTHING`` backs
    it up. The existing ``locked`` row is never written, so no ``lock_guard``
    question comes up.
  * the name is tombstoned in ``kind_deletions`` (0138, i.e. a user deleted
    it on purpose) -> nothing happens. 0138's BEFORE INSERT trigger would
    skip the insert anyway; the explicit check is here so the log says why.

Forward-only, like 0136 / 0138. At downgrade time a row this migration
inserted looks exactly like the hand-authored one, and deleting it would
strand the four devices above. It is also ``locked``.

Revision ID: 0140_isolator_kind_row
Revises: 0139_drop_device_state_power
"""

from __future__ import annotations

import json
import logging

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY

from alembic import op


revision = "0140_isolator_kind_row"
down_revision = "0139_drop_device_state_power"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

KIND_NAME = "isolator"

# Verbatim from the live row. wavelength_range_nm / frequency_range_mhz are
# NULL there and are left NULL here.
_ROW = {
    "name": KIND_NAME,
    "display_name": "Optical Isolator",
    "domains": ["mechanical"],
    "op_set_name": "none",
    "default_params": {},
    "anchor_template": {
        "optional": [],
        "required": [],
        "needs_aperture": [],
        "needs_direction": [],
    },
    "needs_aperture": False,
    "description": (
        "Composite isolator housing — sub-components (faraday + polarizers) "
        "carry the physics. This kind is a mechanical wrapper; no anchors "
        "needed."
    ),
    "locked": True,
}

# Columns stored as JSONB — need an explicit cast on the way in.
_JSON_COLUMNS = ("default_params", "anchor_template")


def upgrade() -> None:
    conn = op.get_bind()

    if conn.execute(
        sa.text("SELECT 1 FROM kinds WHERE name = :n"), {"n": KIND_NAME}
    ).first():
        log.info("0140: %r kind already present — left untouched", KIND_NAME)
        return

    if conn.execute(
        sa.text("SELECT 1 FROM kind_deletions WHERE name = :n"), {"n": KIND_NAME}
    ).first():
        log.info("0140: %r is tombstoned in kind_deletions — not inserted", KIND_NAME)
        return

    params = dict(_ROW)
    for col in _JSON_COLUMNS:
        params[col] = json.dumps(params[col])
    conn.execute(
        sa.text(
            "INSERT INTO kinds ("
            "name, display_name, op_set_name, domains, default_params, "
            "anchor_template, needs_aperture, description, locked"
            ") VALUES ("
            ":name, :display_name, :op_set_name, :domains, "
            "CAST(:default_params AS JSONB), CAST(:anchor_template AS JSONB), "
            ":needs_aperture, :description, :locked"
            ") ON CONFLICT (name) DO NOTHING"
        ).bindparams(sa.bindparam("domains", type_=ARRAY(sa.Text()))),
        params,
    )
    log.info("0140: inserted the %r kind row", KIND_NAME)


def downgrade() -> None:
    """Forward-only. See the module docstring."""
