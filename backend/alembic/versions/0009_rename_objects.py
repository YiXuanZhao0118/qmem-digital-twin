"""rename placements -> objects, object_name -> name

Renames the `placements` table to `objects` and its `object_name`
column to `name`. The DB has always represented "an instance of a
component placed in the scene"; the user-facing language has always
called them "objects". This migration aligns the schema with the
user-facing naming.

Foreign-key constraints in `assembly_relations.object_a_id` /
`object_b_id` follow the table rename automatically (Postgres tracks
references by OID, not by name), so no FK rebuild is needed.

Revision ID: 0009_rename_objects
Revises: 0008_scene_views
Create Date: 2026-05-01 07:55:00.000000
"""

from __future__ import annotations

from alembic import op


revision = "0009_rename_objects"
down_revision = "0008_scene_views"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("placements", "object_name", new_column_name="name")
    op.rename_table("placements", "objects")


def downgrade() -> None:
    op.rename_table("objects", "placements")
    op.alter_column("placements", "name", new_column_name="object_name")
