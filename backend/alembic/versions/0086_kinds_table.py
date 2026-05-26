"""Phase 2 — Kind metadata catalog table

Revision ID: 0086_kinds_table
Revises: 0085_io_3_hp_flatten_to_5_assets

Moves per-kind metadata (display name, default params template,
face/anchor template, needs_aperture, wavelength range) out of the
code-only registry and into a DB row that the UI can CRUD. PhysicsOp
implementations stay in code — each Kind row references one via
``op_set_name``. New rows can only reuse an existing op set; to add
genuinely new physics behavior you still need to write a PhysicsOp.

Backfill walks the existing ``backend/data/kinds.json`` manifest (which
is generated from the frontend plugin registry — the current source of
truth) and inserts one row per physics_plugin. For each backfilled
row, ``op_set_name`` is set equal to ``name`` (the built-in kinds are
their own op sets).

See docs/asset-physics-model.md §6.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0086_kinds_table"
down_revision = "0085_io_3_hp_flatten"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "kinds",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("domain", sa.Text(), nullable=False),
        sa.Column("op_set_name", sa.Text(), nullable=False),
        sa.Column(
            "default_params",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "face_template",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "needs_aperture",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column("wavelength_range_nm", sa.ARRAY(sa.Float()), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
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
        ),
        sa.UniqueConstraint("name", name="kinds_name_key"),
        sa.CheckConstraint(
            "domain IN ('optical', 'rf', 'mechanical')",
            name="kind_domain_check",
        ),
    )
    op.create_index("ix_kinds_name", "kinds", ["name"])

    # Backfill from kinds.json. Import inside upgrade() so alembic offline
    # mode doesn't try to load the manifest during SQL generation.
    from app.kinds_manifest import load_manifest

    manifest = load_manifest()
    conn = op.get_bind()
    for plugin in manifest.get("physics_plugins", []):
        physics = plugin.get("physics", {}) or {}
        anchors = physics.get("anchors", {}) or {}
        needs_aperture_list = anchors.get("needs_aperture") or []
        wavelength_range = physics.get("wavelength_range_nm")
        conn.execute(
            sa.text(
                "INSERT INTO kinds ("
                "name, display_name, domain, op_set_name, "
                "default_params, face_template, needs_aperture, "
                "wavelength_range_nm, description"
                ") VALUES ("
                ":name, :display_name, :domain, :op_set_name, "
                "CAST(:default_params AS JSONB), CAST(:face_template AS JSONB), "
                ":needs_aperture, :wavelength_range_nm, :description"
                ")"
            ),
            {
                "name": plugin["id"],
                "display_name": plugin.get("display_name") or plugin["id"],
                # ``primary_domain`` is the tracer-side label
                # (optical / rf / mechanical). ``asset_category`` is a
                # UI-grouping label ("electronics" for RF parts) so it
                # would fail our CHECK constraint.
                "domain": physics.get("primary_domain") or "optical",
                "op_set_name": plugin["id"],
                "default_params": json.dumps(physics.get("default_params") or {}),
                "face_template": json.dumps(anchors),
                "needs_aperture": bool(needs_aperture_list),
                "wavelength_range_nm": wavelength_range,
                "description": physics.get("align_summary"),
            },
        )


def downgrade() -> None:
    op.drop_index("ix_kinds_name", table_name="kinds")
    op.drop_table("kinds")
