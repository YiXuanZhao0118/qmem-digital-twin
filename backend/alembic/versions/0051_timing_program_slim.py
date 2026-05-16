"""drop kind / channel_index / invert from timing_programs

Revision ID: 0051_timing_program_slim
Revises: 0050_anchor_connector_type

Per spec change 2026-05-16: TimingProgram has been simplified to just
``{id, name, intervals[]}``. The previous kind discriminator (TTL /
Trigger) is gone because PPG output is now a single "RFout" signal —
the consumer side (switch.ttl_in, AOM.trigger_in, …) carries any
semantic difference. The PB ``channel_index`` is no longer stored at
all; channel ordering becomes a positional readout derived from the
PPG list at solve time, so there is no fixed 0..23 / 0..31 cap. The
``invert`` polarity flag is dropped since the new UX has no surface
for it and the data was unused once the kind axis collapsed.

Migration strategy
------------------
* Drop the UNIQUE partial index on ``channel_index`` first (otherwise
  Postgres rejects the column drop).
* Drop columns ``kind``, ``channel_index``, ``invert`` in that order.
* Downgrade re-adds them with the previous defaults (kind="TTL",
  channel_index NULL, invert=false). Historic kind / channel info is
  not restored — there is no archive to read from — so downgrade
  produces blank columns that the older code seeded itself.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op


revision = "0051_timing_program_slim"
down_revision = "0050_anchor_connector_type"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_timing_program_channel")
    op.drop_column("timing_programs", "channel_index")
    op.drop_column("timing_programs", "kind")
    op.drop_column("timing_programs", "invert")


def downgrade() -> None:
    op.add_column(
        "timing_programs",
        sa.Column(
            "kind",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'TTL'"),
        ),
    )
    op.add_column(
        "timing_programs",
        sa.Column("channel_index", sa.Integer(), nullable=True),
    )
    op.add_column(
        "timing_programs",
        sa.Column(
            "invert",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.execute(
        """
        CREATE UNIQUE INDEX uq_timing_program_channel
        ON timing_programs (channel_index)
        WHERE channel_index IS NOT NULL
        """
    )
