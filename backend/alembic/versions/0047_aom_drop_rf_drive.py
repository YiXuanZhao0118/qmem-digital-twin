"""Phase B: drop AOM centerFreqMhz / rfDrivePowerW from physics_elements.kind_params

Revision ID: 0047_aom_drop_rf_drive
Revises: 0046_drop_pb_channels_inline

Phase B (RF link single-source-of-truth) removes the AOM's
``centerFreqMhz`` and ``rfDrivePowerW`` kind-params fields. They are now
resolved at solve time from the upstream rf_source channel via the AOM's
rf_in ``rfCableEndpoints`` link (see ``optics_seq.hydrate_aom_rf_drive``).

This migration strips both keys from every existing
``physics_elements.kind_params`` row whose ``element_kind = 'aom'``.

Down-migration writes default values back (80 MHz, 1.0 W) so the row can
still be parsed by pre-Phase-B code if someone rolls back. Original
per-row values are NOT restored — the source of truth post-Phase-B is the
upstream link, so the only sensible roll-back is to a default.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0047_aom_drop_rf_drive"
down_revision = "0046_drop_pb_channels_inline"
branch_labels = None
depends_on = None


KIND = "aom"
FIELDS = ("centerFreqMhz", "rfDrivePowerW")


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "SELECT id, kind_params FROM physics_elements WHERE element_kind = :kind"
        ),
        {"kind": KIND},
    ).fetchall()
    for row in rows:
        kp = row.kind_params or {}
        if not isinstance(kp, dict):
            continue
        if not any(f in kp for f in FIELDS):
            continue
        new_kp = {k: v for k, v in kp.items() if k not in FIELDS}
        conn.execute(
            sa.text(
                "UPDATE physics_elements SET kind_params = CAST(:kp AS JSONB) "
                "WHERE id = :id"
            ),
            {"kp": json.dumps(new_kp), "id": row.id},
        )


def downgrade() -> None:
    # Best-effort: reinstate the defaults the pre-Phase-B schema used. The
    # historic per-row values are no longer recoverable from any source —
    # the canonical state moved to the upstream rf_source channel before
    # this migration, so 80 MHz / 1.0 W is the safest round-trip default
    # for legacy readers.
    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "SELECT id, kind_params FROM physics_elements WHERE element_kind = :kind"
        ),
        {"kind": KIND},
    ).fetchall()
    for row in rows:
        kp = row.kind_params or {}
        if not isinstance(kp, dict):
            kp = {}
        new_kp = dict(kp)
        new_kp.setdefault("centerFreqMhz", 80.0)
        new_kp.setdefault("rfDrivePowerW", 1.0)
        conn.execute(
            sa.text(
                "UPDATE physics_elements SET kind_params = CAST(:kp AS JSONB) "
                "WHERE id = :id"
            ),
            {"kp": json.dumps(new_kp), "id": row.id},
        )
