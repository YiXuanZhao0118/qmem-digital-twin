"""Drop pulse_blaster_channels; absorb channel_index + invert into TimingProgram.

After alembic 0045 the separate ``pulse_blaster_channels`` table only
held a thin (channel_index, invert, enabled, target_timing_program_id)
binding tuple. This migration moves those fields onto ``TimingProgram``
directly:

- ``channel_index INTEGER NULL`` — physical PB output line (0..23 for
  PB-24, 0..31 for PB-PRO). NULL = the program is a logical schedule
  that isn't bound to a hardware wire yet.
- ``invert BOOLEAN NOT NULL DEFAULT false`` — active-low flip.
- ``UNIQUE (channel_index) WHERE channel_index IS NOT NULL`` — partial
  index. One wire can carry exactly one schedule at a time; multiple
  programs unbound (NULL) are allowed.

The old ``enabled`` flag is dropped: an unbound program (``channel_index
IS NULL``) is the new "disabled" state. ``target_timing_program_id`` on
the channels table is also redundant once the channel-side is gone.

Backfill: copy existing channel rows' (channel_index, invert) onto the
referenced TimingProgram. If two channels referenced the same program,
the lowest channel_index wins (deterministic). In dev DBs this table
is empty so backfill is a no-op in practice.

Revision ID: 0046_drop_pb_channels_inline
Revises: 0045_restructure_timing_program
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op


revision = "0046_drop_pb_channels_inline"
down_revision = "0045_restructure_timing_program"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Add the new columns on timing_programs.
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

    # 2. Backfill from pulse_blaster_channels. Lowest channel_index wins
    #    if two channels bound the same program (defensive — in dev DBs
    #    this is a no-op).
    op.execute(
        sa.text(
            """
            UPDATE timing_programs tp
            SET channel_index = src.channel_index,
                invert        = src.invert
            FROM (
                SELECT DISTINCT ON (target_timing_program_id)
                       target_timing_program_id,
                       channel_index,
                       invert
                FROM pulse_blaster_channels
                WHERE target_timing_program_id IS NOT NULL
                  AND enabled = true
                ORDER BY target_timing_program_id, channel_index ASC
            ) src
            WHERE tp.id = src.target_timing_program_id
            """
        )
    )

    # 3. Partial unique index: one program per physical wire.
    op.execute(
        sa.text(
            """
            CREATE UNIQUE INDEX uq_timing_program_channel
            ON timing_programs (channel_index)
            WHERE channel_index IS NOT NULL
            """
        )
    )

    # 4. Drop the now-redundant pulse_blaster_channels table.
    op.drop_table("pulse_blaster_channels")


def downgrade() -> None:
    raise NotImplementedError(
        "0046 is one-way: pulse_blaster_channels was dropped without a "
        "lossless inverse. Restore from a pre-0046 snapshot if needed."
    )
