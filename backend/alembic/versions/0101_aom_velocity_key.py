"""Unify the AOM acoustic-velocity param key to ``acousticVelocityMps``.

The acoustic velocity lived under two names: the solver / anchor-op read
``acousticVelocityMps`` while the kind default + frontend wrote
``acousticVelocityMPerS`` — so editing the velocity silently never reached
the trace (it fell back to the 4200 m/s default). The code is now unified on
``acousticVelocityMps``; this renames the key in stored JSON so existing rows
keep their value.

Renames ``acousticVelocityMPerS`` -> ``acousticVelocityMps`` in
``assets_3d.default_params`` and ``physics_elements.kind_params`` wherever the
old key is present and the new one is not. Idempotent.
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0101_aom_velocity_key"
down_revision = "0100_aom_rated_no_rf"
branch_labels = None
depends_on = None

OLD = "acousticVelocityMPerS"
NEW = "acousticVelocityMps"


def _rename(table: str, column: str, old: str, new: str) -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(f"SELECT id, {column} AS data FROM {table}")
    ).mappings().fetchall()
    for row in rows:
        data = row["data"]
        if not isinstance(data, dict) or old not in data:
            continue
        params = dict(data)
        params.setdefault(new, params[old])
        params.pop(old, None)
        bind.execute(
            sa.text(
                f"UPDATE {table} SET {column} = CAST(:p AS JSONB) WHERE id = :id"
            ),
            {"p": json.dumps(params), "id": row["id"]},
        )


def upgrade() -> None:
    _rename("assets_3d", "default_params", OLD, NEW)
    _rename("physics_elements", "kind_params", OLD, NEW)


def downgrade() -> None:
    # No-op: the canonical key is now acousticVelocityMps and the anchor op has
    # always read it, so renaming back would corrupt rows that were already Mps
    # (e.g. the MT80 asset) without any benefit. Forward-only.
    pass
