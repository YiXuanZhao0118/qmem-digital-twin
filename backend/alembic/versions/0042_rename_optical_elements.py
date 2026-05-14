"""Rename optical_elements -> physics_elements.

The table was named "optical_elements" when it only held optical kinds
(mirror, lens, aom, ...). Phase RF.2 onwards added rf_source / horn_antenna
into the same KIND_REGISTRY, so the table holds *physics* elements (any
domain — optical, rf, em, ...) rather than purely optical ones. Renaming
brings the schema in line with the model.

This migration is pure DDL: rename table, rename indexes, rename any
foreign-key constraints that referenced the old name. No data conversion.

Revision ID: 0042_rename_optical_elements
Revises: 0041_rf_chain_nodes
"""

from __future__ import annotations

from alembic import op


revision = "0042_rename_optical_elements"
down_revision = "0041_rf_chain_nodes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The optical_elements table was created in 0007_optical_domain.py with
    # a single PK on object_id (no other indexes). Postgres auto-renames the
    # PK index along with the table (pkey constraint name follows the table
    # name only when re-created from scratch, but ALTER TABLE RENAME does
    # not rename pkey constraints automatically — so we rename it explicitly
    # to keep things tidy and so future migrations can predict the name).
    op.rename_table("optical_elements", "physics_elements")
    op.execute(
        "ALTER INDEX IF EXISTS optical_elements_pkey RENAME TO physics_elements_pkey"
    )


def downgrade() -> None:
    op.execute(
        "ALTER INDEX IF EXISTS physics_elements_pkey RENAME TO optical_elements_pkey"
    )
    op.rename_table("physics_elements", "optical_elements")
