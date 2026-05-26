"""Backfill v3 metadata for 8 RF Asset3D rows (Phase RF.2 increment)

Revision ID: 0084_rf_v3_backfill
Revises: 0083_aom_v3_rf_in_face

Per asset-physics-model.md §8.7-§8.12, each RF Asset3D needs
``physics_kind`` + ``faces`` + ``transitions`` + ``default_params`` set so
the v3 catalog listing (and the PHY Editor RF tab) can render it. The
columns were added in 0082 but were left null for non-AOM rows.

Target rows (8 — pinned by asset name; ``primitive_box`` is shared by
several non-RF components and is intentionally not touched):

| Asset name                          | kind                              | model                 |
|-------------------------------------|-----------------------------------|-----------------------|
| primitive_dds_ad9959_pcb            | rf_source                         | AD9959/PCBZ           |
| thumb_antenna_glb                   | programmable_pulse_generator      | PPG (SMA)             |
| bnc_m_rca_f_adapter_glb             | programmable_pulse_generator      | PPG (BNC)             |
| primitive_rf_amplifier              | rf_amplifier                      | Mini-Circuits ZHL-1-2W+|
| primitive_thorlabs_ca2906_cable     | rf_cable                          | Thorlabs CA2906       |
| primitive_rf_cable_sma_to_bnc       | rf_cable                          | Generic SMA→BNC       |
| primitive_rf_cable_bnc_to_bnc       | rf_cable                          | Generic BNC↔BNC       |
| minicircuits_zyswa_2_50dr_asset     | rf_switch                         | Mini-Circuits ZYSWA-2-50DR |

Idempotent: skips any row that already has a non-null ``physics_kind``
(user / earlier migration already set it).

Downgrade clears physics_kind / catalog_id / faces / transitions /
default_params on the 8 rows. Destructive of user-edited v3 data —
dev-only.
"""

from __future__ import annotations

import json
from typing import Any

import sqlalchemy as sa

from alembic import op


revision = "0084_rf_v3_backfill"
down_revision = "0083_aom_v3_rf_in_face"
branch_labels = None
depends_on = None


# ---------------------------------------------------------------------------
# Face / transition templates per kind (mirror frontend KIND_GUIDES + the
# §8.7–§8.12 JSON examples in asset-physics-model.md).
# ---------------------------------------------------------------------------

def _vec(x: float, y: float, z: float) -> dict[str, float]:
    return {"x": float(x), "y": float(y), "z": float(z)}


def _rf_face(
    fid: str,
    pos: tuple[float, float, float],
    normal: tuple[float, float, float],
    *,
    domain: str = "rf",
    name: str | None = None,
) -> dict[str, Any]:
    face: dict[str, Any] = {
        "id": fid,
        "domain": domain,
        "positionMmBodyLocal": _vec(*pos),
        "normalBodyLocal": _vec(*normal),
        "apertureMm": 0,
        "apertureShape": "circle",
    }
    if name is not None:
        face["name"] = name
    return face


# AD9959/PCBZ — 4 channels on the +X edge of the PCB, body-frame offsets
# match the §8.7 doc example (y = -30, -10, +10, +30 mm; x = +82.55 mm).
AD9959_FACES = [
    _rf_face("rf_out", (82.55, -30.0, 4.0), (1.0, 0.0, 0.0), name="CH0"),
    _rf_face("rf_out", (82.55, -10.0, 4.0), (1.0, 0.0, 0.0), name="CH1"),
    _rf_face("rf_out", (82.55, +10.0, 4.0), (1.0, 0.0, 0.0), name="CH2"),
    _rf_face("rf_out", (82.55, +30.0, 4.0), (1.0, 0.0, 0.0), name="CH3"),
]
AD9959_TRANSITIONS = [
    {"in": "rf_out", "out": "rf_out", "op": "emit_rf_source"},
]
AD9959_PARAMS = {
    "referenceClockMhz": None,
    "sysClockMhz": None,
    "pllMultiplier": 25,
    "pllBypass": False,
    "serialInterface": "SPI",
    "syncRole": "standalone",
    "serialPortMode": "4wire",
}

