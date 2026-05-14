"""rf_links — RF signal graph edges, parallel to optical_links.

Phase 1 of the RF graph refactor. Mirrors ``optical_links`` so RF
networks (including switches / splitters / combiners / couplers /
mixers) can be modelled as a proper directed graph instead of the
linear ``rf_chain_nodes`` chain.

Schema mirrors ``optical_links`` exactly except for:
  - ``electrical_length_mm`` replaces ``free_space_mm`` (signal path
    length through the wired connection; ``0`` for direct connector
    mating).
  - ``properties`` JSONB carries RF-specific edge data (impedanceOhm,
    lossDb, delayNs, cableObjectId, etc.) until the schema is
    formalised in a later phase.

The legacy ``rf_chain_nodes`` table is NOT touched here. Phase 5
demotes it to a derived chain-readout cache once all readers have
migrated; Phase 6 backfills any existing chain rows into ``rf_links``.

Revision ID: 0044_rf_links
Revises: 0043_app_settings
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision = "0044_rf_links"
down_revision = "0043_app_settings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "rf_links",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "from_object_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("objects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("from_port", sa.Text(), nullable=False),
        sa.Column(
            "to_object_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("objects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("to_port", sa.Text(), nullable=False),
        sa.Column(
            "electrical_length_mm",
            sa.Float(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "properties",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "from_object_id",
            "from_port",
            "to_object_id",
            "to_port",
            name="uq_rf_link_object_endpoints",
        ),
    )
    op.create_index(
        "ix_rf_links_from",
        "rf_links",
        ["from_object_id", "from_port"],
    )
    op.create_index(
        "ix_rf_links_to",
        "rf_links",
        ["to_object_id", "to_port"],
    )


def downgrade() -> None:
    op.drop_index("ix_rf_links_to", table_name="rf_links")
    op.drop_index("ix_rf_links_from", table_name="rf_links")
    op.drop_table("rf_links")
