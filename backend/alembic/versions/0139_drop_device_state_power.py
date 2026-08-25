"""Drop the ``power`` key from ``device_states.state`` — Instrument Power removed

The Instrument Power panel let a user toggle ``device_states.state.power`` per
object, and the solver gated emission / RF propagation on it (a powered-off
laser emitted no beam, a powered-off source dropped its RF chain). That whole
feature was removed on 2026-08-24 — the panel, the frontend ``poweredOff``
plumbing, and the backend ``powered_on`` / ``powered_off`` gating in
``anchor_tracer`` / ``emit_laser_source`` / ``db_scene_loader`` / ``rf_resolve``.

The panel was the ONLY writer of ``state.power`` (nothing in the seed scripts
or session mutations sets it), so any surviving ``power`` keys are now inert
data. This migration strips the key from every ``device_states`` row so the
JSONB blobs don't carry a flag nothing reads. Co-existing keys (lock state,
temperature, enabled, powerMw, …) are untouched — ``state - 'power'`` removes
only that one key.

Revision ID: 0139_drop_device_state_power
Revises: 0138_kind_deletions
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op


revision = "0139_drop_device_state_power"
down_revision = "0138_kind_deletions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # `jsonb_exists(state, 'power')` avoids the `?` has-key operator, which a
    # DBAPI can mistake for a parameter placeholder. `state - 'power'` returns
    # the blob unchanged when the key is absent, so the WHERE is just an
    # optimisation to skip untouched rows.
    op.execute(
        sa.text(
            "UPDATE device_states SET state = state - 'power' "
            "WHERE jsonb_exists(state, 'power')"
        )
    )


def downgrade() -> None:
    """No-op. The removed key drove a feature that no longer exists; there is
    nothing to restore it to, and the panel that wrote it is gone."""
