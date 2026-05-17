"""Phase R1/R2: backfill wavelengthRangeNm + rename fiber field

Revision ID: 0055_wavelength_range
Revises: 0054_split_rf_cable_assets

Implements requirements R1/R2 from `docs/optical-kinds-spec.md`:

1. Renames ``fiber.kind_params.operatingWavelengthRangeNm`` →
   ``wavelengthRangeNm`` so every Passive optical kind uses the same
   field name (spectrometer convention).

2. Back-fills ``wavelengthRangeNm`` on every non-emitter optical
   ``physics_elements`` row that doesn't already carry one. Defaults
   mirror the plugin's ``defaultParams.wavelengthRangeNm`` values:
     - Visible Passive (mirror / lens / waveplate / polarizer / BS /
       isolator / detector / camera / spectrometer / wavemeter / dump):
       ``[400, 1100]``
     - NIR Active / Nonlinear (aom / eom / nonlinear_crystal /
       saturable_absorber): ``[400, 1700]``
     - Fiber-family (fiber / fiber_end): ``[770, 790]``

3. Back-fills ``centerWavelengthNm`` on ``tapered_amplifier`` rows that
   don't have one (defaults to 780 nm).

4. Re-partitions every affected row's ``kind_params`` into
   ``intrinsic_params`` + ``state_params`` using the refreshed manifest
   (waveplate's ``wavelengthRangeNm`` is now intrinsic; everywhere else
   the partition is unchanged because ``intrinsicParamKeys`` /
   ``stateParamKeys`` aren't declared).

Idempotent — re-running checks ``wavelengthRangeNm`` is already present
before writing.

Downgrade
---------
Renames ``wavelengthRangeNm`` back to ``operatingWavelengthRangeNm`` on
fiber rows. Does NOT remove the field from other kinds (the value is
harmless extra metadata and removing it would lose user-edited values).
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op


revision = "0055_wavelength_range"
down_revision = "0054_split_rf_cable_assets"
branch_labels = None
depends_on = None


# Defaults match the plugin defaultParams written in
# `frontend/src/kinds/<kind>/index.ts`.
_VISIBLE_RANGE = [400.0, 1100.0]
_NIR_RANGE = [400.0, 1700.0]
_FIBER_RANGE = [770.0, 790.0]

WAVELENGTH_DEFAULTS: dict[str, list[float]] = {
    # Passive
    "mirror": _VISIBLE_RANGE,
    "dichroic_mirror": _VISIBLE_RANGE,
    "lens_biconvex": _VISIBLE_RANGE,
    "lens_plano_convex": _VISIBLE_RANGE,
    "lens_cylindrical": _VISIBLE_RANGE,
    "waveplate": _VISIBLE_RANGE,
    "polarizer": _VISIBLE_RANGE,
    "beam_splitter": _VISIBLE_RANGE,
    "fiber_coupler": _VISIBLE_RANGE,
    "fiber": _FIBER_RANGE,
    "fiber_end": _FIBER_RANGE,
    "isolator": _VISIBLE_RANGE,
    # Active / Nonlinear
    "aom": _NIR_RANGE,
    "eom": _NIR_RANGE,
    "nonlinear_crystal": _NIR_RANGE,
    "saturable_absorber": _NIR_RANGE,
    # Sinks
    "detector": _VISIBLE_RANGE,
    "camera": _VISIBLE_RANGE,
    "spectrometer": _VISIBLE_RANGE,
    "wavemeter": _VISIBLE_RANGE,
    "beam_dump": _VISIBLE_RANGE,
}


def upgrade() -> None:
    # Imported here so alembic offline mode doesn't load the manifest at
    # SQL-generation time.
    from app.kinds_manifest import partition_kind_params

    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id, element_kind, kind_params FROM physics_elements")
    ).fetchall()

    for row in rows:
        kp = dict(row.kind_params or {})
        kind = row.element_kind
        dirty = False

        # (1) Rename fiber's operatingWavelengthRangeNm → wavelengthRangeNm.
        if kind == "fiber" and "operatingWavelengthRangeNm" in kp:
            kp["wavelengthRangeNm"] = kp.pop("operatingWavelengthRangeNm")
            dirty = True

        # (2) Backfill wavelengthRangeNm on every non-emitter optical kind
        # that doesn't already have one.
        default_range = WAVELENGTH_DEFAULTS.get(kind)
        if default_range is not None and "wavelengthRangeNm" not in kp:
            kp["wavelengthRangeNm"] = list(default_range)
            dirty = True

        # (3) Backfill TA centerWavelengthNm.
        if kind == "tapered_amplifier" and "centerWavelengthNm" not in kp:
            kp["centerWavelengthNm"] = 780.0
            dirty = True

        if not dirty:
            continue

        intrinsic, state = partition_kind_params(kind, kp)
        conn.execute(
            sa.text(
                "UPDATE physics_elements SET "
                "kind_params = CAST(:kp AS JSONB), "
                "intrinsic_params = CAST(:i AS JSONB), "
                "state_params = CAST(:s AS JSONB) "
                "WHERE id = :id"
            ),
            {
                "kp": json.dumps(kp),
                "i": json.dumps(intrinsic),
                "s": json.dumps(state),
                "id": row.id,
            },
        )


def downgrade() -> None:
    """Renames ``wavelengthRangeNm`` back to ``operatingWavelengthRangeNm``
    on fiber rows. Does NOT remove the field from other kinds — the value
    is harmless extra metadata and removing it would lose user-edited
    values. Re-partitioning also reverts since the manifest read during
    the rollback no longer has waveplate's wavelengthRangeNm as intrinsic.
    """
    from app.kinds_manifest import partition_kind_params

    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "SELECT id, element_kind, kind_params FROM physics_elements "
            "WHERE element_kind = 'fiber'"
        )
    ).fetchall()
    for row in rows:
        kp = dict(row.kind_params or {})
        if "wavelengthRangeNm" not in kp:
            continue
        kp["operatingWavelengthRangeNm"] = kp.pop("wavelengthRangeNm")
        intrinsic, state = partition_kind_params(row.element_kind, kp)
        conn.execute(
            sa.text(
                "UPDATE physics_elements SET "
                "kind_params = CAST(:kp AS JSONB), "
                "intrinsic_params = CAST(:i AS JSONB), "
                "state_params = CAST(:s AS JSONB) "
                "WHERE id = :id"
            ),
            {
                "kp": json.dumps(kp),
                "i": json.dumps(intrinsic),
                "s": json.dumps(state),
                "id": row.id,
            },
        )
