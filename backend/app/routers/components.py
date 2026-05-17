from __future__ import annotations

import copy
import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.db import get_session
from app.models import (
    Asset3D,
    BeamPath,
    Collection,
    CollectionMember,
    Component,
    PhysicsElement,
    OpticalLink,
    SceneObject,
)
from app.v2_bindings import (
    bootstrap_aom_default_binding,
    bootstrap_beam_splitter_default_bindings,
    bootstrap_isolator_default_binding,
    bootstrap_laser_default_binding_and_source,
    bootstrap_mirror_default_binding,
    bootstrap_polarization_axis_binding,
)
from app.websocket import manager


router = APIRouter()


def component_payload(component: Component) -> dict[str, object]:
    return schemas.ComponentOut.model_validate(component).model_dump(mode="json", by_alias=True)


def is_component_locked(component: Component) -> bool:
    return component.properties.get("locked") is True


# =============================================================================
# Component name defaulting + uniqueness
# =============================================================================
#
# Default policy (confirmed with user 2026-05-16):
#   - On create, if `name` is omitted/blank, derive it from `model`; fall back
#     to `component_type` when `model` is null/empty.
#   - Names are unique case-insensitively across all Component rows. On
#     collision, append `-2`, `-3`, … until a free slot is found.
#   - Users keep the freedom to rename via PUT — uniqueness is enforced there
#     too (returns 409 if the explicit name clashes).


def normalize_component_name(name: str | None) -> str:
    normalized = (name or "").strip()
    if not normalized:
        raise HTTPException(status_code=400, detail="Component name cannot be empty.")
    return normalized


async def component_name_exists(
    session: AsyncSession,
    name: str,
    exclude_component_id: uuid.UUID | None = None,
) -> bool:
    # Archived rows are "in trash" — they don't reserve names. This means
    # restoring an archived component may need a rename if its slot has been
    # reclaimed, which is the right tradeoff (visible catalog stays clean).
    stmt = (
        select(Component.id)
        .where(func.lower(Component.name) == name.lower())
        .where(Component.archived_at.is_(None))
    )
    if exclude_component_id is not None:
        stmt = stmt.where(Component.id != exclude_component_id)
    return await session.scalar(stmt) is not None


async def require_unique_component_name(
    session: AsyncSession,
    name: str | None,
    exclude_component_id: uuid.UUID | None = None,
) -> str:
    normalized = normalize_component_name(name)
    if await component_name_exists(session, normalized, exclude_component_id):
        raise HTTPException(
            status_code=409,
            detail=f'Component name "{normalized}" already exists.',
        )
    return normalized


def _default_component_base_name(model: str | None, component_type: str) -> str:
    base = (model or "").strip() or (component_type or "").strip()
    return base or "component"


async def next_component_name(
    session: AsyncSession,
    model: str | None,
    component_type: str,
) -> str:
    base = _default_component_base_name(model, component_type)
    if not await component_name_exists(session, base):
        return base
    index = 2
    while True:
        candidate = f"{base}-{index}"
        if not await component_name_exists(session, candidate):
            return candidate
        index += 1


# =============================================================================
# Optical-element auto-sync
# =============================================================================
#
# `Component.component_type` is just a tag (used by the catalog UI for
# grouping). The optical solver only sees `PhysicsElement` rows. To stop
# users from "adding a mirror" and silently getting nothing in the simulator,
# every Component whose component_type maps to a known optical kind gets an
# PhysicsElement auto-created with sensible defaults the moment it lands in
# the DB. Already-existing rows are backfilled on demand via
# POST /api/components/{id}/auto-register-optical.

from app.kinds_manifest import component_type_to_kind as _ctype_to_kind_from_manifest

# Pre-P2 this was a hand-maintained dict that had to stay in sync with
# the frontend `COMPONENT_TYPE_TO_KIND` in `elementDefaults.ts` (see
# the original "Mirror of backend OPTICAL_COMPONENT_TYPE_TO_KIND from
# app/routers/components.py — keep in sync" comment in the frontend
# file). M4 makes both sides read from a single manifest generated
# from the frontend PhysicsPlugin registry, so drift is structurally
# impossible: a new componentType is added in exactly one place
# (the plugin file in `frontend/src/kinds/<kind>/index.ts`) and both
# sides see it after `npm run export:kinds`.
OPTICAL_COMPONENT_TYPE_TO_KIND: dict[str, str] = _ctype_to_kind_from_manifest()

