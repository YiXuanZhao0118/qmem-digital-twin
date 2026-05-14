"""Seed a default rf_in anchor on existing AOM assets

Revision ID: 0048_aom_default_rf_in
Revises: 0047_aom_drop_rf_drive

Phase B (RF link single-source-of-truth) introduces an rf_in port on the
AOM so an rf_cable can attach to the transducer side. Pre-Phase-B AOM
assets (MT80 + variants) were authored with only the three optical /
acoustic-direction anchors (intercept_in, intercept_out, rf_direction);
without an rf_in anchor the Align RF logic has no target to snap to and
the user-visible bug "cable connects to AD9959 fine but won't attach to
the AOM" results.

Backfill strategy
-----------------
For every Asset3D row that backs at least one Component of type "aom":

* If the asset already has an `rf_in` anchor → leave it alone (idempotent).

* Otherwise, place a default rf_in anchor on the +X face of the body
  (where the transducer typically lives on an MT80 — the absorber sits on
  -X). The geometry is parametrised by `transducerOffsetFromCenterMmX`
  (typical 15 mm for MT80) so vendor-specific Components can override
  via Component.properties. Direction is +X (outward), aperture 3.5 mm
  (typical SMA inner-conductor radius).

Users can refine the position / direction in the PHY Editor afterwards
— the anchor identity (id + name + count) is NOT locked by an
anchor_contract entry here, deferred until we have multiple AOM vendors
with diverging geometries.

Idempotent: re-running this migration is a no-op for assets that
already carry an rf_in anchor.

Downgrade
---------
Removes any anchor whose `id == "rf_in"` from AOM assets. Destructive of
user-edited rf_in anchors so downgrade is dev-only.
"""

from __future__ import annotations

import json
from typing import Any

import sqlalchemy as sa

from alembic import op


revision = "0048_aom_default_rf_in"
down_revision = "0047_aom_drop_rf_drive"
branch_labels = None
depends_on = None


_RF_IN_ID = "rf_in"


def _coerce_number(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def _derive_rf_in_x_mm(props: dict[str, Any]) -> float:
    """Pick the +X offset where the transducer (SMA connector) sits.

    Property precedence:
      1. `transducerOffsetFromCenterMmX` — explicit override from a
         component's vendor-spec properties.
      2. `dimensionsMm[1]/2` minus an eyeballed 2 mm housing wall (the
         transducer sits flush against the +X face). `dimensionsMm` for
         AOMs is conventionally [length(Y), width(X), height(Z)].
      3. Generic 15 mm fallback (typical MT80 half-width).
    """
    explicit = _coerce_number(props.get("transducerOffsetFromCenterMmX"))
    if explicit is not None:
        return explicit
    dims = props.get("dimensionsMm") if isinstance(props.get("dimensionsMm"), list) else None
    if dims and len(dims) >= 2:
        width_x = _coerce_number(dims[1])
        if width_x is not None and width_x > 4.0:
            # +X face minus a 2 mm housing wall — the SMA pin sits just
            # inside the face. Negative offsets are nonsensical here, so
            # clamp to a tiny positive value if the math goes weird.
            return max(2.0, width_x / 2.0 - 2.0)
    return 15.0


def _build_rf_in_anchor(props: dict[str, Any]) -> dict[str, Any]:
    x = _derive_rf_in_x_mm(props)
    return {
        "id": _RF_IN_ID,
        "name": None,
        "type": None,
        "positionMmBodyLocal": {"x": float(x), "y": 0.0, "z": 0.0},
        "directionBodyLocal": {"x": 1.0, "y": 0.0, "z": 0.0},
        # SMA inner-conductor radius ≈ 0.635 mm; pin face footprint a bit
        # wider so the marker is visible at scene scale.
        "apertureMm": 3.5,
        "apertureWidthMm": None,
        "apertureHeightMm": None,
    }


def _existing_ids(anchors: list[Any]) -> set[str]:
    return {
        a.get("id") for a in anchors
        if isinstance(a, dict) and isinstance(a.get("id"), str)
    }


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            """
            SELECT DISTINCT a.id          AS asset_id,
                            a.anchors     AS anchors,
                            c.properties  AS properties
              FROM assets_3d a
              JOIN components c ON c.asset_3d_id = a.id
             WHERE c.component_type = 'aom'
            """
        )
    ).fetchall()

    for row in rows:
        anchors = list(row.anchors or [])
        if _RF_IN_ID in _existing_ids(anchors):
            continue
        new_anchor = _build_rf_in_anchor(row.properties or {})
        anchors.append(new_anchor)
        bind.execute(
            sa.text(
                "UPDATE assets_3d SET anchors = CAST(:new AS JSONB) WHERE id = :id"
            ),
            {"new": json.dumps(anchors), "id": row.asset_id},
        )


def downgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            """
            SELECT DISTINCT a.id      AS asset_id,
                            a.anchors AS anchors
              FROM assets_3d a
              JOIN components c ON c.asset_3d_id = a.id
             WHERE c.component_type = 'aom'
            """
        )
    ).fetchall()

    for row in rows:
        anchors = list(row.anchors or [])
        filtered = [
            a for a in anchors
            if not (isinstance(a, dict) and a.get("id") == _RF_IN_ID)
        ]
        if filtered == anchors:
            continue
        bind.execute(
            sa.text(
                "UPDATE assets_3d SET anchors = CAST(:new AS JSONB) WHERE id = :id"
            ),
            {"new": json.dumps(filtered), "id": row.asset_id},
        )
