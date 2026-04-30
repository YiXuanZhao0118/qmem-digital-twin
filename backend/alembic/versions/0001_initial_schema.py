from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0001_initial_schema"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")

    op.create_table(
        "assets_3d",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("asset_type", sa.Text(), nullable=False),
        sa.Column("file_path", sa.Text(), nullable=False),
        sa.Column("source", sa.Text()),
        sa.Column("source_url", sa.Text()),
        sa.Column("unit", sa.Text(), nullable=False, server_default="mm"),
        sa.Column("scale_factor", sa.Float(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "components",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("component_type", sa.Text(), nullable=False),
        sa.Column("brand", sa.Text()),
        sa.Column("model", sa.Text()),
        sa.Column("serial_number", sa.Text()),
        sa.Column("asset_3d_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("assets_3d.id")),
        sa.Column("properties", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("notes", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "placements",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "component_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("components.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("parent_component_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("components.id")),
        sa.Column("x_mm", sa.Float(), nullable=False, server_default="0"),
        sa.Column("y_mm", sa.Float(), nullable=False, server_default="0"),
        sa.Column("z_mm", sa.Float(), nullable=False, server_default="0"),
        sa.Column("rx_deg", sa.Float(), nullable=False, server_default="0"),
        sa.Column("ry_deg", sa.Float(), nullable=False, server_default="0"),
        sa.Column("rz_deg", sa.Float(), nullable=False, server_default="0"),
        sa.Column("visible", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("locked", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "connections",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("connection_type", sa.Text(), nullable=False),
        sa.Column("from_component_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("components.id"), nullable=False),
        sa.Column("from_port", sa.Text()),
        sa.Column("to_component_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("components.id"), nullable=False),
        sa.Column("to_port", sa.Text()),
        sa.Column("label", sa.Text()),
        sa.Column("properties", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "beam_paths",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("wavelength_nm", sa.Float()),
        sa.Column("color", sa.Text(), nullable=False, server_default="#ff0000"),
        sa.Column("source_component_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("components.id")),
        sa.Column("target_component_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("components.id")),
        sa.Column("points", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("properties", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("visible", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "device_states",
        sa.Column(
            "component_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("components.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("state", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "revisions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("snapshot", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("revisions")
    op.drop_table("device_states")
    op.drop_table("beam_paths")
    op.drop_table("connections")
    op.drop_table("placements")
    op.drop_table("components")
    op.drop_table("assets_3d")

