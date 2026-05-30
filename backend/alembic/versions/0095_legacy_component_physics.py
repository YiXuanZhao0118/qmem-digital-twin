"""Migrate AOM per-instance state to SceneObject; strip legacy component physics.

Revision ID: 0095_legacy_component_physics
Revises: 0094_strip_component_physics

Retirement Phase 3/4 (legacy dev-DB devices). A handful of pre-catalog
components (catalog_id IS NULL: BoosTA pro, MT80-A1.5-IR AOM, ZHL-1-2W+ RF amp)
still carry physics on ``components.properties``. Their bound Asset3D already
holds the authoritative physics in ``default_params``, so the component copies
are redundant.

Per-instance AOM operating state (Bragg tilt, diffraction order, acoustic axis)
has no asset home — it belongs on ``SceneObject.dynamic_sources``. Step 1 moves
it there; Step 2 strips every physics key from the components.
"""

from __future__ import annotations

from alembic import op


revision = "0095_legacy_component_physics"
down_revision = "0094_strip_component_physics"
branch_labels = None
depends_on = None


# Physics keys to remove from components.properties. Geometry / catalog
# metadata (dimensionsMm, geometry, sourceUrl, datasheetUrl, connectorType,
# opticalAxisHeightMm, ports, notes, physics_capabilities) is intentionally
# kept.
_PHYSICS_KEYS = [
    # tapered amplifier (BoosTA)
    "gainMaxDb", "maxAmplifierCurrentMa", "outputPowerMaxMw", "polarization",
    "wavelengthRangeNm",
    # AOM (MT80)
    "acousticAxisBodyLocal", "acousticBeamWidthMm", "acousticVelocityMPerS",
    "braggAngularAcceptanceMrad", "braggTiltAngleDegBodyLocal", "crystalLengthMm",
    "diffractionEfficiencyTypical", "diffractionOrder", "figureOfMeritM2",
    "modulationBandwidthMhz", "refractiveIndex", "regime", "rfPowerMaxW",
    "rfPropagationDirectionBodyLocal",
    # RF amplifier (ZHL)
    "frequencyRangeMhz", "gainDb", "inputPowerMaxDbm", "noiseFigureDb",
    "outputPowerMaxDbm", "outputPowerP1dbDbm", "supplyCurrentA", "supplyVoltageV",
]


def upgrade() -> None:
    # Step 1 — migrate AOM per-instance operating state to the SceneObject.
    # Existing dynamic_sources values win on conflict (right-hand side of ||).
    op.execute(
        """
        UPDATE objects o
        SET dynamic_sources = jsonb_strip_nulls(jsonb_build_object(
                'braggTiltAngleDegBodyLocal', c.properties->'braggTiltAngleDegBodyLocal',
                'diffractionOrder',           c.properties->'diffractionOrder',
                'acousticAxisBodyLocal',      c.properties->'acousticAxisBodyLocal'
            )) || COALESCE(o.dynamic_sources, '{}'::jsonb)
        FROM components c
        WHERE o.component_id = c.id
          AND (c.properties ? 'braggTiltAngleDegBodyLocal'
               OR c.properties ? 'diffractionOrder'
               OR c.properties ? 'acousticAxisBodyLocal')
        """
    )

    # Step 2 — strip every legacy physics key from components.properties.
    keys = "ARRAY[" + ", ".join(f"'{k}'" for k in _PHYSICS_KEYS) + "]::text[]"
    op.execute(f"UPDATE components SET properties = properties - {keys}")


def downgrade() -> None:
    # Irreversible: the stripped keys were duplicates of the bound
    # Asset3D.default_params (operating state preserved on the SceneObject).
    pass
