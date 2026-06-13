"""Define the connector kinds/assets cleanly: drop tipMm + pure metadata,
rename the placeholder slugs to the canonical scheme.

Decisions (2026-06-13, with the user):
  - tipMm is dead (geometry = connect_in / connect_out anchors; nothing reads
    the param) → removed from both kinds and every connector asset.
  - default_params trimmed to physics-essential:
      fiber_connector: polish, polishAngleDeg, fiberType, mfdUm, na,
                       slowAxisKeyed, returnLossDb (+ kind keeps the
                       column-owned wavelengthRangeNm).
      rf_cable_connector: family, gender, impedanceOhm, maxFreqGhz.
    Dropped fibre metadata: housing, coreUm, claddingUm, apertureDiameterMm,
    glassIndexAtDesignLambda. Dropped RF: couplingType.
  - placeholder slugs renamed to the user's scheme:
      fiber_connector_pc_mm   → mm_pc_780
      rf_connector_sma_female → sma_female
      rf_connector_bnc_female → bnc_female

The asset trim is a generic JSONB key-subtraction by kind_id, so it cleans
both the placeholder rows (fresh install) and the user's GLB uploads (live
DB). The kind UPDATEs match the regenerated kinds.json so fresh-install
(0086 seed) and existing DBs converge.

Revision ID: 0117_trim_connector_params
Revises: 0116_connector_components
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0117_trim_connector_params"
down_revision = "0116_connector_components"
branch_labels = None
depends_on = None


_FIBER_KIND = {
    "polish": "PC",
    "polishAngleDeg": 0.0,
    "fiberType": "single_mode",
    "mfdUm": 5.3,
    "na": 0.13,
    "slowAxisKeyed": False,
    "returnLossDb": 40.0,
    "wavelengthRangeNm": [770.0, 790.0],
}
_RF_KIND = {
    "family": "sma",
    "gender": "male",
    "impedanceOhm": 50.0,
    "maxFreqGhz": 18.0,
}

# fibre default_params before the trim (for downgrade)
_FIBER_KIND_OLD = {
    **_FIBER_KIND, "housing": "FC", "coreUm": 4.4, "claddingUm": 125.0,
    "tipMm": 36.28, "apertureDiameterMm": 0.125, "glassIndexAtDesignLambda": 1.4506,
}
_RF_KIND_OLD = {**_RF_KIND, "tipMm": 15.5, "couplingType": "thread"}

_RENAMES = [
    ("fiber_connector_pc_mm", "mm_pc_780"),
    ("rf_connector_sma_female", "sma_female"),
    ("rf_connector_bnc_female", "bnc_female"),
]


def _set_kind(conn, name, params):
    conn.execute(
        sa.text("UPDATE kinds SET default_params = CAST(:p AS jsonb) WHERE name = :n"),
        {"p": json.dumps(params), "n": name},
    )


def upgrade() -> None:
    conn = op.get_bind()
    _set_kind(conn, "fiber_connector", _FIBER_KIND)
    _set_kind(conn, "rf_cable_connector", _RF_KIND)

    conn.execute(sa.text(
        "UPDATE assets_3d SET default_params = default_params "
        "- 'tipMm' - 'housing' - 'coreUm' - 'claddingUm' "
        "- 'apertureDiameterMm' - 'glassIndexAtDesignLambda' "
        "WHERE kind_id = 'fiber_connector'"
    ))
    conn.execute(sa.text(
        "UPDATE assets_3d SET default_params = default_params - 'tipMm' - 'couplingType' "
        "WHERE kind_id = 'rf_cable_connector'"
    ))

    for old, new in _RENAMES:
        conn.execute(sa.text("UPDATE assets_3d SET catalog_id = :n WHERE catalog_id = :o"),
                     {"n": new, "o": old})
        conn.execute(sa.text("UPDATE components SET catalog_id = :n WHERE catalog_id = :o"),
                     {"n": new, "o": old})


def downgrade() -> None:
    conn = op.get_bind()
    for old, new in _RENAMES:
        conn.execute(sa.text("UPDATE assets_3d SET catalog_id = :o WHERE catalog_id = :n"),
                     {"n": new, "o": old})
        conn.execute(sa.text("UPDATE components SET catalog_id = :o WHERE catalog_id = :n"),
                     {"n": new, "o": old})
    _set_kind(conn, "fiber_connector", _FIBER_KIND_OLD)
    _set_kind(conn, "rf_cable_connector", _RF_KIND_OLD)
    # Per-asset metadata (tipMm, housing, …) was stale/redundant and is not
    # restored — the anchors are the geometric source of truth.
