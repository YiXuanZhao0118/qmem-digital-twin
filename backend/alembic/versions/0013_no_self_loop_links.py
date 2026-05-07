"""drop existing optical_link self-loops + prevent future ones

The chain solver treats any self-loop (from_component_id == to_component_id)
as a graph cycle and refuses to run with "Optical graph contains a cycle."
The API now rejects self-loops at insert/update time, but legacy DBs may
still have them — this migration scrubs them, then adds a CHECK constraint
so the DB itself enforces the invariant.

Revision ID: 0013_no_self_loop_links
Revises: 0012_timing_programs
Create Date: 2026-05-03 14:38:00.000000
"""

from __future__ import annotations

from alembic import op


revision = "0013_no_self_loop_links"
down_revision = "0012_timing_programs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Wipe any rows where source == target. They've never been usable.
    op.execute(
        "DELETE FROM optical_links WHERE from_component_id = to_component_id"
    )
    # 2. Belt-and-suspenders: enforce at the DB level so even direct SQL
    #    inserts can't reintroduce the bug. Mirrors the API-level check in
    #    routers/optical_links.py.
    op.create_check_constraint(
        "optical_links_no_self_loop",
        "optical_links",
        "from_component_id <> to_component_id",
    )


def downgrade() -> None:
    op.drop_constraint(
        "optical_links_no_self_loop",
        "optical_links",
        type_="check",
    )