# Minimum-viable kind_params for each kind so the auto-created PhysicsElement
# passes validation. The user can edit through the OpticalElementPanel UI.
DEFAULT_KIND_PARAMS: dict[str, dict[str, object]] = {
    # V2 Phase 3 (alembic 0029): every beam-defining laser parameter moved
    # to objects.properties.opticalSources[].beam, populated by the
    # auto_create_physics_element_for_object bootstrap (see
    # v2_bindings.bootstrap_laser_default_binding_and_source). Residual
    # advanced fields (e.g. rinDbcPerHz) can still live here.
    "laser_source": {},
    "tapered_amplifier": {
        # Legacy fields — kept for back-compat with the bare-chip entry and
        # for the topology solver's simple gain model.
        "smallSignalGainDb": 25.0,
        "saturationPowerMw": 500.0,
        "minInputPowerMw": 10.0,
        "maxInputPowerMw": 30.0,
        "inputAcceptanceRadiusMm": 25.0,
        "ase": {"powerMw": 0.5, "bandwidthNm": 5.0, "centerOffsetNm": 0.0},
        "inputSpatialModeX": {"waistUm": 600.0, "waistZOffsetMm": 0.0, "mSquared": 1.5},
        "inputSpatialModeY": {"waistUm": 600.0, "waistZOffsetMm": 0.0, "mSquared": 1.5},
        "inputPolarization": {"exRe": 0.0, "exIm": 0.0, "eyRe": 1.0, "eyIm": 0.0},
        "outputSpatialModeX": {"waistUm": 800.0, "waistZOffsetMm": 0.0, "mSquared": 1.2},
        "outputSpatialModeY": {"waistUm": 800.0, "waistZOffsetMm": 0.0, "mSquared": 1.2},
        "outputTransverseMode": {"kind": "TEM00"},
        # BoosTA pro–style operating point: live drive-current control + 2D
        # gain table + 1D ASE-vs-current curve + backward beam profile.
        # Defaults sized for 852 nm BoosTA pro (3 W output @ 2.4 A typical).
        # The shapes are coarse — user is expected to fine-tune in the panel.
        "centerWavelengthNm": 852.0,
        "driveCurrentMa": 2400.0,
        "driveCurrentMaxMa": 5000.0,
        # ASE-only (no seed). NOTE: forward = amplified-port emission
        # (intercept_out, the wider tapered facet), backward = seed-side
        # leak (intercept_in, the narrow facet). Values were swapped in
        # the original seed; corrected here so the larger ASE belongs to
        # the forward (output-port) direction. Numbers are
        # order-of-magnitude estimates for an 852 nm BoosTA pro chip.
        "aseSamples": [
            {"driveCurrentMa": 0.0,    "forwardPowerMw": 0.0,   "backwardPowerMw": 0.0},
            {"driveCurrentMa": 1000.0, "forwardPowerMw": 25.0,  "backwardPowerMw": 5.0},
            {"driveCurrentMa": 2400.0, "forwardPowerMw": 200.0, "backwardPowerMw": 80.0},
            {"driveCurrentMa": 5000.0, "forwardPowerMw": 500.0, "backwardPowerMw": 250.0},
        ],
        # With seed: forward saturates near rated output, backward drops as
        # the seed extracts the gain medium. Sample at 2400 mA (default
        # operating point) across the rated input range 5..40 mW. The
        # input=0 row mirrors the corresponding aseSamples point so the
        # bilinear interpolation stays continuous across the seed/no-seed
        # boundary.
        "gainSamples": [
            {"inputPowerMw": 0.0,  "driveCurrentMa": 2400.0, "forwardPowerMw": 200.0,  "backwardPowerMw": 80.0},
            {"inputPowerMw": 5.0,  "driveCurrentMa": 2400.0, "forwardPowerMw": 1200.0, "backwardPowerMw": 120.0},
            {"inputPowerMw": 10.0, "driveCurrentMa": 2400.0, "forwardPowerMw": 1800.0, "backwardPowerMw": 80.0},
            {"inputPowerMw": 20.0, "driveCurrentMa": 2400.0, "forwardPowerMw": 2500.0, "backwardPowerMw": 50.0},
            {"inputPowerMw": 40.0, "driveCurrentMa": 2400.0, "forwardPowerMw": 3000.0, "backwardPowerMw": 35.0},
        ],
        "backwardSpatialModeX": {"waistUm": 600.0, "waistZOffsetMm": 0.0, "mSquared": 1.5},
        "backwardSpatialModeY": {"waistUm": 600.0, "waistZOffsetMm": 0.0, "mSquared": 1.5},
    },
    # V2 Phase 2 (alembic 0028): surface normal lives on
    # objects.properties.anchorBindings[opticalSurface].payload.normalBodyLocal,
    # populated either by the migration backfill or by the asset-drop default
    # binding. Not a kindParam any more.
    "mirror": {"reflectivity": 0.99},
    # V2 Phase 5 (alembic 0031).
    "lens_biconvex": {"focalMm": 100.0, "transmission": 0.99},
    "lens_plano_convex": {"focalMm": 100.0, "transmission": 0.99},
    "lens_cylindrical": {"focalMm": 100.0, "cylindricalAxis": "x", "transmission": 0.99},
    # V2 Phase 4 (alembic 0030): axis angles moved to
    # objects.properties.anchorBindings[polarizationReference].payload.axisDegBeamLocal.
    "waveplate": {"retardanceLambda": 0.5, "transmission": 0.99},
    "polarizer": {"extinctionRatioDb": 30.0, "transmission": 0.95},
    # V2 Phase 6 (alembic 0032): coating normal + PBS axis moved to bindings.
    "beam_splitter": {
        "splitRatioTransmitted": 0.5,
        "polarizing": False,
        "extinctionRatioDb": 30.0,
        "transmission": 0.99,
    },
    "dichroic_mirror": {
        "cutoffWavelengthNm": 800.0,
        "passBand": "long",
        "transmission": 0.95,
        "reflectivity": 0.95,
    },
    "fiber_coupler": {
        "couplingEfficiency": 0.7,
        "modeFieldDiameterUm": 5.0,
        "fiberType": "single_mode",
    },
    # Defaults match a Thorlabs P1-780PM-FC-1 polarisation-maintaining
    # patch cable (780 nm design wavelength, FC/PC connectors, ~5.3 µm
    # MFD, 0.13 NA). Per-end spec is identical on both sides; the user
    # can split A/B in the kinds editor for hybrid cables.
    "fiber": {
        "fiberType": "polarization_maintaining",
        "endA": {
            "apertureDiameterMm": 0.125,
            "numericalAperture": 0.13,
            "modeFieldDiameterUm": 5.3,
            "coreDiameterUm": 4.4,
            "claddingDiameterUm": 125.0,
            "connectorType": "FC",
            "polish": "PC",
            "polishAngleDeg": 0.0,
            "fresnelResidual": 1.0,
            "glassIndexAtDesignLambda": 1.4506,
            "slowAxisDegInBodyFrame": 0.0,
        },
        "endB": {
            "apertureDiameterMm": 0.125,
            "numericalAperture": 0.13,
            "modeFieldDiameterUm": 5.3,
            "coreDiameterUm": 4.4,
            "claddingDiameterUm": 125.0,
            "connectorType": "FC",
            "polish": "PC",
            "polishAngleDeg": 0.0,
            "fresnelResidual": 1.0,
            "glassIndexAtDesignLambda": 1.4506,
            "slowAxisDegInBodyFrame": 0.0,
        },
        "cutoffWavelengthNm": 730.0,
        "wavelengthRangeNm": [770.0, 790.0],
        "designWavelengthNm": 780.0,
        "maxInputPowerMw": 500.0,
        "attenuationCurve": [
            {"wavelengthNm": 780.0, "dbPerKm": 5.0},
        ],
        "bendLoss": {
            "vNumber": 2.0,
            "coreRadiusUm": 2.2,
            "nCore": 1.4506,
            "nClad": 1.4500,
            "criticalRadiusMm": 25.0,
        },
        "minBendRadiusMm": 25.0,
        "birefringenceDeltaN": 5.0e-4,
        "pmdCoefficientPsPerSqrtKm": 0.05,
        "polarizationExtinctionRatioDb": 25.0,
        "bandwidthMhzKm": None,
        "randomJonesSeed": None,
        # Phase fiber-split — populated by the alembic backfill that
        # creates paired fiber_end SceneObjects from the existing
        # fiberNodes[0] / [N-1]. Null on freshly-spawned fibers until the
        # auto-create hook also spawns the two ends (Phase B work).
        "endAObjectId": None,
        "endBObjectId": None,
    },
    # Phase fiber-split — per-end ferrule SceneObject for a fiber. Two
    # of these (end A / end B) pair with a single hidden `fiber` body
    # wrapper. connectorType / polish / slowAxis live here so each end
    # is independently editable; the back-pointer to the paired body
    # arrives during paired-create.
    "fiber_end": {
        "connectorType": None,
        "polish": None,
        "slowAxisDegInBodyFrame": None,
        "fiberBodyObjectId": None,
        "endRole": "A",
    },
    # V2 Phase 8 (alembic 0034): transmission axis moved to a
    # polarizationReference binding (role="transmission").
    "isolator": {"forwardLossDb": 0.5, "isolationDb": 40.0, "faradayRotationDeg": 45.0},
    "aom": {
        # Legacy / coarse params (kept; topology solver uses them).
        # Phase B: centerFreqMhz / rfDrivePowerW are NOT seeded here. They
        # are resolved at solve time from the upstream rf_source channel
        # via the AOM's rf_in rfCableEndpoints link (hydrate_aom_rf_drive
        # in optics_seq.py). Orphan AOMs see 80 MHz / undefined P_d
        # defaults; the closed-form efficiency falls back to
        # baseEfficiency until a cable is wired up.
        "baseEfficiency": 0.85,
        "deflectionPerMhzUrad": 200.0,
        "acousticVelocityMPerS": 4200.0,
        "modulationBandwidthMhz": 20.0,
        # Bragg-diffraction physics fields used by the ray-tracer:
        #   sin θ_B = λ·f / (2·n·v)
        #   I₁/I₀  = sin²(π·L/(2λ·cosθ_B)·√(2·M₂·P_d/W))
        # Defaults match a TeO₂ Bragg cell similar to AA-Optoelectronic
        # MT80 (80 MHz, slow-shear ~4200 m/s).
        "refractiveIndex": 2.26,
        "figureOfMeritM2": 34e-15,        # m²/W (TeO₂)
        "crystalLengthMm": 25.0,          # L
        "acousticBeamWidthMm": 1.5,       # W
        "rfPowerMaxW": 2.0,
        # V2 Phase 7 (alembic 0033): RF / acoustic direction moved to
        # objects.properties.anchorBindings[rfDirection]. Bootstrap default
        # is [-1, 0, 0] (MT80 convention).
        "braggAngularAcceptanceMrad": 2.0,
        # User-selected output order. +1 / −1 rotate the diffracted ray
        # by ±2·θ_B and carry η of the incident power; 0 means "RF off"
        # → all power stays on the transmitted (zeroth) path. The
        # ray-tracer reads this directly; the optical solver clamps to
        # {-1, 0, +1}. Default +1 matches AAOpto datasheet convention.
        "diffractionOrder": 1,
        # Spawn rays for orders -N .. +N (in the visualization). 0 and
        # the selected ±1 use the Bragg model; |n| ≥ 2 use a Bessel
        # J_n²(v) Raman-Nath approximation. For deep-Bragg cells like
        # the MT80 (Q ≈ 86), higher orders are physically <0.1 % so
        # the threshold below auto-hides them.
        "maxDiffractionOrder": 3,
        "sidebandVisibilityThreshold": 0.01,
        # Continuous angle (deg) selecting the Bragg-tilt axis in the
        # scene Y-Z plane. r=0° → tilt around scene+Z (horizontal fan
        # in XY), r=90° → tilt around scene+Y (vertical fan in XZ).
        # Default 90° matches the previous "ry" preset.
        "braggTiltAxisDegLab": 90.0,
    },
    "eom": {
        "vPiV": 3.0,
        "modulationKind": "phase",
        "modulationBandwidthMhz": 100.0,
        "insertionLossDb": 3.0,
    },
    "nonlinear_crystal": {
        "process": "SHG",
        "chi2PmPerV": 10.0,
        "lengthMm": 5.0,
    },
    "saturable_absorber": {
        "saturationIntensityWPerCm2": 1000.0,
        "modulationDepth": 0.5,
        "nonSaturableLoss": 0.05,
        "recoveryTimePs": 500.0,
    },
    "detector": {
        "responsivityAPerW": 0.5,
        "quantumEfficiency": 0.8,
        "bandwidthMhz": 100.0,
        "saturationPowerMw": 10.0,
    },
    "camera": {
        "resolutionPx": [1024, 1024],
        "pixelSizeUm": 5.0,
        "quantumEfficiency": 0.5,
        "wellDepthE": 20000,
    },
    "spectrometer": {"resolutionPm": 100.0, "wavelengthRangeNm": [400.0, 1100.0]},
    "wavemeter": {"precisionMhz": 1.0},
    "beam_dump": {"absorption": 0.999},
    # RF emitter (DDS / synthesizer). 80 MHz default lands inside the
    # AD9959 0..200 MHz range and matches the existing rf_source default
    # in the frontend `opticalDefaults.ts` table.
    "rf_source": {
        "frequencyMhz": 80.0,
        "powerDbm": 0.0,
        "phaseDeg": 0.0,
        "modulation": "none",
    },
    # Phase RF.amp: coaxial RF amplifier defaults sized for a
    # Mini-Circuits ZHL-1-2W+ (5..500 MHz, +29 dB min gain, +30 dBm
    # rated output, +24 V supply). Per-model overrides land in
    # component.properties for now; the kind solver only consumes
    # gain / freq range / P_1dB / NF.
    "rf_amplifier": {
        "gainDb": 29.0,
        "frequencyRangeMhz": [5.0, 500.0],
        "outputPowerP1dbDbm": 29.0,
        "outputPowerMaxDbm": 30.0,
        "inputPowerMaxDbm": 0.0,
        "noiseFigureDb": 9.0,
        "supplyVoltageV": 24.0,
        "supplyCurrentA": 0.6,
        "inputReturnLossDb": 14.0,
        "outputReturnLossDb": 14.0,
        "connectorType": "sma",
    },
    # Phase RF.cable: coaxial RF cable defaults match Thorlabs CA2906
    # (RG-316 SMA-M-SMA-M, 50 Ω, DC..3 GHz) — the most common short
    # patch cable in the lab catalog. Per-instance length/impedance/etc.
    # carry over from `component.properties` via the mapping block in
    # `default_kind_params_for_component`.
    "rf_cable": {
        "lengthMm": 152.0,
        "impedanceOhm": 50.0,
        "maxFrequencyGhz": 3.0,
        "connectorType": "sma",
        "cableType": "RG-316",
        "jacketOuterDiameterMm": 3.2,
        "jacketColor": "#a93226",
        "minBendRadiusMm": 15.0,
    },
    # Phase RF.switch: defaults match Mini-Circuits ZYSWA-2-50DR
    # (SP2T absorptive, DC..5 GHz, ±5 V supply, TTL control, ~25 mA).
    # Per-template overrides (other model, different bands) ship via
    # `component.properties.rfSwitchKindParamsOverride` in the seed.
    "rf_switch": {
        "switchType": "SP2T",
        "throwCount": 2,
        "frequencyMinGhz": 0.0,
        "frequencyMaxGhz": 5.0,
        "insertionLossDb": 1.0,
        "isolationDb": 35.0,
        "switchingTimeNs": 250.0,
        "absorptionType": "absorptive",
        "controlLogic": "TTL",
        "controlVoltageHighV": 5.0,
        "supplyPositiveV": 5.0,
        "supplyNegativeV": -5.0,
        "supplyCurrentMa": 25.0,
        "maxInputPowerDbm": 27.0,
        "connectorType": "sma",
        "manufacturer": "Mini-Circuits",
        "model": "ZYSWA-2-50DR",
        "datasheetUrl": "https://www.minicircuits.com/pdfs/ZYSWA-2-50DR+.pdf",
    },
    "programmable_pulse_generator": {
        "connectorType": "sma",
        "timingProgramId": None,
        "outputDomain": "ttl",
        "highVoltageV": 3.2,
    },
}


