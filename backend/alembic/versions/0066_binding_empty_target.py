"""allow ComponentBinding.target_kind = 'empty' (transform-only node)

Revision ID: 0066_binding_empty_target
Revises: 0065_tornos_binding_tree

Stage A''.5 — the binding tree needs intermediate nodes that carry a
local transform + tunable_axes but have no geometry of their own. The
canonical case is the user's "PBS Mount" node in the 5-part isolator
decomposition (前 PBS → 前 PBS Mount → Faraday body → 後 PBS Mount →
後 PBS): the Mount rotates around an axis defined relative to the
Faraday body, the PBS sub-Component is rigid to the Mount, and the
Mount itself is a structural concept without its own renderable
geometry today.

Pre-A''.5 the binding schema's CHECK constraint required exactly one
of (asset_3d_id, sub_component_id) to be non-null. This commit
relaxes that to allow ``target_kind='empty'`` where both FKs are
NULL — the renderer walker treats those nodes as transform-only and
recurses into their children.

Schema changes
--------------
- Drop ck_component_bindings_one_target + ck_component_bindings_target_kind_matches
- Replace with a single combined ck_component_bindings_target_shape
  that admits the third 'empty' shape.

Idempotent w.r.t. data — no rows are modified.
"""

from __future__ import annotations

from alembic import op


revision = "0066_binding_empty_target"
down_revision = "0065_tornos_binding_tree"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint(
        "ck_component_bindings_one_target", "component_bindings", type_="check"
    )
    op.drop_constraint(
        "ck_component_bindings_target_kind_matches",
        "component_bindings",
        type_="check",
    )
    op.create_check_constraint(
        "ck_component_bindings_target_shape",
        "component_bindings",
        "(target_kind = 'asset' AND asset_3d_id IS NOT NULL AND sub_component_id IS NULL)"
        " OR (target_kind = 'subcomponent' AND asset_3d_id IS NULL AND sub_component_id IS NOT NULL)"
        " OR (target_kind = 'empty' AND asset_3d_id IS NULL AND sub_component_id IS NULL)",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_component_bindings_target_shape", "component_bindings", type_="check"
    )
    op.create_check_constraint(
        "ck_component_bindings_one_target",
        "component_bindings",
        "(asset_3d_id IS NULL) <> (sub_component_id IS NULL)",
    )
    op.create_check_constraint(
        "ck_component_bindings_target_kind_matches",
        "component_bindings",
        "(target_kind = 'asset' AND asset_3d_id IS NOT NULL AND sub_component_id IS NULL) OR "
        "(target_kind = 'subcomponent' AND sub_component_id IS NOT NULL AND asset_3d_id IS NULL)",
    )
