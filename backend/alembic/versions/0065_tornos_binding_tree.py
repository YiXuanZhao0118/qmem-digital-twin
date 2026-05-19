"""seed TORNOS-850-4 isolator with 2 PBS sub-Component bindings

Revision ID: 0065_tornos_binding_tree
Revises: 0064_asset_properties

Stage A''.4 — first real ComponentBinding migration. TORNOS-850-4 is
the simplest of the 7 catalog isolator models (no Glan-Laser, no
IOT-series rotatable polariser ring, no STL deletion data) so it's
the cleanest test case for the binding-tree path before it ships
behind Stage A''.5's allowlist flip.

After this migration TORNOS-850-4's binding tree looks like::

    root  (asset=coherent_tornos_850_4_primitive, role=body,
           identity transform)                       ← 0062 backfill
    ├─ front_pbs  (subcomponent=PBS252, local=(0,0,-13),
    │              ry_deg=0, tunable_axes.ry_deg)
    └─ back_pbs   (subcomponent=PBS252, local=(0,0,+13),
                   ry_deg=90, tunable_axes.ry_deg)

The (0, 0, ±13) positions + (0° / 90°) y-rotations mirror the values
already used by ``kinds/isolator/pbsOverlay.ts::ISOLATOR_PBS_DEFAULTS_BY_MODEL``
so the binding-tree render lands visually identical to today's
bespoke pbsOverlay path. ``tunable_axes.ry_deg`` exposes the
per-instance rotation knob (matches the user's
"前 PBS Mount 相對 Faraday part 依照某個軸旋轉" requirement) — the
SceneObject's ``properties.bindingOverrides`` carries the actual
value.

Idempotent — skips if TORNOS already has sub-Component bindings.

Downgrade
---------
Deletes only the two sub-Component bindings this migration added;
preserves the 0062-backfilled root binding so a downgrade leaves
TORNOS in the "single-asset" state from before A''.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0065_tornos_binding_tree"
down_revision = "0064_asset_properties"
branch_labels = None
depends_on = None


TORNOS_MODEL = "TORNOS-850-4"
PBS_COMPONENT_NAME = "PBS252"

# ±13 mm along body-local Z (the optical axis) — matches
# ISOLATOR_PBS_DEFAULTS_BY_MODEL["TORNOS-850-4"] in pbsOverlay.ts.
FRONT_PBS_LOCAL_Z_MM = -13.0
BACK_PBS_LOCAL_Z_MM = +13.0

# y-rotation in degrees. 0° = canonical PBS cement normal (1,1,0);
# 90° rotates it to (0,1,-1) so the back PBS picks up the
# orthogonal polarisation after the Faraday 45° rotation.
FRONT_PBS_RY_DEG = 0.0
BACK_PBS_RY_DEG = 90.0

# ±90° rotation window around the default — generous enough for
# user fine-tune without letting the value wrap into the orthogonal
# polarisation by accident.
TUNABLE_RY_AXIS = {
    "frame": "parent",
    "min": -90.0,
    "max": 90.0,
    "default": 0.0,
}


def upgrade() -> None:
    bind = op.get_bind()

    tornos_row = bind.execute(
        sa.text(
            "SELECT id FROM components "
            " WHERE model = :model AND archived_at IS NULL "
            " ORDER BY created_at ASC LIMIT 1"
        ),
        {"model": TORNOS_MODEL},
    ).first()
    if tornos_row is None:
        # No TORNOS in this DB (e.g. fresh checkout pre-seed). The
        # migration runs but adds nothing — Stage A''.5's allowlist
        # flip will fall through to the legacy path until TORNOS
        # exists.
        return
    tornos_id = tornos_row.id

    pbs_row = bind.execute(
        sa.text(
            "SELECT id FROM components "
            " WHERE name = :name AND archived_at IS NULL "
            " ORDER BY created_at ASC LIMIT 1"
        ),
        {"name": PBS_COMPONENT_NAME},
    ).first()
    if pbs_row is None:
        # Same reason — no PBS252 in this DB means the PBS sub-binding
        # would point at a ghost. Skip cleanly.
        return
    pbs_id = pbs_row.id

    # Idempotency guard: skip if TORNOS already has sub-Component
    # bindings (re-run of this migration, or someone added them by
    # hand via /api/component-bindings).
    existing = bind.execute(
        sa.text(
            "SELECT COUNT(*) AS n FROM component_bindings "
            " WHERE component_id = :cid AND target_kind = 'subcomponent'"
        ),
        {"cid": tornos_id},
    ).first()
    if existing and existing.n > 0:
        return

    # Find the root binding (the one alembic 0062 backfilled). The
    # two PBS sub-bindings attach as its children.
    root_row = bind.execute(
        sa.text(
            "SELECT id FROM component_bindings "
            " WHERE component_id = :cid AND parent_binding_id IS NULL "
            " ORDER BY sort_order ASC, created_at ASC LIMIT 1"
        ),
        {"cid": tornos_id},
    ).first()
    if root_row is None:
        return
    root_id = root_row.id

    tunable = json.dumps({"ry_deg": TUNABLE_RY_AXIS})

    for label, local_z, ry_deg, sort_order in (
        ("front_pbs", FRONT_PBS_LOCAL_Z_MM, FRONT_PBS_RY_DEG, 1),
        ("back_pbs", BACK_PBS_LOCAL_Z_MM, BACK_PBS_RY_DEG, 2),
    ):
        bind.execute(
            sa.text(
                """
                INSERT INTO component_bindings (
                    component_id, parent_binding_id, target_kind,
                    sub_component_id, role,
                    local_x_mm, local_y_mm, local_z_mm,
                    local_rx_deg, local_ry_deg, local_rz_deg,
                    tunable_axes, sort_order, properties
                ) VALUES (
                    :cid, :parent, 'subcomponent', :sub, 'internal_part',
                    0, 0, :z, 0, :ry, 0,
                    CAST(:tunable AS jsonb), :sort, :props
                )
                """
            ),
            {
                "cid": tornos_id,
                "parent": root_id,
                "sub": pbs_id,
                "z": local_z,
                "ry": ry_deg,
                "tunable": tunable,
                "sort": sort_order,
                "props": json.dumps({"role_label": label}),
            },
        )


def downgrade() -> None:
    bind = op.get_bind()
    tornos_row = bind.execute(
        sa.text(
            "SELECT id FROM components "
            " WHERE model = :model ORDER BY created_at ASC LIMIT 1"
        ),
        {"model": TORNOS_MODEL},
    ).first()
    if tornos_row is None:
        return
    bind.execute(
        sa.text(
            "DELETE FROM component_bindings "
            " WHERE component_id = :cid AND target_kind = 'subcomponent'"
        ),
        {"cid": tornos_row.id},
    )