def _looks_like_pbs_component(component: Component) -> bool:
    haystack = " ".join(
        str(value or "")
        for value in (
            component.name,
            component.model,
            component.notes,
            component.properties.get("sourceUrl") if component.properties else "",
            component.properties.get("sourceStep") if component.properties else "",
        )
    ).lower()
    return (
        "pbs" in haystack
        or "polarizing beamsplitter" in haystack
        or "polarizing beam splitter" in haystack
    )


def _deep_merge_dict(base: dict, override: dict) -> dict:
    """In-place deep merge of `override` into `base`. Lists are replaced
    wholesale (not merged element-wise) since they're typically
    homogeneous like attenuation curves. Returns `base`."""
    for key, value in override.items():
        if (
            isinstance(value, dict)
            and isinstance(base.get(key), dict)
        ):
            _deep_merge_dict(base[key], value)
        else:
            base[key] = value
    return base


def default_kind_params_for_component(kind: str, component: Component) -> dict[str, object]:
    kind_params = copy.deepcopy(DEFAULT_KIND_PARAMS.get(kind, {}))
    if kind == "fiber":
        # Per-template kindParams override: catalog Components can carry
        # `properties.fiberKindParamsOverride` to specialise the default
        # 780 nm PM spec for their own fiber type / wavelength / NA / MFD.
        props = component.properties or {}
        override = props.get("fiberKindParamsOverride")
        if isinstance(override, dict):
            _deep_merge_dict(kind_params, override)
    if kind == "isolator":
        # Per-template kindParams override: catalog isolators carry
        # `properties.isolatorKindParamsOverride` with the spec-derived
        # `forwardLossDb` and `isolationDb`. See seed.py:_build_isolator_meta
        # for the Thorlabs spec → kindParams derivation.
        props = component.properties or {}
        override = props.get("isolatorKindParamsOverride")
        if isinstance(override, dict):
            _deep_merge_dict(kind_params, override)
    if kind == "beam_splitter" and _looks_like_pbs_component(component):
        kind_params.update(
            {
                "polarizing": True,
                "transmissionAxisDegBeamLocal": 0.0,
                "extinctionRatioDb": 30.0,
            }
        )
    if kind == "aom":
        props = component.properties or {}
        mapped_fields = {
            # Phase B: centerFrequencyMhz no longer mapped — the AOM's
            # operating frequency is resolved live from the upstream
            # rf_source CH at solve time (see hydrate_aom_rf_drive).
            "diffractionEfficiencyTypical": "baseEfficiency",
            "acousticVelocityMPerS": "acousticVelocityMPerS",
            "modulationBandwidthMhz": "modulationBandwidthMhz",
            "refractiveIndex": "refractiveIndex",
            "figureOfMeritM2": "figureOfMeritM2",
            "crystalLengthMm": "crystalLengthMm",
            "acousticBeamWidthMm": "acousticBeamWidthMm",
            "rfPowerMaxW": "rfPowerMaxW",
            "braggAngularAcceptanceMrad": "braggAngularAcceptanceMrad",
            "diffractionOrder": "diffractionOrder",
        }
        for prop_key, param_key in mapped_fields.items():
            value = props.get(prop_key)
            if isinstance(value, (int, float)):
                kind_params[param_key] = value
        # Phase 5 unification: AOM vector params now stored as
        # *BodyLocal-suffixed keys. The component.properties metadata
        # may still carry the legacy names from older assets — accept
        # both on read so vendor imports authored before the rename
        # still propagate their tuned acoustic / RF directions.
        for legacy_key, new_key in (
            ("acousticAxisBodyLocal", "acousticAxisBodyLocal"),
            ("acousticAxisLocal", "acousticAxisBodyLocal"),
            ("rfPropagationDirectionBodyLocal", "rfPropagationDirectionBodyLocal"),
            ("rfPropagationDirectionLocal", "rfPropagationDirectionBodyLocal"),
        ):
            value = props.get(legacy_key)
            if (
                isinstance(value, list)
                and len(value) >= 3
                and all(isinstance(item, (int, float)) for item in value[:3])
            ):
                kind_params[new_key] = [float(item) for item in value[:3]]
    if kind == "rf_cable":
        # Phase RF.cable: catalog cables (Thorlabs CA29xx, QMEM jumpers) carry
        # their physical spec on `component.properties`. Map those scalars
        # into kindParams so the auto-registered PhysicsElement reflects the
        # specific cable's length / impedance / frequency rating instead of
        # the generic CA2906 fallback in DEFAULT_KIND_PARAMS.
        props = component.properties or {}
        mapped_scalars = {
            "lengthMm": "lengthMm",
            "impedanceOhm": "impedanceOhm",
            "maxFrequencyGhz": "maxFrequencyGhz",
            "jacketOuterDiameterMm": "jacketOuterDiameterMm",
            "minBendRadiusMm": "minBendRadiusMm",
            "workingVoltageVRms": "workingVoltageVRms",
            "dielectricVoltageVRms": "dielectricVoltageVRms",
        }
        for prop_key, param_key in mapped_scalars.items():
            value = props.get(prop_key)
            if isinstance(value, (int, float)):
                kind_params[param_key] = float(value)
        for prop_key, param_key in (
            ("connectorType", "connectorType"),
            ("cableType", "cableType"),
            ("jacketColor", "jacketColor"),
        ):
            value = props.get(prop_key)
            if isinstance(value, str) and value:
                kind_params[param_key] = value
    if kind == "programmable_pulse_generator":
        props = component.properties or {}
        connector = props.get("connectorType")
        if connector in ("sma", "bnc"):
            kind_params["connectorType"] = connector
    return kind_params


