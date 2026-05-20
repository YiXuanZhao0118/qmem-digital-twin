"""IO-5-850-HP: flatten Mount intermediates + add linkGroup + 0-360 tunable range

Revision ID: 0077_io_5_hp_link
Revises: 0076_object_bindings

Brings IO-5-850-HP up to parity with IO-3-850-HP (post-0075). Three
transformations in one migration since they're all data-shape changes
the user asked for in one go:

1. **Flatten Mount intermediates** — same as 0075 did for IO-3. Empty
   ``role=mount`` bindings get their pose+tunable_axes copied onto
   their children, the children get reparented to the Mount's parent
   (root), and the Mount row is deleted. After this the structure is::

       root (body)
       ├─ front_glan_laser  (subcomp PBS)
       ├─ back_glan_laser   (subcomp PBS)
       └─ ... (any front_/back_piece rows the user later bakes in)

2. **Set linkGroup on side-tagged children** — bindings whose
   ``properties.role_label`` starts with ``front_`` get
   ``properties.linkGroup = 'front'``; similarly ``back_*`` → ``back``.
   Enables BindingTreeAdjustControls to render one slider per side that
   drives BOTH the prism AND the (eventual) piece together.

3. **Widen tunable_axes.ry_deg to 0..360** — matches the IO-3 range the
   user dialed in via the slider (the catalog defines the schema; the
   UI auto-picks up min/max). Keeps frame=parent + default=0.

Pieces note
-----------
IO-3-850-HP has dedicated ``front_piece`` / ``back_piece`` asset
bindings (created in 0074 by baking the dev-page-marked partitions
into Asset3D rows with viewerHints.includeOnlyCentroids). IO-5-850-HP
doesn't yet — the user hasn't marked partitions in the dev page for
it. This migration intentionally does NOT create empty piece bindings;
once the user marks partitions for IO-5 and saves, a follow-up step
(or future generic ``bake-partitions`` endpoint) creates the rows.
For now the migration prepares everything else so adding pieces later
is a single data step rather than a schema refactor.

Idempotent — each transformation skips if its target state is already
present.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0077_io_5_hp_link"
down_revision = "0076_object_bindings"
branch_labels = None
depends_on = None


TARGET_MODEL = "IO-5-850-HP"
DEFAULT_TUNABLE_RY = {
    "frame": "parent",
    "min": 0.0,
    "max": 360.0,
    "default": 0.0,
}


def _comp_id(bind) -> str | None:
    return bind.execute(
        sa.text(
            "SELECT id FROM components WHERE model = :m AND archived_at IS NULL"
            " ORDER BY created_at ASC LIMIT 1"
        ),
        {"m": TARGET_MODEL},
    ).scalar_one_or_none()


def _flatten_mounts(bind, comp_id: str) -> None:
    mounts = bind.execute(
        sa.text(
            "SELECT id, parent_binding_id, local_x_mm, local_y_mm, local_z_mm,"
            "       local_rx_deg, local_ry_deg, local_rz_deg, tunable_axes"
            "  FROM component_bindings"
            " WHERE component_id = :cid AND target_kind = 'empty'"
        ),
        {"cid": comp_id},
    ).fetchall()
    for m in mounts:
        children = bind.execute(
            sa.text("SELECT id FROM component_bindings WHERE parent_binding_id = :mid"),
            {"mid": m.id},
        ).fetchall()
        for child in children:
            bind.execute(
                sa.text(
                    """
                    UPDATE component_bindings
                       SET parent_binding_id = :new_parent,
                           local_x_mm   = :x,  local_y_mm   = :y,  local_z_mm   = :z,
                           local_rx_deg = :rx, local_ry_deg = :ry, local_rz_deg = :rz,
                           tunable_axes = CAST(:tun AS jsonb)
                     WHERE id = :id
                    """
                ),
                {
                    "id": child.id,
                    "new_parent": m.parent_binding_id,
                    "x": m.local_x_mm, "y": m.local_y_mm, "z": m.local_z_mm,
                    "rx": m.local_rx_deg, "ry": m.local_ry_deg, "rz": m.local_rz_deg,
                    "tun": json.dumps(dict(m.tunable_axes or {})),
                },
            )
        bind.execute(
            sa.text("DELETE FROM component_bindings WHERE id = :id"),
            {"id": m.id},
        )


def _apply_linkgroup_and_range(bind, comp_id: str) -> None:
    rows = bind.execute(
        sa.text(
            "SELECT id, properties, tunable_axes"
            "  FROM component_bindings"
            " WHERE component_id = :cid AND parent_binding_id IS NOT NULL"
        ),
        {"cid": comp_id},
    ).fetchall()
    for row in rows:
        props = dict(row.properties or {})
        role = props.get("role_label") or ""
        side = (
            "front" if role.startswith("front_")
            else "back" if role.startswith("back_")
            else None
        )
        if side is None:
            continue
        props["linkGroup"] = side
        axes = dict(row.tunable_axes or {})
        # Only touch ry_deg — keep any other axes intact.
        if "ry_deg" in axes:
            cur = dict(axes["ry_deg"])
            cur["min"] = 0
            cur["max"] = 360
            axes["ry_deg"] = cur
        else:
            axes["ry_deg"] = dict(DEFAULT_TUNABLE_RY)
        bind.execute(
            sa.text(
                "UPDATE component_bindings SET properties = CAST(:p AS jsonb),"
                " tunable_axes = CAST(:t AS jsonb) WHERE id = :id"
            ),
            {"id": row.id, "p": json.dumps(props), "t": json.dumps(axes)},
        )


def upgrade() -> None:
    bind = op.get_bind()
    cid = _comp_id(bind)
    if cid is None:
        return
    _flatten_mounts(bind, cid)
    _apply_linkgroup_and_range(bind, cid)


def downgrade() -> None:
    # Strip linkGroup + revert ry_deg to the prior -90..90 range. Mount
    # flattening isn't reversed here (mirrors 0075's downgrade caveat —
    # the children's poses absorb the Mount's, so re-introducing an
    # empty Mount would need to guess the original split). The legacy
    # Mount-layered structure is no longer wired into the renderer, so
    # not restoring it is safe.
    bind = op.get_bind()
    cid = _comp_id(bind)
    if cid is None:
        return
    rows = bind.execute(
        sa.text(
            "SELECT id, properties, tunable_axes"
            "  FROM component_bindings"
            " WHERE component_id = :cid AND parent_binding_id IS NOT NULL"
        ),
        {"cid": cid},
    ).fetchall()
    for row in rows:
        props = dict(row.properties or {})
        props.pop("linkGroup", None)
        axes = dict(row.tunable_axes or {})
        if "ry_deg" in axes:
            cur = dict(axes["ry_deg"])
            cur["min"] = -90
            cur["max"] = 90
            axes["ry_deg"] = cur
        bind.execute(
            sa.text(
                "UPDATE component_bindings SET properties = CAST(:p AS jsonb),"
                " tunable_axes = CAST(:t AS jsonb) WHERE id = :id"
            ),
            {"id": row.id, "p": json.dumps(props), "t": json.dumps(axes)},
        )
