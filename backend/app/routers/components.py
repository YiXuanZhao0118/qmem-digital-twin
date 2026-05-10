from __future__ import annotations

import copy
import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.db import get_session
from app.models import (
    BeamPath,
    Component,
    OpticalElement,
    OpticalLink,
    SceneObject,
)
from app.websocket import manager


router = APIRouter()


def component_payload(component: Component) -> dict[str, object]:
    return schemas.ComponentOut.model_validate(component).model_dump(mode="json", by_alias=True)


def is_component_locked(component: Component) -> bool:
    return component.properties.get("locked") is True


# =============================================================================
# Optical-element auto-sync
# =============================================================================
#
# `Component.component_type` is just a tag (used by the catalog UI for
# grouping). The optical solver only sees `OpticalElement` rows. To stop
# users from "adding a mirror" and silently getting nothing in the simulator,
# every Component whose component_type maps to a known optical kind gets an
# OpticalElement auto-created with sensible defaults the moment it lands in
# the DB. Already-existing rows are backfilled on demand via
# POST /api/components/{id}/auto-register-optical.

OPTICAL_COMPONENT_TYPE_TO_KIND: dict[str, str] = {
    "laser": "laser_source",
    "laser_source": "laser_source",
    "tapered_amplifier": "tapered_amplifier",
    "mirror": "mirror",
    "lens": "lens_spherical",
    "lens_spherical": "lens_spherical",
    "lens_cylindrical": "lens_cylindrical",
    "waveplate": "waveplate",
    "polarizer": "polarizer",
    "beam_splitter": "beam_splitter",
    "dichroic_mirror": "dichroic_mirror",
    "fiber_coupler": "fiber_coupler",
    "fiber": "fiber",
    "isolator": "isolator",
    "aom": "aom",
    "eom": "eom",
    "nonlinear_crystal": "nonlinear_crystal",
    "saturable_absorber": "saturable_absorber",
    "detector": "detector",
    "camera": "camera",
    "spectrometer": "spectrometer",
    "wavemeter": "wavemeter",
    "beam_dump": "beam_dump",
}

