"""drop per-instance waveplate fastAxisDegBeamLocal

Revision ID: 0060_waveplate_fast_axis_asset
Revises: 0059_drop_per_object_aperture

Asset-level fast-axis refactor (2026-05-18): the waveplate's fast-axis
angle is now defined exclusively on the Asset3D anchor (PHY Editor →
Optical → Components, ``intercept_in.fastAxisDegBodyLocal``) and the
per-instance rotation around the beam axis lives on
``scene_objects.properties.rotationAroundBeamAxisDeg``. The solver
composes effective angle = asset + per-instance scalar at run time via
``hydrate_waveplate_fast_axis``.

This migration drains the legacy per-instance angles from
``physics_elements.kind_params`` / ``intrinsic_params`` /
``state_params`` for every waveplate row. The previous values are
discarded (clean cut, no archival) — the WaveplateAdjustControls Object
panel knob lets the user re-establish each instance's rotation.

Idempotent — rerunning is a no-op once the JSONB is clean.

Downgrade
---------
No-op stub. Restoring per-instance angles would require a database
backup.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0060_waveplate_fast_axis_asset"
down_revision = "0059_drop_per_object_aperture"
branch_labels = None
depends_on = None


LEGACY_KEYS = ("fastAxisDegBeamLocal", "fastAxisDeg")
JSON_COLUMNS = ("kind_params", "intrinsic_params", "state_params")


def _strip(value: object) -> tuple[object, bool]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return value, False
    if not isinstance(value, dict):
        return value, False
    changed = False
    out = dict(value)
    for key in LEGACY_KEYS:
        if key in out:
            out.pop(key)
            changed = True
    return out, changed


def upgrade() -> None:
    bind = op.get_bind()

    rows = bind.execute(
        sa.text(
            "SELECT object_id, kind_params, intrinsic_params, state_params "
            "FROM physics_elements WHERE element_kind = 'waveplate'"
        )
    ).fetchall()

    for row in rows:
        object_id = row[0]
        new_values: dict[str, str] = {}
        for idx, column in enumerate(JSON_COLUMNS, start=1):
            cleaned, changed = _strip(row[idx])
            if changed:
                new_values[column] = json.dumps(cleaned)
        if not new_values:
            continue
        sets = ", ".join(f"{col} = CAST(:{col} AS JSONB)" for col in new_values)
        bind.execute(
            sa.text(
                f"UPDATE physics_elements SET {sets} WHERE object_id = :oid"
            ),
            {**new_values, "oid": object_id},
        )


def downgrade() -> None:
    # Clean cut — per-instance angles are not preserved.
    pass
