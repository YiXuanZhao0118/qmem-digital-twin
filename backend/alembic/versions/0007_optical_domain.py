"""add physics_capabilities + optical domain tables

Revision ID: 0007_optical_domain
Revises: 0006_asset_anchors
Create Date: 2026-04-30 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0007_optical_domain"
down_revision = "0006_asset_anchors"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "components",
        sa.Column(
            "physics_capabilities",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )

    op.create_table(
        "optical_elements",
        sa.Column(
            "component_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("components.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("element_kind", sa.Text(), nullable=False),
        sa.Column(
            "wavelength_range_nm",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[400, 1100]'::jsonb"),
        ),
        sa.Column(
            "input_ports",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "output_ports",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "kind_params",
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
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
    )

    op.create_table(
        "optical_links",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "from_component_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("components.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("from_port", sa.Text(), nullable=False),
        sa.Column(
            "to_component_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("components.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("to_port", sa.Text(), nullable=False),
        sa.Column("free_space_mm", sa.Float(), nullable=False, server_default="0"),
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
            "from_component_id",
            "from_port",
            "to_component_id",
            "to_port",
            name="uq_optical_link_endpoints",
        ),
    )
    op.create_index(
        "ix_optical_links_from",
        "optical_links",
        ["from_component_id", "from_port"],
    )
    op.create_index(
        "ix_optical_links_to",
        "optical_links",
        ["to_component_id", "to_port"],
    )

    op.create_table(
        "beam_segments",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "simulation_run_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
        sa.Column(
            "optical_link_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("optical_links.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("sequence_t_ms", sa.Float(), nullable=True),
        sa.Column("beam_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("spectrum", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("spatial_x", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("spatial_y", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("transverse_mode", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("polarization_jones", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("power_mw", sa.Float(), nullable=False, server_default="0"),
        sa.Column("propagation_axis_local", postgresql.JSONB(), nullable=False, server_default=sa.text("'[0, 0, 1]'::jsonb")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_beam_segments_run_link",
        "beam_segments",
        ["simulation_run_id", "optical_link_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_beam_segments_run_link", table_name="beam_segments")
    op.drop_table("beam_segments")
    op.drop_index("ix_optical_links_to", table_name="optical_links")
    op.drop_index("ix_optical_links_from", table_name="optical_links")
    op.drop_table("optical_links")
    op.drop_table("optical_elements")
    op.drop_column("components", "physics_capabilities")
