"""rename kinds.face_template -> anchor_template

The column holds the per-kind anchor template (required/optional anchors), not
"faces" — faces are retired. Rename to match (§C-1 / §D-6). Pure rename, data
preserved.

Revision ID: 0107_rename_anchor_template
Revises: 0106_drop_asset_faces
Create Date: 2026-06-07 00:00:00.000000
"""

from __future__ import annotations

from alembic import op


revision = "0107_rename_anchor_template"
down_revision = "0106_drop_asset_faces"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("kinds", "face_template", new_column_name="anchor_template")


def downgrade() -> None:
    op.alter_column("kinds", "anchor_template", new_column_name="face_template")