def _body_to_lab_xyz(
    p: tuple[float, float, float],
    x: float, y: float, z: float,
    rx_deg: float, ry_deg: float, rz_deg: float,
) -> tuple[float, float, float]:
    """Body-local → lab transform, Euler XYZ. Mirrors the math in
    `frontend/src/store/sceneStore.ts` (`createRfCableBetweenPorts`'s
    `apply()` helper) and `alembic 0052_fiber_split_to_paired_ends`
    (`_body_to_lab`). Kept inline here so this router doesn't pull in
    numpy / scipy for a one-off transform."""
    import math
    rx, ry, rz = math.radians(rx_deg or 0.0), math.radians(ry_deg or 0.0), math.radians(rz_deg or 0.0)
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    px, py, pz = p
    x1 = cy * px + sy * pz
    y1 = py
    z1 = -sy * px + cy * pz
    y2 = cx * y1 - sx * z1
    z2 = sx * y1 + cx * z1
    return (
        (x or 0.0) + cz * x1 - sz * y2,
        (y or 0.0) + sz * x1 + cz * y2,
        (z or 0.0) + z2,
    )


_FIBER_END_TIP_PORT = {
    "portId": "tip",
    "role": "bidirectional",
    "label": "Ferrule tip",
    "kind": "main",
}


