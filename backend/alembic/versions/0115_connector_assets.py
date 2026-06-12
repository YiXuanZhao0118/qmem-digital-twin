"""Seed the 9 connector Asset3D rows (5 fibre + 4 RF).

Second step of the cable-connector refactor (plan 2026-06-12, §4 / §7).
Each connector is its own Asset3D row under the kinds seeded by 0114
(`fiber_connector` / `rf_cable_connector`). Per the 0061 "always clone,
never share" rule the 5 fibre rows each get their OWN row even though they
share one STL file — anchor edits in the PHY Editor must not clobber a
sibling connector.

Anchors are the full Phase-9.1 tri-axis frame (alembic 0087): `connect_out`
at the origin pointing −X (spline junction) and `connect_in` at (tipMm,0,0)
pointing +X (mating / ferrule face). See [[kinds.md]] connector section.

`wavelengthRangeNm` is column-owned (`wavelength_range_nm`), NOT in
`default_params` — the asset↔kind param invariant (kinds.md §每 kind 契約).

Seeding is via this migration only: `seed_v3_assets.py` is a manual, stale
script (references retired faces/transitions) and is not part of fresh
provisioning — `alembic upgrade head` is. Idempotent via WHERE NOT EXISTS
on catalog_id so a re-stamp can't duplicate.

Geometry: fibre rows reuse the existing FC STL; the 4 RF rows reference
procedural keys (`primitive://{sma,bnc}_{male,female}_connector`) whose
renderers (male exist, female to author) wire in at the render phase (P2) —
until then a standalone connector falls back to a box. Connectors are cable
sub-parts, not placed standalone, so that interim is harmless.

Revision ID: 0115_connector_assets
Revises: 0114_connector_kinds
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0115_connector_assets"
down_revision = "0114_connector_kinds"
branch_labels = None
depends_on = None


FC_STL = "files/stl/thorlabs_fc_apc_30126a9.stl"


def _anchors(tip_mm: float, aperture_mm: float | None) -> list[dict]:
    """connect_out (origin, −X) + connect_in (tipMm, +X). Tri-axis frame."""
    connect_out = {
        "id": "connect_out",
        "positionMmBodyLocal": {"x": 0.0, "y": 0.0, "z": 0.0},
        "axisXBodyLocal": {"x": -1.0, "y": 0.0, "z": 0.0},
        "axisYBodyLocal": {"x": 0.0, "y": 1.0, "z": 0.0},
        "axisZBodyLocal": {"x": 0.0, "y": 0.0, "z": -1.0},
    }
    connect_in = {
        "id": "connect_in",
        "positionMmBodyLocal": {"x": tip_mm, "y": 0.0, "z": 0.0},
        "axisXBodyLocal": {"x": 1.0, "y": 0.0, "z": 0.0},
        "axisYBodyLocal": {"x": 0.0, "y": 1.0, "z": 0.0},
        "axisZBodyLocal": {"x": 0.0, "y": 0.0, "z": 1.0},
    }
    if aperture_mm is not None:
        connect_in["apertureMm"] = aperture_mm
        connect_in["apertureShape"] = "circle"
    return [connect_out, connect_in]


_FIBER_COMMON = {
    "housing": "FC",
    "tipMm": 36.28,
    "apertureDiameterMm": 0.125,
    "glassIndexAtDesignLambda": 1.4506,
}

# (catalog_id, name, vendor_part, default_params-extra)
_FIBER_ROWS = [
    ("fiber_connector_apc_pm", "Fiber Connector FC/APC (PM)", "Thorlabs 30126A9", {
        "polish": "APC", "polishAngleDeg": 8.0, "fiberType": "polarization_maintaining",
        "mfdUm": 5.3, "na": 0.13, "coreUm": 4.4, "claddingUm": 125.0,
        "slowAxisKeyed": True, "returnLossDb": 60.0,
    }),
    ("fiber_connector_pc_pm", "Fiber Connector FC/PC (PM)", "Thorlabs 30126A9", {
        "polish": "PC", "polishAngleDeg": 0.0, "fiberType": "polarization_maintaining",
        "mfdUm": 5.3, "na": 0.13, "coreUm": 4.4, "claddingUm": 125.0,
        "slowAxisKeyed": True, "returnLossDb": 40.0,
    }),
    ("fiber_connector_apc_sm", "Fiber Connector FC/APC (SM)", "Thorlabs 30126A9", {
        "polish": "APC", "polishAngleDeg": 8.0, "fiberType": "single_mode",
        "mfdUm": 5.3, "na": 0.13, "coreUm": 4.4, "claddingUm": 125.0,
        "slowAxisKeyed": False, "returnLossDb": 60.0,
    }),
    ("fiber_connector_pc_sm", "Fiber Connector FC/PC (SM)", "Thorlabs 30126A9", {
        "polish": "PC", "polishAngleDeg": 0.0, "fiberType": "single_mode",
        "mfdUm": 5.3, "na": 0.13, "coreUm": 4.4, "claddingUm": 125.0,
        "slowAxisKeyed": False, "returnLossDb": 40.0,
    }),
    ("fiber_connector_pc_mm", "Fiber Connector FC/PC (MM 50µm)", "Thorlabs 30126A9", {
        "polish": "PC", "polishAngleDeg": 0.0, "fiberType": "multi_mode",
        "mfdUm": None, "na": 0.22, "coreUm": 50.0, "claddingUm": 125.0,
        "slowAxisKeyed": False, "returnLossDb": 40.0,
    }),
]

# (catalog_id, name, primitive-key, default_params)
_RF_ROWS = [
    ("rf_connector_sma_male", "SMA Connector (male)", "sma_male_connector", {
        "family": "sma", "gender": "male", "tipMm": 15.5,
        "impedanceOhm": 50.0, "maxFreqGhz": 18.0, "couplingType": "thread",
    }),
    ("rf_connector_sma_female", "SMA Connector (female)", "sma_female_connector", {
        "family": "sma", "gender": "female", "tipMm": 15.5,
        "impedanceOhm": 50.0, "maxFreqGhz": 18.0, "couplingType": "thread",
    }),
    ("rf_connector_bnc_male", "BNC Connector (male)", "bnc_male_connector", {
        "family": "bnc", "gender": "male", "tipMm": 27.0,
        "impedanceOhm": 50.0, "maxFreqGhz": 4.0, "couplingType": "bayonet",
    }),
    ("rf_connector_bnc_female", "BNC Connector (female)", "bnc_female_connector", {
        "family": "bnc", "gender": "female", "tipMm": 27.0,
        "impedanceOhm": 50.0, "maxFreqGhz": 4.0, "couplingType": "bayonet",
    }),
]


# wavelength_range_nm is inlined as an ARRAY literal (not a bound param) —
# same asyncpg float8[]/text[] reason as 0114's domains.
_INSERT_TMPL = (
    "INSERT INTO assets_3d ("
    " catalog_id, name, asset_type, file_path, source, unit, scale_factor,"
    " kind_id, default_params, anchors, tunable_params, wavelength_range_nm,"
    " properties, locked"
    ") SELECT"
    " :catalog_id, :name, :asset_type, :file_path, :source, 'mm', 1.0,"
    " :kind_id, CAST(:default_params AS jsonb), CAST(:anchors AS jsonb),"
    " CAST('[]' AS jsonb), {wl}, CAST(:properties AS jsonb), false"
    " WHERE NOT EXISTS (SELECT 1 FROM assets_3d WHERE catalog_id = :catalog_id)"
)


def upgrade() -> None:
    conn = op.get_bind()

    # Fibre connectors — one STL, cloned per row (0061 rule). wavelength
    # range is column-owned; aperture = cladding 125 µm = 0.125 mm.
    sql_fiber = sa.text(_INSERT_TMPL.format(wl="ARRAY[770.0, 790.0]::double precision[]"))
    for catalog_id, name, vendor_part, dp_extra in _FIBER_ROWS:
        default_params = {**_FIBER_COMMON, **dp_extra}
        conn.execute(sql_fiber, {
            "catalog_id": catalog_id,
            "name": name,
            "asset_type": "stl",
            "file_path": FC_STL,
            "source": "connector refactor 0115 (shared FC STL, cloned per slug)",
            "kind_id": "fiber_connector",
            "default_params": json.dumps(default_params),
            "anchors": json.dumps(_anchors(36.28, 0.125)),
            "properties": json.dumps({"vendorPart": vendor_part, "displayName": name}),
        })

    # RF connectors — procedural geometry (male exist; female authored at
    # render phase). No optical wavelength range.
    sql_rf = sa.text(_INSERT_TMPL.format(wl="NULL"))
    for catalog_id, name, prim_key, default_params in _RF_ROWS:
        conn.execute(sql_rf, {
            "catalog_id": catalog_id,
            "name": name,
            "asset_type": "primitive",
            "file_path": f"primitive://{prim_key}",
            "source": "connector refactor 0115 (procedural)",
            "kind_id": "rf_cable_connector",
            "default_params": json.dumps(default_params),
            "anchors": json.dumps(_anchors(default_params["tipMm"], None)),
            "properties": json.dumps({"displayName": name}),
        })


def downgrade() -> None:
    catalog_ids = [r[0] for r in _FIBER_ROWS] + [r[0] for r in _RF_ROWS]
    in_list = ", ".join(f"'{cid}'" for cid in catalog_ids)
    op.get_bind().execute(
        sa.text(f"DELETE FROM assets_3d WHERE catalog_id IN ({in_list})")
    )
