"""object_bindings table: per-SceneObject overrides on ComponentBinding pose

Revision ID: 0076_object_bindings
Revises: 0075_io_3_hp_flatten_mounts

Promotes the ad-hoc ``SceneObject.properties.bindingOverrides`` JSON dict
(introduced as a prototype in the IsolatorObjectControls work) into a
first-class table.

Why
---
The properties-JSON approach worked for the initial isolator rotation
prototype but lacks the integrity / discoverability of a proper entity:

* no FK to ``component_bindings`` → overrides aren't cascade-deleted
  when a binding goes away
* no DB indexes → can't ask "show me every override for binding X"
* no WS event channel → other clients don't see live changes
* no schema validation → typos in axis names ride along silently

The new ``object_bindings`` table mirrors ``component_bindings``'s shape
but lives at the SceneObject layer: rows say "this scene object overrides
this component binding by these per-axis deltas (and optionally swaps the
target asset)". The renderer composes ``effective = component_binding.local*
+ object_binding.delta*`` per axis at draw time, matching the additive
``_effectiveTransform`` semantics already in
``utils/componentBindings.ts``.

Per-axis nullability
--------------------
Deltas are ``nullable=True`` (not ``DEFAULT 0`` like the component_bindings
baseline) so the renderer can distinguish "no override declared for this
axis" from "explicit 0 override". Sparse storage avoids row-bloat for the
common case where only one axis (e.g. ``ry_deg``) is being tweaked.

asset_3d_id_override
--------------------
The same row optionally swaps which Asset3D the binding renders — covers
the "this isolator instance uses a damaged housing variant" case the
SceneObject ↔ Asset3D discussion surfaced. Nullable; NULL means "use the
binding's declared asset".

Unique (object_id, component_binding_id)
----------------------------------------
At most one ObjectBinding per (SceneObject, ComponentBinding) — overrides
compose, they don't stack.

Backfill
--------
Walks every ``scene_objects.properties->'bindingOverrides'`` entry and
turns it into a row, then strips the legacy key from properties. Wrapped
in NOT EXISTS so the migration is idempotent across reruns.

Downgrade
---------
Reverses the backfill (stuffs each row back into
``properties.bindingOverrides``) before dropping the table, so a
downgrade-then-upgrade round-trip preserves state.
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID

from alembic import op


revision = "0076_object_bindings"
down_revision = "0075_io_3_hp_flatten_mounts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "object_bindings",
        sa.Column(
            "id",
            PG_UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "object_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("objects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "component_binding_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("component_bindings.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Per-axis delta overrides — nullable so "no override" is
        # distinguishable from "explicit 0".
        sa.Column("local_x_mm_delta", sa.Float(), nullable=True),
        sa.Column("local_y_mm_delta", sa.Float(), nullable=True),
        sa.Column("local_z_mm_delta", sa.Float(), nullable=True),
        sa.Column("local_rx_deg_delta", sa.Float(), nullable=True),
        sa.Column("local_ry_deg_delta", sa.Float(), nullable=True),
        sa.Column("local_rz_deg_delta", sa.Float(), nullable=True),
        # Optional per-instance asset swap on the same binding.
        sa.Column(
            "asset_3d_id_override",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("assets_3d.id", ondelete="RESTRICT"),
            nullable=True,
        ),
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
        sa.UniqueConstraint(
            "object_id",
            "component_binding_id",
            name="uq_object_bindings_object_binding",
        ),
    )

    op.create_index(
        "ix_object_bindings_object_id",
        "object_bindings",
        ["object_id"],
    )
    op.create_index(
        "ix_object_bindings_component_binding_id",
        "object_bindings",
        ["component_binding_id"],
    )

    # Backfill from SceneObject.properties.bindingOverrides. The legacy
    # JSON shape is:
    #   properties.bindingOverrides[<bindingId>] = {
    #     rxDeg?, ryDeg?, rzDeg?, xMm?, yMm?, zMm?
    #   }
    # We insert one row per (objectId, bindingId) pair, then strip the
    # legacy key. Idempotent: the NOT EXISTS guard means rerunning won't
    # double-insert.
    op.execute(
        sa.text(
            """
            INSERT INTO object_bindings (
                object_id, component_binding_id,
                local_x_mm_delta, local_y_mm_delta, local_z_mm_delta,
                local_rx_deg_delta, local_ry_deg_delta, local_rz_deg_delta
            )
            SELECT
                o.id,
                (entry.key)::uuid,
                NULLIF((entry.value ->> 'xMm')::float, NULL),
                NULLIF((entry.value ->> 'yMm')::float, NULL),
                NULLIF((entry.value ->> 'zMm')::float, NULL),
                NULLIF((entry.value ->> 'rxDeg')::float, NULL),
                NULLIF((entry.value ->> 'ryDeg')::float, NULL),
                NULLIF((entry.value ->> 'rzDeg')::float, NULL)
              FROM objects o,
                   jsonb_each(o.properties -> 'bindingOverrides') AS entry
             WHERE o.properties ? 'bindingOverrides'
               AND jsonb_typeof(o.properties -> 'bindingOverrides') = 'object'
               -- only migrate entries that point at an existing binding
               AND EXISTS (
                   SELECT 1 FROM component_bindings cb
                    WHERE cb.id = (entry.key)::uuid
               )
               -- idempotent: skip pairs we already migrated
               AND NOT EXISTS (
                   SELECT 1 FROM object_bindings ob
                    WHERE ob.object_id = o.id
                      AND ob.component_binding_id = (entry.key)::uuid
               )
            """
        )
    )

    # Strip the legacy key from SceneObject.properties so the new table is
    # the single source of truth. (Anything in properties.bindingOverrides
    # that didn't successfully migrate to a row above is dropped here —
    # those rows pointed at non-existent bindings, so the data was
    # already stale.)
    op.execute(
        sa.text(
            """
            UPDATE objects
               SET properties = properties - 'bindingOverrides'
             WHERE properties ? 'bindingOverrides'
            """
        )
    )


def downgrade() -> None:
    # Re-pack object_bindings rows back into
    # SceneObject.properties.bindingOverrides so a round-trip preserves
    # the override state. Drops asset_3d_id_override + properties
    # (they had no JSON home).
    op.execute(
        sa.text(
            """
            WITH per_object AS (
                SELECT
                    ob.object_id,
                    jsonb_object_agg(
                        ob.component_binding_id::text,
                        jsonb_strip_nulls(jsonb_build_object(
                            'xMm', ob.local_x_mm_delta,
                            'yMm', ob.local_y_mm_delta,
                            'zMm', ob.local_z_mm_delta,
                            'rxDeg', ob.local_rx_deg_delta,
                            'ryDeg', ob.local_ry_deg_delta,
                            'rzDeg', ob.local_rz_deg_delta
                        ))
                    ) AS overrides
                  FROM object_bindings ob
                 GROUP BY ob.object_id
            )
            UPDATE objects o
               SET properties = COALESCE(o.properties, '{}'::jsonb)
                              || jsonb_build_object('bindingOverrides', p.overrides)
              FROM per_object p
             WHERE p.object_id = o.id
            """
        )
    )

    op.drop_index(
        "ix_object_bindings_component_binding_id", table_name="object_bindings"
    )
    op.drop_index(
        "ix_object_bindings_object_id", table_name="object_bindings"
    )
    op.drop_table("object_bindings")