async def _spawn_fiber_end_pair_for_body(
    session: AsyncSession,
    fiber_body: SceneObject,
    fiber_body_pe: PhysicsElement,
    fiber_component: Component,
) -> None:
    """When a new fiber body SceneObject is created via the catalog, also
    spawn two paired `fiber_end` SceneObjects (referenced via
    FiberParams.endAObjectId / endBObjectId on the body PE). Mirrors
    alembic 0052 but for fresh-spawn instead of backfill. Idempotent
    against the body PE already having end refs (early return)."""
    existing_kp = fiber_body_pe.kind_params or {}
    if existing_kp.get("endAObjectId") or existing_kp.get("endBObjectId"):
        return

    # Resolve the fiber_end_generic catalog Component — usually created
    # by migration 0052, but if it's been archived or deleted (or never
    # ran, e.g. half-migrated DB) we create one inline so fiber spawn
    # never silently no-ops. Archived rows get un-archived rather than
    # creating a duplicate so historical SceneObject references stay
    # resolvable.
    fiber_end_comp = await session.scalar(
        select(Component).where(Component.name == "fiber_end_generic")
    )
    if fiber_end_comp is None:
        fiber_end_comp = Component(
            id=uuid.uuid4(),
            name="fiber_end_generic",
            component_type="fiber_end",
            brand="Generic",
            model="Fiber End (procedural ferrule)",
            asset_3d_id=None,
            physics_capabilities=["optical"],
            properties={},
        )
        session.add(fiber_end_comp)
        await session.flush()
    elif fiber_end_comp.archived_at is not None:
        fiber_end_comp.archived_at = None
        await session.flush()

    # First / last spline node in body-local frame: prefer per-instance
    # fiberNodes from the body's properties (rare on fresh spawn), fall
    # back to the catalog template's fiberNodes.
    obj_props = fiber_body.properties or {}
    comp_props = fiber_component.properties or {}
    fiber_nodes = obj_props.get("fiberNodes") if isinstance(obj_props, dict) else None
    if not isinstance(fiber_nodes, list) or len(fiber_nodes) < 2:
        fiber_nodes = comp_props.get("fiberNodes") if isinstance(comp_props, dict) else None
    if not isinstance(fiber_nodes, list) or len(fiber_nodes) < 2:
        # Final fallback — matches the default in
        # `createFiberSplineObject` in loadAsset.ts so a brand-new fiber
        # with no nodes still gets a sensible ferrule placement.
        fiber_nodes = [
            {"posMm": [0.0, 0.0, 50.0]},
            {"posMm": [300.0, 0.0, 50.0]},
        ]

    first = fiber_nodes[0]
    last = fiber_nodes[-1]
    first_pos = first.get("posMm") if isinstance(first, dict) else None
    last_pos = last.get("posMm") if isinstance(last, dict) else None
    if not (isinstance(first_pos, list) and isinstance(last_pos, list)):
        return

    end_a_lab = _body_to_lab_xyz(
        (float(first_pos[0]), float(first_pos[1]), float(first_pos[2])),
        float(fiber_body.x_mm or 0.0),
        float(fiber_body.y_mm or 0.0),
        float(fiber_body.z_mm or 0.0),
        float(fiber_body.rx_deg or 0.0),
        float(fiber_body.ry_deg or 0.0),
        float(fiber_body.rz_deg or 0.0),
    )
    end_b_lab = _body_to_lab_xyz(
        (float(last_pos[0]), float(last_pos[1]), float(last_pos[2])),
        float(fiber_body.x_mm or 0.0),
        float(fiber_body.y_mm or 0.0),
        float(fiber_body.z_mm or 0.0),
        float(fiber_body.rx_deg or 0.0),
        float(fiber_body.ry_deg or 0.0),
        float(fiber_body.rz_deg or 0.0),
    )

    # Find the collection the fiber body just joined — caller already
    # added the membership before invoking auto_create. Default to
    # master if (somehow) no membership exists yet.
    collection_id = await session.scalar(
        select(CollectionMember.collection_id).where(
            CollectionMember.object_id == fiber_body.id
        )
    )
    if collection_id is None:
        master = await session.scalar(
            select(Collection).where(Collection.parent_id.is_(None)).order_by(Collection.created_at.asc()).limit(1)
        )
        if master is None:
            return
        collection_id = master.id

    end_ids: dict[str, uuid.UUID] = {}
    for end_role, end_lab, suffix in (
        ("A", end_a_lab, "_end_a"),
        ("B", end_b_lab, "_end_b"),
    ):
        end_obj = SceneObject(
            id=uuid.uuid4(),
            name=f"{fiber_body.name}{suffix}",
            component_id=fiber_end_comp.id,
            x_mm=end_lab[0],
            y_mm=end_lab[1],
            z_mm=end_lab[2],
            rx_deg=0.0,
            ry_deg=0.0,
            rz_deg=0.0,
            visible=True,
            locked=False,
            # 7-part fiber model (2026-05-17): tensionHandleMm carries
            # nodeA/nodeB tension in fiber_end body-local frame, pointing
            # OUTWARD (= where the wire leaves the ferrule). The body
            # spline endpoint's Bezier handle = -tensionHandleMm in fiber-
            # body frame (resolveLinkedFiberEndpoint). Seed at
            # (0, +30, 0) so the initial curve direction matches the
            # legacy auto-derived behaviour (ferrule +Y × 30 mm). User
            # drags the handle in node-edit mode to retune.
            properties={"tensionHandleMm": [0.0, 30.0, 0.0]},
        )
        session.add(end_obj)
        await session.flush()

        end_pe = PhysicsElement(
            object_id=end_obj.id,
            element_kind="fiber_end",
            wavelength_range_nm=[400.0, 1100.0],
            input_ports=[_FIBER_END_TIP_PORT],
            output_ports=[],
            kind_params={
                "connectorType": None,
                "polish": None,
                "slowAxisDegInBodyFrame": None,
                "fiberBodyObjectId": str(fiber_body.id),
                "endRole": end_role,
            },
        )
        session.add(end_pe)

        session.add(
            CollectionMember(collection_id=collection_id, object_id=end_obj.id, sort_order=0)
        )
        end_ids[end_role] = end_obj.id

    # Wire the body PE back-references.
    next_kp = dict(existing_kp)
    next_kp["endAObjectId"] = str(end_ids["A"])
    next_kp["endBObjectId"] = str(end_ids["B"])
    fiber_body_pe.kind_params = next_kp
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(fiber_body_pe, "kind_params")


