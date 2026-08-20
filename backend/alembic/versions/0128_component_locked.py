"""Give ``components`` a real ``locked`` column, like Kind / Asset3D / Device.

Component was the one catalog table with no lock. What it had instead was
half of one: ``routers/components.py::is_component_locked`` read a
``properties['locked']`` JSONB flag, and that flag guarded **delete only**,
with a 409 instead of the 422 every other table returns. Nothing wrote it
from the UI and nothing else read it — two rows carry it today
(``optical_table_1`` true, ``RS4000 1200x3600x457 + S-2000A`` false),
presumably set by hand.

So this is not "add a feature to Component", it is "finish the one that was
started and delete the ad-hoc half". After this migration Component uses the
same ``locked`` BOOLEAN NOT NULL DEFAULT false as alembic 0112 gave Kind and
Asset3D (and 0123 gave Device), goes through the same
``app/lock_guard.py``, and returns the same 422.

Backfill is lossless: ``properties->>'locked'`` moves into the column, then
the key is stripped so no second source of truth survives. A row without the
key defaults to unlocked, which is what it effectively was.

Reversible: ``downgrade`` writes the column value back into
``properties.locked`` and drops the column, so the pre-0128 code path finds
what it expects.

Revision ID: 0128_component_locked
Revises: 0127_aom_acoustic_axis_anchor
"""

from __future__ import annotations

import logging

import sqlalchemy as sa

from alembic import op


revision = "0128_component_locked"
down_revision = "0127_aom_acoustic_axis_anchor"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")


def upgrade() -> None:
    op.add_column(
        "components",
        sa.Column(
            "locked",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )

    conn = op.get_bind()

    # Move the JSONB flag into the column. `properties->>'locked'` is the
    # text form, so compare against 'true' rather than casting.
    moved = conn.execute(
        sa.text(
            "UPDATE components SET locked = TRUE "
            "WHERE properties ->> 'locked' = 'true'"
        )
    ).rowcount
    stripped = conn.execute(
        sa.text(
            "UPDATE components SET properties = properties - 'locked' "
            "WHERE properties ? 'locked'"
        )
    ).rowcount
    log.info(
        "0128: %d component(s) locked from properties.locked, "
        "%d stray flag(s) stripped",
        moved,
        stripped,
    )


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text(
            "UPDATE components SET properties = "
            "jsonb_set(properties, '{locked}', to_jsonb(locked)) "
            "WHERE locked IS TRUE"
        )
    )
    op.drop_column("components", "locked")
