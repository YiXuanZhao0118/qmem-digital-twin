"""AOM assets diffract at the rated operating point without an RF link.

MT80_A1_5_IR0's Asset3D carried ``default_params.requiresRfDrive = true``,
which gates first-order efficiency to 0 whenever no RF drive power is
resolved. With no RF link wired up the traced beam therefore passed
straight through (0 order only) while the Object Panel still showed the
rated η = 0.85 multi-order table — panel and beams disagreed.

Per the product decision, an AOM should visualise its rated diffraction
(80 MHz, η = 0.85, multi-order) even before an RF source is connected.
Flip ``requiresRfDrive`` to false on every AOM asset that currently gates
on it. Idempotent. (RF still drives the Bragg angle / Doppler / detune; it
just no longer gates the cell off.)
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0100_aom_rated_no_rf"
down_revision = "0099_aom_acoustic_axis_anchor"
branch_labels = None
depends_on = None


def _set_requires_rf_drive(target: bool, match) -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text("SELECT id, default_params FROM assets_3d WHERE kind_id = 'aom'")
    ).mappings().fetchall()
    for row in rows:
        params = dict(row["default_params"] or {})
        if not match(params.get("requiresRfDrive")):
            continue
        params["requiresRfDrive"] = target
        bind.execute(
            sa.text(
                "UPDATE assets_3d SET default_params = CAST(:p AS JSONB) WHERE id = :id"
            ),
            {"p": json.dumps(params), "id": row["id"]},
        )


def upgrade() -> None:
    # Touch only assets that currently gate (requiresRfDrive truthy).
    _set_requires_rf_drive(False, match=lambda v: v is True)


def downgrade() -> None:
    # Best-effort reverse: re-gate AOM assets we would have flipped off.
    _set_requires_rf_drive(True, match=lambda v: v is False)
