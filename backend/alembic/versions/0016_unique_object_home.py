"""unique object names and single collection home

Revision ID: 0016_unique_object_home
Revises: 0015_per_obj_state_serial
"""

from __future__ import annotations

from alembic import op


revision = "0016_unique_object_home"
down_revision = "0015_per_obj_state_serial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Existing scenes may contain duplicate names from before object names were
    # treated as instance identifiers. Keep the earliest row unchanged and make
    # every duplicate deterministic by appending its UUID.
    op.execute(
        """
        WITH ranked AS (
            SELECT
                id,
                name,
                row_number() OVER (
                    PARTITION BY lower(name)
                    ORDER BY updated_at ASC NULLS LAST, id ASC
                ) AS rn
            FROM objects
        )
        UPDATE objects o
        SET name = ranked.name || '_' || o.id::text
        FROM ranked
        WHERE ranked.id = o.id
          AND ranked.rn > 1
        """
    )

    # Collapse old multi-collection links. The deepest collection wins, so an
    # object shown in Master -> QM -> Trapping remains in Trapping only.
    op.execute(
        """
        WITH RECURSIVE collection_depth AS (
            SELECT id, 0 AS depth
            FROM collections
            WHERE parent_id IS NULL
            UNION ALL
            SELECT c.id, collection_depth.depth + 1
            FROM collections c
            JOIN collection_depth ON c.parent_id = collection_depth.id
        ),
        ranked AS (
            SELECT
                cm.collection_id,
                cm.object_id,
                row_number() OVER (
                    PARTITION BY cm.object_id
                    ORDER BY
                        COALESCE(collection_depth.depth, 0) DESC,
                        cm.added_at DESC,
                        cm.collection_id ASC
                ) AS rn
            FROM collection_members cm
            LEFT JOIN collection_depth ON collection_depth.id = cm.collection_id
        )
        DELETE FROM collection_members cm
        USING ranked
        WHERE ranked.collection_id = cm.collection_id
          AND ranked.object_id = cm.object_id
          AND ranked.rn > 1
        """
    )

    op.create_unique_constraint("uq_objects_name", "objects", ["name"])
    op.create_unique_constraint(
        "uq_collection_members_object_home",
        "collection_members",
        ["object_id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_collection_members_object_home",
        "collection_members",
        type_="unique",
    )
    op.drop_constraint("uq_objects_name", "objects", type_="unique")
