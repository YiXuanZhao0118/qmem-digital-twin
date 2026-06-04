"""Calibrate AOM assets to the datasheet RF-dependent efficiency model.

The efficiency is now
    eta = peak * sin^2((pi/2) sqrt(P / P_peak(lambda))) * G(f)
(aom_physics.first_order_efficiency), so each AOM asset needs the datasheet
calibration params. Seed them on every aom Asset3D (AA MT80-A1.5-IR):

  rfPowerForPeakW   = 2.2   (max RF power, drives to peak η)
  peakRefWavelengthNm = 1100 (λ_ref for P_peak ∝ λ²; >85% across 700-1100 nm)
  freqShiftBandwidthMhz = 15 (±15 MHz variable-shift band: >80%@F0, >60% edges)
  rfPowerMaxW       = 2.2   (hardware cap)
  centerFreqMhz     = 80    (design centre; ensure present)
  baseEfficiency    = 0.85  (now the PEAK efficiency; ensure present)
  modulationBandwidthMhz = 10 (analog AMPLITUDE-mod −3 dB BW; ≠ freq-shift BW)

Idempotent. baseEfficiency keeps its prior value if already set.
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0102_aom_rf_model"
down_revision = "0101_aom_velocity_key"
branch_labels = None
depends_on = None

# Forced calibration values (overwrite) + defaults (only if absent).
_FORCE = {
    "rfPowerForPeakW": 2.2,
    "peakRefWavelengthNm": 1100.0,
    "freqShiftBandwidthMhz": 15.0,
    "rfPowerMaxW": 2.2,
    "modulationBandwidthMhz": 10.0,
}
_DEFAULTS = {
    "centerFreqMhz": 80.0,
    "baseEfficiency": 0.85,
}


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text("SELECT id, default_params FROM assets_3d WHERE kind_id = 'aom'")
    ).mappings().fetchall()
    for row in rows:
        params = dict(row["default_params"] or {})
        params.update(_FORCE)
        for k, v in _DEFAULTS.items():
            params.setdefault(k, v)
        bind.execute(
            sa.text(
                "UPDATE assets_3d SET default_params = CAST(:p AS JSONB) WHERE id = :id"
            ),
            {"p": json.dumps(params), "id": row["id"]},
        )


def downgrade() -> None:
    # Drop the model-specific keys we added (best effort).
    bind = op.get_bind()
    rows = bind.execute(
        sa.text("SELECT id, default_params FROM assets_3d WHERE kind_id = 'aom'")
    ).mappings().fetchall()
    for row in rows:
        params = dict(row["default_params"] or {})
        for k in ("rfPowerForPeakW", "peakRefWavelengthNm", "freqShiftBandwidthMhz"):
            params.pop(k, None)
        bind.execute(
            sa.text(
                "UPDATE assets_3d SET default_params = CAST(:p AS JSONB) WHERE id = :id"
            ),
            {"p": json.dumps(params), "id": row["id"]},
        )
