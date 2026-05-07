"""per-object optical participation

Optical chain participation moves from per-COMPONENT to per-OBJECT:
- A Component is just the 3D model + asset metadata (template).
- A SceneObject is an independent instance with its own optical params,
  ports, kind_params, AND its own role in the optical chain (independent
  from any other SceneObject of the same Component).

Schema changes:
1. `optical_elements`:
   - Add `id` (UUID PK), `object_id` (FK objects.id UNIQUE, NOT NULL).
   - For each existing row, FAN OUT to every SceneObject sharing the
     component_id, copying kind/wavelength_range/ports/kind_params.
   - Drop component_id from the row (no longer needed; lookup goes via
     object → object.component_id if anyone needs it).
2. `optical_links`:
   - Add `from_object_id`, `to_object_id` (FK objects.id NOT NULL).
   - For each existing link, pick the FIRST SceneObject (lowest
     updated_at, then lowest id as tiebreaker) of the link's component.
   - Drop from_component_id, to_component_id and their unique
     constraint; add new unique constraint on the object-keyed tuple.
   - Skip links whose endpoints have no scene objects (orphan).
3. `objects.properties.placedRelativeTo`:
   - Rewrite `fromComponentId` → `fromObjectId`, `toComponentId` →
     `toObjectId`, `bridgedViaComponentId` → `bridgedViaObjectId`,
     resolving each component_id to the first scene object using a
     JOIN. Best-effort: if no resolution, leave field unchanged so
     frontend's legacy reader still has SOMETHING to work with.

Revision ID: 0014_per_obj_optical
Revises: 0013_no_self_loop_links
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0014_per_obj_optical"
down_revision = "0013_no_self_loop_links"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ─── optical_elements ────────────────────────────────────────────────────
    # Add the new columns nullable, fan out, then enforce constraints.
    op.add_column(
        "optical_elements",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
    )
    op.add_column(
        "optical_elements",
        sa.Column("object_id", postgresql.UUID(as_uuid=True), nullable=True),
    )

    # Fan out: for each existing row × matching SceneObject, insert a new row.
    # Keep the OLD rows as-is for now (still keyed by component_id PK), then
    # delete them once we've cloned. We need to be careful to not violate the
    # PK constraint (component_id) during the fan-out — strategy: we'll drop
    # the old PK first, fan out into the same table, then drop old rows.
    op.drop_constraint("optical_elements_pkey", "optical_elements", type_="primary")

    # Fan out via INSERT FROM SELECT — every (OE, SceneObject) pair where
    # OE.component_id == SO.component_id gets a fresh OE row keyed by
    # gen_random_uuid() id and the SO's id as object_id.
    op.execute(
        """
        INSERT INTO optical_elements (
            id, component_id, object_id,
            element_kind, wavelength_range_nm,
            input_ports, output_ports, kind_params,
            created_at, updated_at
        )
        SELECT
            gen_random_uuid(),
            oe.component_id,
            so.id,
            oe.element_kind,
            oe.wavelength_range_nm,
            oe.input_ports,
            oe.output_ports,
            oe.kind_params,
            oe.created_at,
            now()
        FROM optical_elements oe
        JOIN objects so ON so.component_id = oe.component_id
        WHERE oe.object_id IS NULL
        """
    )

    # Delete the old (object_id IS NULL) rows — they were the templates.
    op.execute("DELETE FROM optical_elements WHERE object_id IS NULL")

    # Now make object_id NOT NULL + UNIQUE + the new PK.
    op.alter_column("optical_elements", "object_id", nullable=False)
    op.create_unique_constraint(
        "uq_optical_elements_object_id", "optical_elements", ["object_id"]
    )
    op.create_foreign_key(
        "fk_optical_elements_object_id",
        "optical_elements",
        "objects",
        ["object_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_primary_key("pk_optical_elements", "optical_elements", ["id"])

    # Drop component_id column — object → component is reachable via objects table.
    op.drop_column("optical_elements", "component_id")

    # ─── optical_links ───────────────────────────────────────────────────────
    op.add_column(
        "optical_links",
        sa.Column("from_object_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "optical_links",
        sa.Column("to_object_id", postgresql.UUID(as_uuid=True), nullable=True),
    )

    # For each link, pick the first SceneObject of each endpoint component.
    # "First" = lowest updated_at (oldest), tiebreak by lowest id.
    op.execute(
        """
        WITH first_obj_per_comp AS (
            SELECT DISTINCT ON (component_id)
                component_id, id
            FROM objects
            ORDER BY component_id, updated_at ASC, id ASC
        )
        UPDATE optical_links ol
        SET from_object_id = f.id, to_object_id = t.id
        FROM first_obj_per_comp f, first_obj_per_comp t
        WHERE f.component_id = ol.from_component_id
          AND t.component_id = ol.to_component_id
        """
    )

    # Drop links that couldn't be resolved (orphan: a component with no
    # scene objects). They're useless without endpoints in the scene.
    op.execute(
        "DELETE FROM optical_links WHERE from_object_id IS NULL OR to_object_id IS NULL"
    )

    op.alter_column("optical_links", "from_object_id", nullable=False)
    op.alter_column("optical_links", "to_object_id", nullable=False)

    # Drop the old constraint + columns + add new constraint & FKs.
    op.drop_constraint("uq_optical_link_endpoints", "optical_links", type_="unique")
    op.drop_constraint(
        "optical_links_no_self_loop", "optical_links", type_="check"
    )
    op.drop_column("optical_links", "from_component_id")
    op.drop_column("optical_links", "to_component_id")

    op.create_foreign_key(
        "fk_optical_links_from_object_id",
        "optical_links",
        "objects",
        ["from_object_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_optical_links_to_object_id",
        "optical_links",
        "objects",
        ["to_object_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_unique_constraint(
        "uq_optical_link_object_endpoints",
        "optical_links",
        ["from_object_id", "from_port", "to_object_id", "to_port"],
    )
    op.create_check_constraint(
        "optical_links_no_self_loop",
        "optical_links",
        "from_object_id <> to_object_id",
    )

    # ─── objects.properties.placedRelativeTo JSON migration ──────────────────
    # Rewrite component-id references to object-id references using the same
    # "first object of that component" rule. Done in a single SQL pass per
    # field via PG's jsonb operators. We only touch records whose
    # placedRelativeTo.kind == "beam_along".
    op.execute(
        """
        WITH first_obj_per_comp AS (
            SELECT DISTINCT ON (component_id)
                component_id, id
            FROM objects
            ORDER BY component_id, updated_at ASC, id ASC
        ),
        candidates AS (
            SELECT id,
                   properties->'placedRelativeTo' AS pr,
                   properties->'placedRelativeTo'->>'fromComponentId' AS fc,
                   properties->'placedRelativeTo'->>'toComponentId' AS tc,
                   properties->'placedRelativeTo'->>'bridgedViaComponentId' AS bc
            FROM objects
            WHERE properties->'placedRelativeTo'->>'kind' = 'beam_along'
        )
        UPDATE objects o
        SET properties = jsonb_set(
            jsonb_set(
                jsonb_set(
                    o.properties #- '{placedRelativeTo,fromComponentId}'
                                 #- '{placedRelativeTo,toComponentId}'
                                 #- '{placedRelativeTo,bridgedViaComponentId}',
                    '{placedRelativeTo,fromObjectId}',
                    to_jsonb(COALESCE(fobj.id::text, c.fc))
                ),
                '{placedRelativeTo,toObjectId}',
                CASE
                    WHEN tobj.id IS NOT NULL THEN to_jsonb(tobj.id::text)
                    WHEN c.tc IS NOT NULL THEN to_jsonb(c.tc)
                    ELSE 'null'::jsonb
                END
            ),
            '{placedRelativeTo,bridgedViaObjectId}',
            CASE
                WHEN bobj.id IS NOT NULL THEN to_jsonb(bobj.id::text)
                WHEN c.bc IS NOT NULL THEN to_jsonb(c.bc)
                ELSE 'null'::jsonb
            END
        )
        FROM candidates c
        LEFT JOIN first_obj_per_comp fobj ON fobj.component_id::text = c.fc
        LEFT JOIN first_obj_per_comp tobj ON tobj.component_id::text = c.tc
        LEFT JOIN first_obj_per_comp bobj ON bobj.component_id::text = c.bc
        WHERE o.id = c.id
        """
    )


def downgrade() -> None:
    # Reverse migration is best-effort. We can rebuild component-keyed rows
    # (one per OE row's object → object.component_id) but we lose per-object
    # parameter divergence. Not safe for production downgrade.
    raise NotImplementedError(
        "Downgrade not supported — per-object optical schema cannot be cleanly "
        "collapsed back to per-component. Restore from a pre-0014 backup if needed."
    )
