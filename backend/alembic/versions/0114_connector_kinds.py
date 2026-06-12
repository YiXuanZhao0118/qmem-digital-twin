"""Add the cable-connector kinds ``fiber_connector`` / ``rf_cable_connector``.

First step of the connector refactor (plan 2026-06-12, §3.1 / §7). These
are first-class catalog kinds; the 9 real connectors land as Asset3D rows
under them in 0115. Each owns two geometry anchors — ``connect_out``
(origin, −X, the spline junction) and ``connect_in`` (at ``tipMm``, +X,
the mating / ferrule face). Physics is a pass-through (the cable-body op
reads the end-connector params); the backend registers the matching
anchor op in ``optical/anchor_ops/connector.py``.

``op_set_name`` is set to the kind name itself — same as every kind that
0086 seeds from ``kinds.json`` (``op_set_name = plugin["id"]``). The
anchor tracer dispatches on the kind name, not ``op_set_name``, so a
separate op-set label would never be consulted and would silently drift
between fresh installs (seeded by 0086) and existing DBs (seeded here).

``ON CONFLICT (name) DO NOTHING`` so a fresh ``alembic upgrade head`` —
where 0086 already inserts these from the regenerated ``kinds.json`` —
no-ops here instead of failing on the unique ``name``.

Revision ID: 0114_connector_kinds
Revises: 0113_param_ownership_tunable
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0114_connector_kinds"
down_revision = "0113_param_ownership_tunable"
branch_labels = None
depends_on = None


# (name, display_name, domains-SQL-literal, needs_aperture, default_params, anchors)
# domains is inlined as an ARRAY literal (not a bound param) because the
# asyncpg driver needs a real iterable for text[] — same as 0110.
_CONNECTOR_KINDS = [
    (
        "fiber_connector",
        "Fiber Connector",
        "ARRAY['optical']::text[]",
        True,
        {
            "housing": "FC",
            "polish": "PC",
            "polishAngleDeg": 0.0,
            "fiberType": "single_mode",
            "mfdUm": 5.3,
            "na": 0.13,
            "coreUm": 4.4,
            "claddingUm": 125.0,
            "tipMm": 36.28,
            "apertureDiameterMm": 0.125,
            "glassIndexAtDesignLambda": 1.4506,
            "slowAxisKeyed": False,
            "returnLossDb": 40.0,
            "wavelengthRangeNm": [770.0, 790.0],
        },
        {
            "required": ["connect_in", "connect_out"],
            "optional": [],
            "needs_direction": ["connect_in", "connect_out"],
            "needs_aperture": ["connect_in"],
        },
    ),
    (
        "rf_cable_connector",
        "RF Cable Connector",
        "ARRAY['rf']::text[]",
        False,
        {
            "family": "sma",
            "gender": "male",
            "tipMm": 15.5,
            "impedanceOhm": 50.0,
            "maxFreqGhz": 18.0,
            "couplingType": "thread",
        },
        {
            "required": ["connect_in", "connect_out"],
            "optional": [],
            "needs_direction": ["connect_in", "connect_out"],
            "needs_aperture": [],
        },
    ),
]


def upgrade() -> None:
    conn = op.get_bind()
    for name, display_name, domains_sql, needs_aperture, default_params, anchors in (
        _CONNECTOR_KINDS
    ):
        conn.execute(
            sa.text(
                "INSERT INTO kinds ("
                "name, display_name, op_set_name, domains, "
                "default_params, anchor_template, needs_aperture, "
                "wavelength_range_nm, frequency_range_mhz, description"
                ") VALUES ("
                ":name, :display_name, :op_set_name, "
                f"{domains_sql}, "
                "CAST(:default_params AS JSONB), CAST(:anchor_template AS JSONB), "
                ":needs_aperture, NULL, NULL, :description"
                ") ON CONFLICT (name) DO NOTHING"
            ),
            {
                "name": name,
                "display_name": display_name,
                "op_set_name": name,
                "default_params": json.dumps(default_params),
                "anchor_template": json.dumps(anchors),
                "needs_aperture": needs_aperture,
                "description": f"{display_name} - cable-end connector "
                "(connect_in / connect_out geometry, passthrough physics).",
            },
        )


def downgrade() -> None:
    op.get_bind().execute(
        sa.text(
            "DELETE FROM kinds WHERE name IN "
            "('fiber_connector', 'rf_cable_connector')"
        )
    )
