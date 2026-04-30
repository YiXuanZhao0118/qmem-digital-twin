from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0003_object_names"
down_revision = "0002_multi_placements"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "placements",
        sa.Column("object_name", sa.Text(), nullable=False, server_default="object"),
    )
    op.execute(
        """
        WITH ranked AS (
            SELECT
                placements.id,
                components.name || '_object_' ||
                    row_number() OVER (
                    PARTITION BY placements.component_id
                        ORDER BY placements.updated_at NULLS LAST, placements.id
                    ) AS next_name
            FROM placements
            JOIN components ON components.id = placements.component_id
        )
        UPDATE placements
        SET object_name = ranked.next_name
        FROM ranked
        WHERE placements.id = ranked.id;
        """
    )


def downgrade() -> None:
    op.drop_column("placements", "object_name")