# Minimum-viable kind_params for each kind so the auto-created OpticalElement
# passes validation. The user can edit through the OpticalElementPanel UI.
DEFAULT_KIND_PARAMS: dict[str, dict[str, object]] = {
    "laser_source": {
        "centerWavelengthNm": 780.241,
        "spectrum": {
            "centerThz": 384.227,
            "components": [
                {"kind": "main", "lineshape": "gaussian", "fwhmMhz": 1.0, "amplitude": 1.0}
            ],
        },
        "spatialModeX": {"waistUm": 500.0, "waistZOffsetMm": 0.0, "mSquared": 1.0},
        "spatialModeY": {"waistUm": 500.0, "waistZOffsetMm": 0.0, "mSquared": 1.0},
        "transverseMode": {"kind": "TEM00"},
        "polarization": {"exRe": 1.0, "exIm": 0.0, "eyRe": 0.0, "eyIm": 0.0},
        "nominalPowerMw": 1.0,
    },
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
        # ASE-only (no seed): backward facet leaks more than forward in most
        # tapered designs because the narrow input facet has a higher AR
        # coating reflectivity for ASE. Numbers are order-of-magnitude.
        "aseSamples": [
            {"driveCurrentMa": 0.0,    "forwardPowerMw": 0.0,   "backwardPowerMw": 0.0},
            {"driveCurrentMa": 1000.0, "forwardPowerMw": 5.0,   "backwardPowerMw": 25.0},
            {"driveCurrentMa": 2400.0, "forwardPowerMw": 80.0,  "backwardPowerMw": 200.0},
            {"driveCurrentMa": 5000.0, "forwardPowerMw": 250.0, "backwardPowerMw": 500.0},
        ],
        # With seed: forward saturates near rated output, backward drops as
        # the seed extracts the gain medium. Sample at 2400 mA (default
        # operating point) across the rated input range 5..40 mW.
        "gainSamples": [
            {"inputPowerMw": 0.0,  "driveCurrentMa": 2400.0, "forwardPowerMw": 80.0,   "backwardPowerMw": 200.0},
            {"inputPowerMw": 5.0,  "driveCurrentMa": 2400.0, "forwardPowerMw": 1200.0, "backwardPowerMw": 120.0},
            {"inputPowerMw": 10.0, "driveCurrentMa": 2400.0, "forwardPowerMw": 1800.0, "backwardPowerMw": 80.0},
            {"inputPowerMw": 20.0, "driveCurrentMa": 2400.0, "forwardPowerMw": 2500.0, "backwardPowerMw": 50.0},
            {"inputPowerMw": 40.0, "driveCurrentMa": 2400.0, "forwardPowerMw": 3000.0, "backwardPowerMw": 35.0},
        ],
        "backwardSpatialModeX": {"waistUm": 600.0, "waistZOffsetMm": 0.0, "mSquared": 1.5},
        "backwardSpatialModeY": {"waistUm": 600.0, "waistZOffsetMm": 0.0, "mSquared": 1.5},
    },
    "mirror": {"reflectivity": 0.99, "surfaceNormalBodyLocal": [1.0, 0.0, 0.0]},
    "lens_spherical": {"focalMm": 100.0, "transmission": 0.99},
    "lens_cylindrical": {"focalMm": 100.0, "cylindricalAxis": "x", "transmission": 0.99},
    "waveplate": {"retardanceLambda": 0.5, "fastAxisDegBeamLocal": 0.0, "transmission": 0.99},
    "polarizer": {"transmissionAxisDegBeamLocal": 0.0, "extinctionRatioDb": 30.0, "transmission": 0.95},
    "beam_splitter": {
        "splitRatioTransmitted": 0.5,
        "polarizing": False,
        "transmissionAxisDegBeamLocal": 0.0,
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
        "operatingWavelengthRangeNm": [770.0, 790.0],
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
    },
    "isolator": {"forwardLossDb": 0.5, "isolationDb": 40.0, "transmissionAxisDegBeamLocal": 0.0},
    "aom": {
        # Legacy / coarse params (kept; topology solver uses them).
        "baseEfficiency": 0.85,
        "deflectionPerMhzUrad": 200.0,
        "acousticVelocityMPerS": 4200.0,
        "modulationBandwidthMhz": 20.0,
        "centerFreqMhz": 80.0,
        # Bragg-diffraction physics fields used by the ray-tracer:
        #   sin θ_B = λ·f / (2·n·v)
        #   I₁/I₀  = sin²(π·L/(2λ·cosθ_B)·√(2·M₂·P_d/W))
        # Defaults match a TeO₂ Bragg cell similar to AA-Optoelectronic
        # MT80 (80 MHz, slow-shear ~4200 m/s).
        "refractiveIndex": 2.26,
        "figureOfMeritM2": 34e-15,        # m²/W (TeO₂)
        "crystalLengthMm": 25.0,          # L
        "acousticBeamWidthMm": 1.5,       # W
        "rfDrivePowerW": 1.0,             # P_d (live control)
        "rfPowerMaxW": 2.0,
        # Acoustic-wave direction in BODY local (scene axes). For the MT80
        # GLB convention used here, body +Y is the port-to-port optical axis,
        # body -X is transducer -> absorber, and body +/-Z is perpendicular
        # to the AOM outline drawing.
        "acousticAxisBodyLocal": [-1.0, 0.0, 0.0],
        "rfPropagationDirectionBodyLocal": [-1.0, 0.0, 0.0],
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
            "diffractionEfficiencyTypical": "baseEfficiency",
            "centerFrequencyMhz": "centerFreqMhz",
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
    return kind_params


async def auto_create_optical_element_for_object(
    session: AsyncSession, scene_object: SceneObject, component: Component
) -> OpticalElement | None:
    """If `component.component_type` maps to a known optical kind AND no
    OpticalElement exists for this OBJECT yet, create one with default
    ports + kind_params keyed by `scene_object.id`.

    Returns the new row, or None if nothing was created. Optical
    participation is per-OBJECT (alembic 0014) so this is called per
    scene-object insert, not per component insert.
    """
    kind = OPTICAL_COMPONENT_TYPE_TO_KIND.get((component.component_type or "").strip())
    if kind is None:
        return None
    stmt = select(OpticalElement).where(OpticalElement.object_id == scene_object.id)
    existing = (await session.scalars(stmt)).one_or_none()
    if existing is not None:
        return None

    default_ports = schemas.DEFAULT_PORTS.get(kind, {})
    kind_params = default_kind_params_for_component(kind, component)
    if not kind_params:
        # Better to skip silently than create a row that fails validation later.
        return None

    optical_element = OpticalElement(
        object_id=scene_object.id,
        element_kind=kind,
        wavelength_range_nm=[400.0, 1100.0],
        input_ports=list(default_ports.get("input", []) or []),
        output_ports=list(default_ports.get("output", []) or []),
        kind_params=kind_params,
    )
    session.add(optical_element)
    return optical_element


def optical_element_payload(element: OpticalElement) -> dict[str, object]:
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
    component = Component(**payload.model_dump())
    session.add(component)
    await session.commit()
    await session.refresh(component)
    await manager.broadcast("component.created", component_payload(component))
    # Components no longer auto-create OpticalElements (per-component → per-object
    # refactor in alembic 0014). The OpticalElement is created when a SceneObject
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
    crud.apply_updates(component, payload.model_dump(exclude_unset=True))
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
) -> list[OpticalElement]:
    """For each SceneObject of this component, create an OpticalElement
    if one doesn't exist yet. Returns the list of newly-created rows
    (empty if all objects already had OpticalElements or the component
    type isn't a known optical kind).
    """
    component = await crud.get_or_404(session, Component, component_id)
    stmt = select(SceneObject).where(SceneObject.component_id == component_id)
    objs = list((await session.scalars(stmt)).all())
    created: list[OpticalElement] = []
    for obj in objs:
        oe = await auto_create_optical_element_for_object(session, obj, component)
        if oe is not None:
            created.append(oe)
    if not created:
        return []
    await session.commit()
    for oe in created:
        await session.refresh(oe)
        await manager.broadcast("optical_element.updated", optical_element_payload(oe))
    return created


@router.post("/auto-register-optical/all")
async def auto_register_optical_all(
    session: AsyncSession = Depends(get_session),
) -> dict[str, object]:
    """Sweep every SceneObject and create missing OpticalElement rows
    for those whose Component maps to a known optical kind. Idempotent.
    """
    stmt = (
        select(SceneObject, Component)
        .join(Component, Component.id == SceneObject.component_id)
        .where(Component.archived_at.is_(None))
    )
    pairs = list((await session.execute(stmt)).all())
    created: list[OpticalElement] = []
    for obj, comp in pairs:
        oe = await auto_create_optical_element_for_object(session, obj, comp)
        if oe is not None:
            created.append(oe)
    if not created:
        return {"createdCount": 0, "scanned": len(pairs), "elements": []}
    await session.commit()
    payloads: list[dict[str, object]] = []
    for element in created:
        await session.refresh(element)
        payload = optical_element_payload(element)
        payloads.append(payload)
        await manager.broadcast("optical_element.updated", payload)
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
    # All other per-instance state (Connection, OpticalLink, OpticalElement,
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
