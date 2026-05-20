"""Backfill isolator PhysicsElement.kind_params with nested 3-stage chain

Revision ID: 0080_isolator_nested
Revises: 0079_glan_prism_physical

Phase 19 — fixes silent legacy fallback for pre-existing isolator scene
instances. ``apply_isolator`` (Phase 2, 2026-05-19) gates the full
Glan→Faraday→Glan composition on the presence of nested ``frontGlan`` +
``backGlan`` + ``faraday`` dicts; rows seeded before that gate landed
have flat-only kindParams (forwardLossDb, isolationDb, ...) and fall
through to a single-knob power multiplier, so they silently miss:

  * polarisation-axis Glan transmission/rejection physics
  * Faraday non-reciprocity (the whole isolation mechanism)
  * out_r_front / out_r_back rejected-beam visualisation (Phase 18)

This migration scans every ``physics_elements`` row with
``element_kind = 'isolator'``, and when the row is missing
``frontGlan`` / ``backGlan`` / ``faraday``, splices in the canonical
nested defaults that match the IO-*-HP physical config (matches the
isolator plugin's defaultParams as of Phase 16). Existing flat keys
(forwardLossDb, isolationDb, transmissionAxisDegBeamLocal,
wavelengthRangeNm) are preserved — they coexist with the nested ones,
and apply_isolator's gate only checks the nested dict presence.

Idempotent: rows that already have nested chain (e.g. created after
Phase 2) are skipped. Downgrade strips the three nested keys back out.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0080_isolator_nested"
down_revision = "0079_glan_prism_physical"
branch_labels = None
depends_on = None


# Canonical nested defaults — matches frontend/src/kinds/isolator/index.ts
# defaultParams as of Phase 16. Keep in sync if the plugin changes; the
# nested chain is the source of truth for the simulator, while the
# plugin owns the new-instance defaults.
NESTED_DEFAULTS = {
    "frontGlan": {
        "transmissionAxisDegBeamLocal": 0.0,
        "extinctionRatioDb": 55.0,
        "transmission": 0.92,
        "wedgeAngleDeg": 38.5,
        "airGapMm": 0.05,
        "lengthMm": 7.5,
        "refractiveIndex": 1.48,
        "airGapAstigmatismMm": 0.05,
        "augmentedOffsetXMm": 0.0,
        "coatingNormalBodyLocal": [0, 0.7826081692851781, 0.6225146366376195],
        "wavelengthRangeNm": [400, 1100],
    },
    "faraday": {
        "faradayRotationDeg": 45.0,
        "lengthMm": 8.0,
        "refractiveIndex": 1.95,
        "augmentedOffsetXMm": 0.0,
        "augmentedOffsetYMm": 0.0,
    },
    "backGlan": {
        "transmissionAxisDegBeamLocal": 45.0,
        "extinctionRatioDb": 55.0,
        "transmission": 0.92,
        "wedgeAngleDeg": 38.5,
        "airGapMm": 0.05,
        "lengthMm": 7.5,
        "refractiveIndex": 1.48,
        "airGapAstigmatismMm": 0.05,
        "augmentedOffsetXMm": 0.0,
        "coatingNormalBodyLocal": [0, 0.7826081692851781, 0.6225146366376195],
        "wavelengthRangeNm": [400, 1100],
    },
}


def upgrade() -> None:
    bind = op.get_bind()
    # Splice nested defaults into every isolator row missing them.
    # `||` is JSONB merge (right wins). Wrap in COALESCE so a NULL
    # kind_params (shouldn't happen given the NOT NULL default '{}'::jsonb
    # but defensive) becomes {}.
    bind.execute(
        sa.text(
            """
            UPDATE physics_elements
               SET kind_params = COALESCE(kind_params, '{}'::jsonb) || CAST(:nested AS jsonb)
             WHERE element_kind = 'isolator'
               AND NOT (
                   (kind_params ? 'frontGlan')
               AND (kind_params ? 'backGlan')
               AND (kind_params ? 'faraday')
               )
            """
        ),
        {"nested": json.dumps(NESTED_DEFAULTS)},
    )


def downgrade() -> None:
    bind = op.get_bind()
    # Strip the three nested keys; flat keys stay untouched.
    bind.execute(
        sa.text(
            """
            UPDATE physics_elements
               SET kind_params = kind_params - 'frontGlan' - 'backGlan' - 'faraday'
             WHERE element_kind = 'isolator'
            """
        )
    )
