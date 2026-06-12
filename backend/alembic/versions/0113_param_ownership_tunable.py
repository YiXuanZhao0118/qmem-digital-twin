"""Drop per-binding ``param_overrides``; add asset-authored ``tunable_params``.

Param ownership rework. The old ``objects.param_overrides`` column let an
instance override ANY intrinsic optical coefficient per binding — judged
redundant (same-spec parts should be separate assets). It is removed.

The runtime-tunable subset (laser power/wavelength, RF freq/amp, …) is kept,
but now the ASSET author decides which ``default_params`` keys are tunable via
the new ``assets_3d.tunable_params`` list. Per-instance values for those keys
live in ``objects.dynamic_sources`` (already present; now read by the anchor
loader). The SceneObject editor exposes only the tunable keys.

Backfill seeds each asset's ``tunable_params`` from its kind's
``state_param_keys`` (frontend plugin metadata, via ``backend/data/kinds.json``)
intersected with the keys actually in that asset's ``default_params``. Kinds
with no declared state keys seed ``[]``. Re-run ``npm run export:kinds`` before
upgrading so newly-declared state keys (e.g. laser_source) are picked up.

NOTE: dropping ``param_overrides`` is irreversible — ``downgrade`` recreates an
empty column; prior per-binding overrides are not restored.

Revision ID: 0113_param_ownership_tunable
Revises: 0112_add_locked_flag
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op


revision = "0113_param_ownership_tunable"
down_revision = "0112_add_locked_flag"
branch_labels = None
depends_on = None


def _state_keys_by_kind() -> dict[str, list[str]]:
    """``kind_id → declared state_param_keys`` from the kinds manifest, keyed
    by both the plugin id and its element_kind so either matches asset.kind_id.
    Kinds with no declared partition are omitted (caller defaults to [])."""
    from app.kinds_manifest import physics_plugins

    out: dict[str, list[str]] = {}
    for p in physics_plugins():
        keys = p.get("physics", {}).get("state_param_keys")
        if not isinstance(keys, list):
            continue
        out[p["id"]] = list(keys)
        ek = p.get("physics", {}).get("element_kind")
        if isinstance(ek, str):
            out[ek] = list(keys)
    return out


def upgrade() -> None:
    op.add_column(
        "assets_3d",
        sa.Column(
            "tunable_params",
            JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )

    # Backfill: tunable_params = kind's state keys ∩ asset's default_params keys.
    conn = op.get_bind()
    state_by_kind = _state_keys_by_kind()
    rows = conn.execute(
        sa.text("SELECT id, kind_id, default_params FROM assets_3d")
    ).fetchall()
    for row in rows:
        state_keys = state_by_kind.get(row.kind_id or "", [])
        if not state_keys:
            continue
        params = row.default_params if isinstance(row.default_params, dict) else {}
        tunable = [k for k in state_keys if k in params]
        if not tunable:
            continue
        conn.execute(
            sa.text(
                "UPDATE assets_3d SET tunable_params = CAST(:val AS JSONB) "
                "WHERE id = :id"
            ),
            {"val": json.dumps(tunable), "id": row.id},
        )

    op.drop_column("objects", "param_overrides")


def downgrade() -> None:
    op.add_column(
        "objects",
        sa.Column("param_overrides", JSONB(), nullable=True),
    )
    op.drop_column("assets_3d", "tunable_params")
