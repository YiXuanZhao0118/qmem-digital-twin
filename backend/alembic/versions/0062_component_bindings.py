"""component_bindings table: polymorphic asset|subcomponent tree + tunable_axes

Revision ID: 0062_component_bindings
Revises: 0061_tornos_dedicated_asset

Generalises ``Component.asset_3d_id`` (single FK to one Asset3D) into a
binding tree: a Component is composed of N bindings, each holding either
raw geometry (``target_kind='asset'``) or another Component
(``target_kind='subcomponent'``), positioned by a local transform
relative to its parent binding (or to the Component origin when
``parent_binding_id`` is NULL).

Motivating case: Faraday isolator = body + 2 end caps + 2 PBS sub-components,
where the end caps rotate independently around the body's frame to tune
isolation. The bespoke STL-triangle-partitioning logic in
``kinds/isolator/pbsOverlay.ts`` (``IsolatorLinkedRotationGroup``) is the
special-case version of this; the binding tree generalises it so the
same pattern works for mirror mounts, DDS chassis, etc.

Per-instance DoF
-----------------
Each binding's ``tunable_axes`` JSONB declares which Euler axes a
SceneObject can override per-instance, in which frame, with what bounds.
Shape::

    {
      "rz_deg": { "frame": "parent", "min": -5, "max": 5, "default": 0 }
    }

Per-instance values live on ``SceneObject.properties.bindingOverrides``
keyed by binding id, so two instances of the same Component template can
have independently tuned end caps.

Backfill
--------
Every existing Component with non-null ``asset_3d_id`` gets one root
binding (``parent_binding_id=NULL``, ``target_kind='asset'``, identity
transform, ``role='body'``). ``Component.asset_3d_id`` is NOT dropped
here — Stage G removes it once all read paths have moved off it.

Idempotent — rerunning is a no-op once the table exists; the backfill
INSERT skips components that already have at least one binding.

Downgrade
---------
Drops the table. Component.asset_3d_id pointers survive, so existing
single-asset components keep rendering via the legacy path.
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID

from alembic import op


revision = "0062_component_bindings"
down_revision = "0061_tornos_dedicated_asset"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "component_bindings",
        sa.Column(
            "id",
            PG_UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "component_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("components.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "parent_binding_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("component_bindings.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("target_kind", sa.Text(), nullable=False),
        sa.Column(
            "asset_3d_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("assets_3d.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column(
            "sub_component_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("components.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("role", sa.Text(), nullable=False, server_default="body"),
        sa.Column("local_x_mm", sa.Float(), nullable=False, server_default="0"),
        sa.Column("local_y_mm", sa.Float(), nullable=False, server_default="0"),
        sa.Column("local_z_mm", sa.Float(), nullable=False, server_default="0"),
        sa.Column("local_rx_deg", sa.Float(), nullable=False, server_default="0"),
        sa.Column("local_ry_deg", sa.Float(), nullable=False, server_default="0"),
        sa.Column("local_rz_deg", sa.Float(), nullable=False, server_default="0"),
        sa.Column("tunable_axes", JSONB(), nullable=False, server_default="{}"),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("properties", JSONB(), nullable=False, server_default="{}"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "(asset_3d_id IS NULL) <> (sub_component_id IS NULL)",
            name="ck_component_bindings_one_target",
        ),
        sa.CheckConstraint(
            "(target_kind = 'asset' AND asset_3d_id IS NOT NULL AND sub_component_id IS NULL) OR "
            "(target_kind = 'subcomponent' AND sub_component_id IS NOT NULL AND asset_3d_id IS NULL)",
            name="ck_component_bindings_target_kind_matches",
        ),
        sa.CheckConstraint(
            "sub_component_id IS NULL OR sub_component_id <> component_id",
            name="ck_component_bindings_no_self_subref",
        ),
    )

    op.create_index(
        "ix_component_bindings_component_id",
        "component_bindings",
        ["component_id"],
    )
    op.create_index(
        "ix_component_bindings_parent_binding_id",
        "component_bindings",
        ["parent_binding_id"],
    )

    # Backfill: every component with a non-null asset_3d_id gets one root
    # binding. Skip components that already have at least one binding (so
    # the migration is idempotent if rerun after manual additions).
    op.execute(
        sa.text(
            """
            INSERT INTO component_bindings (
                component_id, parent_binding_id, target_kind, asset_3d_id,
                role, local_x_mm, local_y_mm, local_z_mm,
                local_rx_deg, local_ry_deg, local_rz_deg,
                tunable_axes, sort_order, properties
            )
            SELECT c.id, NULL, 'asset', c.asset_3d_id,
                   'body', 0, 0, 0, 0, 0, 0,
                   '{}'::jsonb, 0, '{}'::jsonb
              FROM components c
             WHERE c.asset_3d_id IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1 FROM component_bindings b
                    WHERE b.component_id = c.id
               )
            """
        )
    )


def downgrade() -> None:
    op.drop_index(
        "ix_component_bindings_parent_binding_id", table_name="component_bindings"
    )
    op.drop_index(
        "ix_component_bindings_component_id", table_name="component_bindings"
    )
    op.drop_table("component_bindings")
