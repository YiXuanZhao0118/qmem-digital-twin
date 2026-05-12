"""Phase C.1 — em_problems + meshes tables for the EM module.

Two new tables driving the Phase C palace FEM workflow:

- ``meshes`` stores Gmsh-produced meshes (`.msh`) uploaded by the user
  or auto-generated from a SceneObject's STEP/STL. Phase C MVP accepts
  user uploads only; Phase C+ wraps Gmsh CLI server-side. ``file_path``
  is on disk (not in DB); 100 MB cap enforced at the upload endpoint.

- ``em_problems`` is one EM analysis "problem definition" — the scene
  object being analyzed, its port assignments (stored as JSONB, each
  port references an anchorBinding id + impedance + mode), boundary
  conditions, frequency sweep range, and which mesh row to use. The
  ``simulation_runs`` row from the multiphysics flow stores the actual
  computed results.

Revision ID: 0038_em_problems_meshes
Revises: 0037_circuits
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision = "0038_em_problems_meshes"
down_revision = "0037_circuits"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "meshes",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "source_asset_3d_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("assets_3d.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        # 'gmsh' (.msh) is the only format Phase C MVP accepts. 'vtk' is
        # reserved for Phase C+ when we wrap a converter.
        sa.Column("mesh_format", sa.Text(), nullable=False, server_default="gmsh"),
        sa.Column("file_path", sa.Text(), nullable=False),
        sa.Column("element_count", sa.Integer(), nullable=True),
        sa.Column("max_size_mm", sa.Float(), nullable=True),
        sa.Column("file_size_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_meshes_source_asset_3d_id", "meshes", ["source_asset_3d_id"])
    op.create_index("ix_meshes_created_at", "meshes", [sa.text("created_at DESC")])

    op.create_table(
        "em_problems",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "scene_object_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("objects.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "mesh_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("meshes.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        # Port spec list. Each port: {id, name, anchorBindingId, impedanceOhm,
        # mode}. Stored as JSONB; validated at the Pydantic layer.
        sa.Column(
            "ports",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        # Boundary conditions: {pec: [...], absorbing: [...], symmetry: ...}
        sa.Column(
            "boundary_conditions",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        # Frequency sweep: {startGhz, stopGhz, points, scale: 'linear'|'log'}
        sa.Column(
            "freq_range_ghz",
            postgresql.JSONB(astext_type=sa.Text()),
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
        ),
    )
    op.create_index("ix_em_problems_scene_object_id", "em_problems", ["scene_object_id"])
    op.create_index("ix_em_problems_updated_at", "em_problems", [sa.text("updated_at DESC")])


def downgrade() -> None:
    op.drop_index("ix_em_problems_updated_at", table_name="em_problems")
    op.drop_index("ix_em_problems_scene_object_id", table_name="em_problems")
    op.drop_table("em_problems")
    op.drop_index("ix_meshes_created_at", table_name="meshes")
    op.drop_index("ix_meshes_source_asset_3d_id", table_name="meshes")
    op.drop_table("meshes")