async def auto_create_physics_element_for_object(
    session: AsyncSession, scene_object: SceneObject, component: Component
) -> PhysicsElement | None:
    """If `component.component_type` maps to a known optical kind AND no
    PhysicsElement exists for this OBJECT yet, create one with default
    ports + kind_params keyed by `scene_object.id`.

    Returns the new row, or None if nothing was created. Optical
    participation is per-OBJECT (alembic 0014) so this is called per
    scene-object insert, not per component insert.
    """
    kind = OPTICAL_COMPONENT_TYPE_TO_KIND.get((component.component_type or "").strip())
    if kind is None:
        return None
    stmt = select(PhysicsElement).where(PhysicsElement.object_id == scene_object.id)
    existing = (await session.scalars(stmt)).one_or_none()
    if existing is not None:
        return None

    default_ports = schemas.DEFAULT_PORTS.get(kind, {})
    # V2 Phase 3 (alembic 0029): laser_source kindParams is intentionally `{}`
    # post-cutover — beam-defining fields moved to opticalSources[]. The
    # empty-dict guard that previously skipped element creation has been
    # dropped; a missing entry in DEFAULT_KIND_PARAMS still skips, but {}
    # is now a valid payload for V2-cutover kinds.
    kind_params = default_kind_params_for_component(kind, component)
    if kind not in DEFAULT_KIND_PARAMS:
        return None

    physics_element = PhysicsElement(
        object_id=scene_object.id,
        element_kind=kind,
        wavelength_range_nm=[400.0, 1100.0],
        input_ports=list(default_ports.get("input", []) or []),
        output_ports=list(default_ports.get("output", []) or []),
        kind_params=kind_params,
    )
    session.add(physics_element)

    # V2 Phase 2 (alembic 0028): mirror per-instance reflective normal moved
    # to objects.properties.anchorBindings[opticalSurface]. For
    # newly-spawned mirrors, attach the default binding so a fresh scene
    # behaves the same as a backfilled one.
    if kind in ("mirror", "dichroic_mirror") and component.asset_3d_id is not None:
        asset = await session.get(Asset3D, component.asset_3d_id)
        await bootstrap_mirror_default_binding(scene_object, component, asset)

    # V2 Phase 3 (alembic 0029): laser_source per-instance beam parameters
    # live on objects.properties.opticalSources[]. Bootstrap a default
    # emissionReference binding + opticalSource for newly-spawned lasers.
    if kind == "laser_source" and component.asset_3d_id is not None:
        asset = await session.get(Asset3D, component.asset_3d_id)
        await bootstrap_laser_default_binding_and_source(scene_object, component, asset)

    # V2 Phase 4 (alembic 0030): waveplate / polarizer axis angles live on
    # objects.properties.anchorBindings[polarizationReference]. Default
    # angle = 0 deg (pass-through orientation); user adjusts via the
    # WaveplateAdjustControls panel post-bootstrap.
    if kind == "waveplate" and component.asset_3d_id is not None:
        asset = await session.get(Asset3D, component.asset_3d_id)
        await bootstrap_polarization_axis_binding(
            scene_object, asset, role="fast", name="Fast axis",
        )
    if kind == "polarizer" and component.asset_3d_id is not None:
        asset = await session.get(Asset3D, component.asset_3d_id)
        await bootstrap_polarization_axis_binding(
            scene_object, asset, role="transmission", name="Transmission axis",
        )

    # V2 Phase 6 (alembic 0032): beam_splitter coating normal + PBS axis
    # live on anchor bindings. Default coating normal = [√½, √½, 0]
    # (reflects +X-propagating beam to +Y); polarising bit defaults False.
    if kind == "beam_splitter" and component.asset_3d_id is not None:
        asset = await session.get(Asset3D, component.asset_3d_id)
        polarizing = bool((kind_params or {}).get("polarizing", False))
        await bootstrap_beam_splitter_default_bindings(
            scene_object, asset, polarizing=polarizing,
        )

    # V2 Phase 7 (alembic 0033): AOM RF / acoustic propagation direction
    # lives on objects.properties.anchorBindings[rfDirection]. Default
    # = [-1, 0, 0] (MT80 convention: body -X is transducer → absorber).
    if kind == "aom" and component.asset_3d_id is not None:
        asset = await session.get(Asset3D, component.asset_3d_id)
        await bootstrap_aom_default_binding(scene_object, asset)

    # V2 Phase 8 (alembic 0034): isolator transmission axis binding.
    if kind == "isolator" and component.asset_3d_id is not None:
        asset = await session.get(Asset3D, component.asset_3d_id)
        await bootstrap_isolator_default_binding(scene_object, asset)

    # Phase fiber-split: spawn two paired `fiber_end` SceneObjects + PEs
    # so a freshly-placed fiber comes up with the same 3-object
    # structure as a migrated one (body + end_a + end_b). The body's
    # endA/BObjectId fields wire the back-references; the resolver in
    # `frontend/src/utils/fiberBodyEndpointResolver.ts` then derives
    # spline endpoints from the ends' lab poses going forward.
    if kind == "fiber":
        await _spawn_fiber_end_pair_for_body(
            session, scene_object, physics_element, component
        )

    return physics_element


