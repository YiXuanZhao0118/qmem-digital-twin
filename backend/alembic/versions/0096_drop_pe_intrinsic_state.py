"""Drop the dead physics_elements.intrinsic_params / state_params columns.

Revision ID: 0096_drop_pe_intrinsic_state
Revises: 0095_legacy_component_physics

Retirement Phase 6. The 0049 three-layer split (kind_params →
intrinsic_params + state_params) was never completed: no solver, router, or
CRUD ever read the two split columns — kind_params stayed the source of truth.
With the legacy per-object physics path retired, these columns are pure dead
weight. ``kind_params`` is kept (it still carries PPG ``timingProgramId``,
ports, and anchor bindings — non-physics data).
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op


revision = "0096_drop_pe_intrinsic_state"
down_revision = "0095_legacy_component_physics"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("physics_elements", "intrinsic_params")
    op.drop_column("physics_elements", "state_params")


def downgrade() -> None:
    op.add_column(
        "physics_elements",
        sa.Column(
            "intrinsic_params", JSONB(), nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.add_column(
        "physics_elements",
        sa.Column(
            "state_params", JSONB(), nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