# ZHL-1-2W+ — passthrough amp. rf_in on -z (inward), rf_out on +z (outward).
RF_AMP_FACES = [
    _rf_face("rf_in",  (0.0, 0.0, -30.0), (0.0, 0.0, -1.0)),
    _rf_face("rf_out", (0.0, 0.0, +30.0), (0.0, 0.0, +1.0)),
]
RF_AMP_TRANSITIONS = [
    {"in": "rf_in", "out": "rf_out", "op": "rf_amplify"},
]
RF_AMP_PARAMS_ZHL_1_2W = {
    "gainDb": 29,
    "frequencyRangeMhz": [5, 500],
    "outputPowerP1dbDbm": 29,
    "outputPowerMaxDbm": 30,
    "inputPowerMaxDbm": 0,
    "noiseFigureDb": 9,
    "supplyVoltageV": 24,
    "supplyCurrentA": 0.6,
    "inputReturnLossDb": 14,
    "outputReturnLossDb": 14,
    "connectorType": "sma",
}


def _rf_cable_template(
    length_mm: float,
    end_a: str,
    end_b: str,
    cable_type: str,
    max_freq_ghz: float = 3.0,
    jacket_color: str = "#c4a884",
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    half = length_mm / 2.0
    faces = [
        _rf_face("rf_in",  (0.0, 0.0, -half), (0.0, 0.0, -1.0)),
        _rf_face("rf_out", (0.0, 0.0, +half), (0.0, 0.0, +1.0)),
    ]
    # Cable is bidirectional — two transitions for clarity. Op is currently
    # identity; future loss model multiplies by 10^(-lossDbPerM*L/1000/20).
    transitions = [
        {"in": "rf_in",  "out": "rf_out", "op": "rf_pass"},
        {"in": "rf_out", "out": "rf_in",  "op": "rf_pass"},
    ]
    params = {
        "lengthMm": length_mm,
        "impedanceOhm": 50,
        "maxFrequencyGhz": max_freq_ghz,
        "connectorType": end_a if end_a == end_b else "sma",
        "endAConnector": end_a,
        "endBConnector": end_b,
        "cableType": cable_type,
        "jacketOuterDiameterMm": 3.2,
        "jacketColor": jacket_color,
        "minBendRadiusMm": 15,
    }
    return faces, transitions, params


# ZYSWA-2-50DR — SP2T switch. Common port + 2 throws + TTL ctrl.
RF_SWITCH_FACES = [
    _rf_face("rf_in",  (-25.0, 0.0, 0.0), (-1.0, 0.0, 0.0), name="RFIN"),
    _rf_face("rf_out", (+25.0, -10.0, 0.0), (+1.0, 0.0, 0.0), name="RF1"),
    _rf_face("rf_out", (+25.0, +10.0, 0.0), (+1.0, 0.0, 0.0), name="RF2"),
    _rf_face("ttl_in", (0.0, +25.0, 0.0), (0.0, +1.0, 0.0), domain="ttl"),
]
RF_SWITCH_TRANSITIONS = [
    {"in": "rf_in", "out": ["rf_out", "rf_out"], "op": "rf_switch_route"},
]
RF_SWITCH_PARAMS_ZYSWA = {
    "switchType": "SP2T",
    "throwCount": 2,
    "frequencyMinGhz": 0,
    "frequencyMaxGhz": 5,
    "insertionLossDb": 1,
    "isolationDb": 35,
    "switchingTimeNs": 250,
    "absorptionType": "absorptive",
    "controlLogic": "TTL",
    "controlVoltageHighV": 5,
    "supplyPositiveV": 5,
    "supplyNegativeV": -5,
    "supplyCurrentMa": 25,
    "maxInputPowerDbm": 27,
    "connectorType": "sma",
    "ttlActiveHighThrow": 2,
    "ttlState": "LOW",
}

# PPG — single TTL out face. Face id "rf_out" is historical; domain="ttl".
PPG_FACES = [
    _rf_face("rf_out", (0.0, 0.0, +15.0), (0.0, 0.0, +1.0), domain="ttl"),
]
PPG_TRANSITIONS = [
    {"in": "rf_out", "out": "rf_out", "op": "emit_ttl_steady"},
]
PPG_PARAMS_SMA = {
    "connectorType": "sma",
    "timingProgramId": None,
    "outputDomain": "ttl",
    "highVoltageV": 3.2,
}
PPG_PARAMS_BNC = {**PPG_PARAMS_SMA, "connectorType": "bnc"}


# ---------------------------------------------------------------------------
# Backfill plan: (asset_name, catalog_id, physics_kind, faces, transitions,
# default_params)
# ---------------------------------------------------------------------------

BACKFILL: list[dict[str, Any]] = [
    {
        "asset_name": "primitive_dds_ad9959_pcb",
        "catalog_id": "ad9959_pcbz_dds",
        "physics_kind": "rf_source",
        "faces": AD9959_FACES,
        "transitions": AD9959_TRANSITIONS,
        "default_params": AD9959_PARAMS,
    },
    {
        "asset_name": "thumb_antenna_glb",
        "catalog_id": "programmable_pulse_generator_sma",
        "physics_kind": "programmable_pulse_generator",
        "faces": PPG_FACES,
        "transitions": PPG_TRANSITIONS,
        "default_params": PPG_PARAMS_SMA,
    },
    {
        "asset_name": "bnc_m_rca_f_adapter_glb",
        "catalog_id": "programmable_pulse_generator_bnc",
        "physics_kind": "programmable_pulse_generator",
        "faces": PPG_FACES,
        "transitions": PPG_TRANSITIONS,
        "default_params": PPG_PARAMS_BNC,
    },
    {
        "asset_name": "primitive_rf_amplifier",
        "catalog_id": "minicircuits_zhl_1_2w_plus",
        "physics_kind": "rf_amplifier",
        "faces": RF_AMP_FACES,
        "transitions": RF_AMP_TRANSITIONS,
        "default_params": RF_AMP_PARAMS_ZHL_1_2W,
    },
    {
        "asset_name": "primitive_thorlabs_ca2906_cable",
        "catalog_id": "thorlabs_ca2906",
        "physics_kind": "rf_cable",
        **dict(zip(
            ("faces", "transitions", "default_params"),
            _rf_cable_template(152.4, "sma", "sma", "RG-316", 3.0, "#c4a884"),
        )),
    },
    {
        "asset_name": "primitive_rf_cable_sma_to_bnc",
        "catalog_id": "generic_rf_cable_sma_to_bnc",
        "physics_kind": "rf_cable",
        **dict(zip(
            ("faces", "transitions", "default_params"),
            _rf_cable_template(300.0, "sma", "bnc", "RG-316", 3.0, "#c4a884"),
        )),
    },
    {
        "asset_name": "primitive_rf_cable_bnc_to_bnc",
        "catalog_id": "generic_rf_cable_bnc_to_bnc",
        "physics_kind": "rf_cable",
        **dict(zip(
            ("faces", "transitions", "default_params"),
            _rf_cable_template(300.0, "bnc", "bnc", "RG-58", 1.0, "#1f2937"),
        )),
    },
    {
        "asset_name": "minicircuits_zyswa_2_50dr_asset",
        "catalog_id": "minicircuits_zyswa_2_50dr",
        "physics_kind": "rf_switch",
        "faces": RF_SWITCH_FACES,
        "transitions": RF_SWITCH_TRANSITIONS,
        "default_params": RF_SWITCH_PARAMS_ZYSWA,
    },
]


def upgrade() -> None:
    bind = op.get_bind()
    for entry in BACKFILL:
        row = bind.execute(
            sa.text(
                "SELECT id, physics_kind FROM assets_3d WHERE name = :name"
            ),
            {"name": entry["asset_name"]},
        ).first()
        if row is None:
            # Asset not in this DB — skip silently. The migration is
            # additive; a fresh seed without this row simply has nothing
            # to backfill.
            continue
        if row.physics_kind is not None:
            # Earlier work (manual edit / previous migration) already set
            # the v3 fields; leave them alone for idempotency.
            continue
        bind.execute(
            sa.text(
                """
                UPDATE assets_3d
                   SET catalog_id      = :catalog_id,
                       physics_kind    = :physics_kind,
                       faces           = CAST(:faces AS JSONB),
                       transitions     = CAST(:transitions AS JSONB),
                       default_params  = CAST(:default_params AS JSONB)
                 WHERE id = :id
                """
            ),
            {
                "id": row.id,
                "catalog_id": entry["catalog_id"],
                "physics_kind": entry["physics_kind"],
                "faces": json.dumps(entry["faces"]),
                "transitions": json.dumps(entry["transitions"]),
                "default_params": json.dumps(entry["default_params"]),
            },
        )


def downgrade() -> None:
    bind = op.get_bind()
    catalog_ids = [entry["catalog_id"] for entry in BACKFILL]
    bind.execute(
        sa.text(
            """
            UPDATE assets_3d
               SET catalog_id     = NULL,
                   physics_kind   = NULL,
                   faces          = NULL,
                   transitions    = NULL,
                   default_params = NULL
             WHERE catalog_id = ANY(:catalog_ids)
            """
        ),
        {"catalog_ids": catalog_ids},
    )