def physics_element_payload(element: PhysicsElement) -> dict[str, object]:
    return schemas.OpticalElementOut.model_validate(element).model_dump(
        mode="json", by_alias=True
    )


@router.get("", response_model=list[schemas.ComponentOut])
async def list_components(
    session: AsyncSession = Depends(get_session),
    include_archived: bool = False,
) -> list[Component]:
    stmt = select(Component)
    if not include_archived:
        stmt = stmt.where(Component.archived_at.is_(None))
    return list((await session.scalars(stmt)).all())


@router.post("", response_model=schemas.ComponentOut, status_code=status.HTTP_201_CREATED)
async def create_component(
    payload: schemas.ComponentCreate, session: AsyncSession = Depends(get_session)
) -> Component:
    values = payload.model_dump()
    requested_name = values.get("name")
    if requested_name and requested_name.strip():
        values["name"] = await require_unique_component_name(session, requested_name)
    else:
        values["name"] = await next_component_name(
            session, values.get("model"), values["component_type"]
        )
    component = Component(**values)
    session.add(component)
    await session.commit()
    await session.refresh(component)
    await manager.broadcast("component.created", component_payload(component))
    # Components no longer auto-create OpticalElements (per-component → per-object
    # refactor in alembic 0014). The PhysicsElement is created when a SceneObject
    # of this component is added to the scene.
    return component


