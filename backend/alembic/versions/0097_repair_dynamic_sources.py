"""Repair objects whose dynamic_sources is a JSON array, not an object.

Revision ID: 0097_repair_dynamic_sources
Revises: 0096_drop_pe_intrinsic_state

Migration 0095 merged AOM per-instance operating state with
``jsonb_build_object(...) || COALESCE(o.dynamic_sources, '{}')``. For a few dev
rows ``dynamic_sources`` was a pre-existing malformed JSON array (e.g.
``[null]``), and Postgres ``object || array`` yields an *array*, which fails the
``SceneObjectOut.dynamic_sources`` dict schema → 500 on /api/objects and
/api/scene. Flatten any array-typed dynamic_sources back into a single object,
keeping the object elements' keys and dropping non-object (null) elements.
``dynamic_sources`` is otherwise left as-is (NULL and object values untouched).
"""

from __future__ import annotations

from alembic import op


revision = "0097_repair_dynamic_sources"
down_revision = "0096_drop_pe_intrinsic_state"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE objects
        SET dynamic_sources = COALESCE(
            (
                SELECT jsonb_object_agg(kv.key, kv.value)
                FROM (
                    SELECT elem
                    FROM jsonb_array_elements(dynamic_sources) AS elem
                    WHERE jsonb_typeof(elem) = 'object'
                ) obj_elems
                CROSS JOIN LATERAL jsonb_each(obj_elems.elem) AS kv
            ),
            '{}'::jsonb
        )
        WHERE jsonb_typeof(dynamic_sources) = 'array'
        """
    )


def downgrade() -> None:
    # Irreversible: the original malformed array shape is not worth restoring.
    pass
