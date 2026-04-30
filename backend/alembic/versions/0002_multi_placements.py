from __future__ import annotations

from alembic import op


revision = "0002_multi_placements"
down_revision = "0001_initial_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'placements_component_id_key'
            ) THEN
                ALTER TABLE placements DROP CONSTRAINT placements_component_id_key;
            END IF;
        END
        $$;
        """
    )


def downgrade() -> None:
    op.create_unique_constraint("placements_component_id_key", "placements", ["component_id"])