@router.get("/{component_id}", response_model=schemas.ComponentOut)
async def get_component(
    component_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Component:
    return await crud.get_or_404(session, Component, component_id)


@router.put("/{component_id}", response_model=schemas.ComponentOut)
async def update_component(
    component_id: uuid.UUID,
    payload: schemas.ComponentUpdate,
    session: AsyncSession = Depends(get_session),
) -> Component:
    component = await crud.get_or_404(session, Component, component_id)
    updates = payload.model_dump(exclude_unset=True)
    if "name" in updates:
        updates["name"] = await require_unique_component_name(
            session,
            updates["name"] if isinstance(updates["name"], str) else None,
            component.id,
        )
    crud.apply_updates(component, updates)
    await session.commit()
    await session.refresh(component)
    await manager.broadcast("component.updated", component_payload(component))
    return component


@router.post(
    "/{component_id}/auto-register-optical",
    response_model=list[schemas.OpticalElementOut],
)
async def auto_register_optical(
    component_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> list[PhysicsElement]:
    """For each SceneObject of this component, create an PhysicsElement
    if one doesn't exist yet. Returns the list of newly-created rows
    (empty if all objects already had OpticalElements or the component
    type isn't a known optical kind).
    """
    component = await crud.get_or_404(session, Component, component_id)
    stmt = select(SceneObject).where(SceneObject.component_id == component_id)
    objs = list((await session.scalars(stmt)).all())
    created: list[PhysicsElement] = []
    for obj in objs:
        oe = await auto_create_physics_element_for_object(session, obj, component)
        if oe is not None:
            created.append(oe)
    if not created:
        return []
    await session.commit()
    for oe in created:
        await session.refresh(oe)
        await manager.broadcast("physics_element.updated", physics_element_payload(oe))
    return created


@router.post("/auto-register-optical/all")
async def auto_register_optical_all(
    session: AsyncSession = Depends(get_session),
) -> dict[str, object]:
    """Sweep every SceneObject and create missing PhysicsElement rows
    for those whose Component maps to a known optical kind. Idempotent.
    """
    stmt = (
        select(SceneObject, Component)
        .join(Component, Component.id == SceneObject.component_id)
        .where(Component.archived_at.is_(None))
    )
    pairs = list((await session.execute(stmt)).all())
    created: list[PhysicsElement] = []
    for obj, comp in pairs:
        oe = await auto_create_physics_element_for_object(session, obj, comp)
        if oe is not None:
            created.append(oe)
    if not created:
        return {"createdCount": 0, "scanned": len(pairs), "elements": []}
    await session.commit()
    payloads: list[dict[str, object]] = []
    for element in created:
        await session.refresh(element)
        payload = physics_element_payload(element)
        payloads.append(payload)
        await manager.broadcast("physics_element.updated", payload)
    return {
        "createdCount": len(created),
        "scanned": len(pairs),
        "elements": payloads,
    }


@router.delete("/{component_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_component(
    component_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Response:
    component = await crud.get_or_404(session, Component, component_id)
    if is_component_locked(component):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Component is locked.")
    if component.archived_at is not None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # Drop BeamPath rows that reference any SceneObject of this component.
    # Endpoints are nullable with ON DELETE SET NULL, but a BeamPath whose
    # both endpoints reference this component is conceptually gone.
    object_id_subq = select(SceneObject.id).where(SceneObject.component_id == component_id)
    await session.execute(
        delete(BeamPath).where(
            or_(
                BeamPath.source_object_id.in_(object_id_subq),
                BeamPath.target_object_id.in_(object_id_subq),
            )
        )
    )
    # All other per-instance state (Connection, OpticalLink, PhysicsElement,
    # DeviceState, TimingProgram) is keyed by SceneObject id with ON DELETE
    # CASCADE, so deleting the SceneObjects below propagates everything.
    await session.execute(delete(SceneObject).where(SceneObject.component_id == component_id))

    component.archived_at = func.now()
    await session.commit()
    await manager.broadcast(
        "component.deleted",
        {"id": str(component_id), "componentId": str(component_id)},
    )
    await manager.broadcast("scene.reload", {})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{component_id}/restore", response_model=schemas.ComponentOut)
async def restore_component(
    component_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Component:
    component = await crud.get_or_404(session, Component, component_id)
    if component.archived_at is None:
        return component
    component.archived_at = None
    await session.commit()
    await session.refresh(component)
    await manager.broadcast("component.created", component_payload(component))
    await manager.broadcast("scene.reload", {})
    return component
