"""Phase F+: coils + magnetics_problems for the Magnetics overlay.

Two new tables driving DC magnetostatic / low-freq Biot-Savart simulation
via magpylib. Coils live as either standalone rows (positioned by
``params.positionMm``) or bound to a SceneObject (their pose comes from
the linked object's xyz + rxyz). magnetics_problems pull a list of
coil ids to compute the net B-field on a 3D eval grid; the result lands
in the standard SimulationRun.result_summary.field shape so the same
FieldViewer (Phase C.8) volume + streamline overlay renders it.

Revision ID: 0039_coils_magnetics
Revises: 0038_em_problems_meshes
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision = "0039_coils_magnetics"
down_revision = "0038_em_problems_meshes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "coils",
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
        sa.Column("name", sa.Text(), nullable=False),
        # 'circular_loop' (single round turn), 'solenoid' (axial helix),
        # 'polyline' (arbitrary 3D path of N points). Phase F MVP only
        # implements circular_loop + solenoid.
        sa.Column(
            "shape",
            sa.Text(),
            nullable=False,
            server_default="circular_loop",
        ),
        # shape-specific geometry. circular_loop: {radiusMm, turns,
        # axisBodyLocal}. solenoid: {radiusMm, lengthMm, turns,
        # axisBodyLocal}. polyline: {pointsMm: [[x,y,z], ...]}.
        # When scene_object_id is NULL, an extra positionMm field
        # locates the coil in lab frame.
        sa.Column(
            "params",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("current_a", sa.Float(), nullable=False, server_default="1.0"),
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
    op.create_index("ix_coils_scene_object_id", "coils", ["scene_object_id"])

    op.create_table(
        "magnetics_problems",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.Text(), nullable=False),
        # JSONB list of coil UUIDs (string form). Native UUID[] would be
        # more strongly typed but JSONB plays nicer with the existing
        # serialization patterns in this repo.
        sa.Column(
            "coil_ids",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        # {centerMm: [x,y,z], sizeMm: [w,h,d], gridDim: [nx,ny,nz]}.
        sa.Column(
            "eval_region",
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
    op.create_index(
        "ix_magnetics_problems_updated_at",
        "magnetics_problems",
        [sa.text("updated_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_magnetics_problems_updated_at", table_name="magnetics_problems")
    op.drop_table("magnetics_problems")
    op.drop_index("ix_coils_scene_object_id", table_name="coils")
    op.drop_table("coils")
