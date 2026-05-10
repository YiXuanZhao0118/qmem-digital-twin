"""Helpers for V2 anchor bindings on per-instance SceneObjects.

The V2 schema (docs/optical-schema-v2.md §3) puts per-instance geometry
data into ``objects.properties.anchorBindings[]`` instead of mixing it
with transfer physics in ``optical_elements.kind_params``.

This module:
1. Provides a stable rule for picking which asset anchor a given binding
   should reference (used by both the create-object flow and per-kind
   migrations).
2. Provides accessors that read a per-instance value out of a binding
   payload, defaulting through asset anchor → kind default → final
   fallback the same way the migration backfill did.

Per-kind cutovers (mirror is Phase 2; more follow) call into here so the
selection logic stays in one place.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm.attributes import flag_modified

from app.models import Asset3D, Component, SceneObject
from app.uuid7 import uuid7_str


OPTICAL_ANCHOR_ID = "optical_anchor"
OPTICAL_SURFACE_BINDING_KIND = "opticalSurface"
EMISSION_REFERENCE_BINDING_KIND = "emissionReference"
POLARIZATION_REFERENCE_BINDING_KIND = "polarizationReference"
RF_DIRECTION_BINDING_KIND = "rfDirection"

# V2 Phase 4: kindParams keys we strip on PUT for waveplate / polarizer.
# Mirrors V2_TRACKED_LASER_KEYS.
V2_TRACKED_WAVEPLATE_KEYS = ("fastAxisDegBeamLocal",)
V2_TRACKED_POLARIZER_KEYS = ("transmissionAxisDegBeamLocal",)

# V2 Phase 6: beam_splitter coating normal moves to opticalSurface; the PBS
# transmission axis moves to polarizationReference (only when polarizing).
V2_TRACKED_BEAM_SPLITTER_KEYS = ("coatingNormalBodyLocal", "transmissionAxisDegBeamLocal")

# V2 Phase 7: AOM RF / acoustic direction moves to a rfDirection binding.
# The duplicate `acousticAxisBodyLocal` legacy field is also stripped.
V2_TRACKED_AOM_KEYS = ("rfPropagationDirectionBodyLocal", "acousticAxisBodyLocal")

# V2 Phase 8: isolator transmission axis moves to polarizationReference
# (role="transmission") — same shape / role as the polarizer cutover.
V2_TRACKED_ISOLATOR_KEYS = ("transmissionAxisDegBeamLocal",)

# Legacy laser kindParams keys that V2 Phase 3 migrates into
# `objects.properties.opticalSources[].beam`. Solver / UI code must NOT read
# these from kind_params anymore — the translator below produces them on
# demand from the V2 source.
V2_TRACKED_LASER_KEYS = (
    "centerWavelengthNm",
    "nominalPowerMw",
    "spectrum",
    "spatialModeX",
    "spatialModeY",
    "transverseMode",
    "polarization",
)


def pick_optical_surface_anchor_id(asset_anchors: list[Any] | None) -> str | None:
    """Pick the anchor an opticalSurface binding should reference.

    Preference (matches the alembic 0028 migration so backfilled rows and
    newly-created rows bind to the same anchor for the same asset):

      1. ``optical_anchor`` (explicit, asset-importer authored)
      2. anchors hinting at an optical surface in id/name
         (``intercept_face`` / ``intercept_in`` / ``intercept_out`` / contains "optical")
      3. first anchor that has an id at all
      4. ``None`` — caller decides whether to skip the binding
    """
    if not asset_anchors:
        return None
    by_id = {a.get("id"): a for a in asset_anchors if isinstance(a, dict)}

    if OPTICAL_ANCHOR_ID in by_id:
        return OPTICAL_ANCHOR_ID

    for hint in ("intercept_face", "intercept_in", "intercept_out", "optical"):
        for a in asset_anchors:
            if not isinstance(a, dict):
                continue
            if a.get("id") == hint:
                return hint
            name = (a.get("name") or "").lower()
            if hint in name:
                return a.get("id")

    for a in asset_anchors:
        if isinstance(a, dict) and a.get("id"):
            return a["id"]
    return None


def make_optical_surface_binding(
    *,
    anchor_id: str,
    normal_body_local: list[float],
    name: str = "Reflective surface",
) -> dict[str, Any]:
    """Build one V2 ``opticalSurface`` binding entry."""
    return {
        "id": uuid7_str(),
        "name": name,
        "anchorId": anchor_id,
        "kind": OPTICAL_SURFACE_BINDING_KIND,
        "frame": "anchorLocalXY",
        "payload": {"normalBodyLocal": list(normal_body_local)},
    }


def append_binding(properties: dict[str, Any] | None, binding: dict[str, Any]) -> dict[str, Any]:
    """Add ``binding`` to the SceneObject ``properties.anchorBindings[]``,
    initialising the list if absent. Returns the (possibly new) properties
    dict so the caller can re-assign it onto the SceneObject."""
    out = dict(properties or {})
    existing = out.get("anchorBindings")
    if not isinstance(existing, list):
        existing = []
    existing.append(binding)
    out["anchorBindings"] = existing
    return out


def find_binding(
    scene_object: SceneObject | dict[str, Any] | None,
    *,
    kind: str,
) -> dict[str, Any] | None:
    """Return the first ``anchorBindings[]`` entry on ``scene_object``
    matching ``kind``, or ``None`` if absent. Accepts either a SQLAlchemy
    SceneObject row or a plain dict shaped like ``{"properties": {...}}``."""
    if scene_object is None:
        return None
    if isinstance(scene_object, dict):
        properties = scene_object.get("properties") or {}
    else:
        properties = scene_object.properties or {}
    bindings = properties.get("anchorBindings") or []
    for b in bindings:
        if isinstance(b, dict) and b.get("kind") == kind:
            return b
    return None


def get_mirror_normal_body_local(scene_object: SceneObject | dict[str, Any] | None) -> list[float] | None:
    """Read the V2 mirror reflective-surface normal off a SceneObject.

    Returns ``None`` if the object has no opticalSurface binding (caller
    falls back to asset anchor or the kind default ``[1, 0, 0]``)."""
    binding = find_binding(scene_object, kind=OPTICAL_SURFACE_BINDING_KIND)
    if binding is None:
        return None
    payload = binding.get("payload") or {}
    raw = payload.get("normalBodyLocal")
    if not isinstance(raw, list) or len(raw) < 3:
        return None
    try:
        return [float(raw[0]), float(raw[1]), float(raw[2])]
    except (TypeError, ValueError):
        return None


def get_optical_source(scene_object: SceneObject | dict[str, Any] | None) -> dict[str, Any] | None:
    """Return the first ``opticalSources[]`` entry on a SceneObject, or None."""
    if scene_object is None:
        return None
    if isinstance(scene_object, dict):
        properties = scene_object.get("properties") or {}
    else:
        properties = scene_object.properties or {}
    sources = properties.get("opticalSources") or []
    for s in sources:
        if isinstance(s, dict):
            return s
    return None


def legacy_laser_kind_params_from_beam(beam: dict[str, Any]) -> dict[str, Any]:
    """Translate a V2 ``opticalSources[].beam`` record into the legacy
    laser_source ``kindParams`` shape that ``optical_solver.emit_from_laser_source``
    and the rest of the solver still consume.

    V2 Phase 3 hard cutover: kind_params is empty in DB; this helper produces
    the same shape on demand from the per-instance V2 BeamSource. Solver and
    UI continue working with no internal refactor; only the data origin
    changes.
    """
    if not isinstance(beam, dict):
        return {}

    spectrum_v2 = beam.get("spectrum") or {}
    linewidth = spectrum_v2.get("linewidth") or {}
    components: list[dict[str, Any]] = []
    kind = (linewidth.get("kind") or "delta").lower()
    if kind == "voigt":
        components.append({
            "kind": "main",
            "lineshape": "voigt",
            "voigtGaussianFwhmMhz": float(linewidth.get("gaussianFwhmHz", 0.0)) / 1e6,
            "voigtLorentzianFwhmMhz": float(linewidth.get("lorentzianFwhmHz", 0.0)) / 1e6,
            "amplitude": 1.0,
            "offsetMhz": 0.0,
        })
    elif kind in ("gaussian", "lorentzian"):
        components.append({
            "kind": "main",
            "lineshape": kind,
            "fwhmMhz": float(linewidth.get("fwhmHz", 0.0)) / 1e6,
            "amplitude": 1.0,
            "offsetMhz": 0.0,
        })
    else:
        components.append({
            "kind": "main",
            "lineshape": "delta",
            "amplitude": 1.0,
            "offsetMhz": 0.0,
        })

    wavelength_nm = float(spectrum_v2.get("centerWavelengthNm", 780.241))
    center_thz = 299792.458 / wavelength_nm

    envelope = beam.get("spatialEnvelope") or {}
    profile = envelope.get("transverseProfile") or {}
    propagation = envelope.get("propagation") or {}

    def _legacy_axis(profile_axis: dict[str, Any] | None, prop_axis: dict[str, Any] | None) -> dict[str, Any]:
        profile_axis = profile_axis or {}
        prop_axis = prop_axis or {}
        return {
            "waistUm": float(profile_axis.get("waistRadiusUm", 500.0)),
            "waistZOffsetMm": float(prop_axis.get("waistZOffsetMm", 0.0)),
            "mSquared": float(prop_axis.get("mSquared", 1.0)),
        }

    spatial_x = _legacy_axis(profile.get("x"), propagation.get("x"))
    spatial_y = _legacy_axis(profile.get("y"), propagation.get("y"))

    tm = beam.get("transverseMode") or {}
    family = (tm.get("family") or "HG").upper()
    if family == "HG" and tm.get("m") == 0 and tm.get("n") == 0:
        legacy_tm: dict[str, Any] = {"kind": "TEM00"}
    elif family == "HG":
        legacy_tm = {
            "kind": "TEM_mn",
            "indicesM": int(tm.get("m", 0)),
            "indicesN": int(tm.get("n", 0)),
        }
    elif family == "LG":
        legacy_tm = {
            "kind": "LG_pl",
            "indicesP": int(tm.get("m", 0)),
            "indicesL": int(tm.get("n", 0)),
        }
    else:
        legacy_tm = {"kind": "multimode"}

    pol = (beam.get("polarization") or {}).get("jones") or {}

    return {
        "centerWavelengthNm": wavelength_nm,
        "nominalPowerMw": float(beam.get("powerMw", 1.0)),
        "spectrum": {"centerThz": center_thz, "components": components},
        "spatialModeX": spatial_x,
        "spatialModeY": spatial_y,
        "transverseMode": legacy_tm,
        "polarization": {
            "exRe": float(pol.get("exRe", 1.0)),
            "exIm": float(pol.get("exIm", 0.0)),
            "eyRe": float(pol.get("eyRe", 0.0)),
            "eyIm": float(pol.get("eyIm", 0.0)),
        },
    }


def beam_from_legacy_laser_kind_params(legacy: dict[str, Any]) -> dict[str, Any]:
    """Inverse of ``legacy_laser_kind_params_from_beam``.

    Used by the PUT /api/optical-elements path: when the (V1-style) frontend
    sends a kindParams payload with centerWavelengthNm / nominalPowerMw / ...,
    the backend translates it into a V2 BeamSource and writes that to the
    SceneObject's opticalSources[0].beam, then drops the legacy fields from
    kindParams via the schema validator.
    """
    if not isinstance(legacy, dict):
        return default_laser_beam()

    try:
        power_mw = float(legacy.get("nominalPowerMw", 1.0))
    except (TypeError, ValueError):
        power_mw = 1.0
    try:
        wavelength_nm = float(legacy.get("centerWavelengthNm", 780.241))
    except (TypeError, ValueError):
        wavelength_nm = 780.241

    spectrum_legacy = legacy.get("spectrum") or {}
    components = spectrum_legacy.get("components") or []
    linewidth: dict[str, Any] = {"kind": "delta"}
    if components:
        first = components[0] if isinstance(components[0], dict) else {}
        ls = (first.get("lineshape") or "delta").lower()
        if ls == "voigt":
            g = first.get("voigtGaussianFwhmMhz")
            l = first.get("voigtLorentzianFwhmMhz")
            if g is not None and l is not None:
                linewidth = {
                    "kind": "voigt",
                    "gaussianFwhmHz": float(g) * 1e6,
                    "lorentzianFwhmHz": float(l) * 1e6,
                }
        elif ls in ("gaussian", "lorentzian"):
            fwhm = first.get("fwhmMhz")
            if fwhm is not None:
                linewidth = {"kind": ls, "fwhmHz": float(fwhm) * 1e6}

    pol = legacy.get("polarization") or {}

    def _profile_axis(legacy_axis: dict[str, Any] | None) -> tuple[dict[str, Any], dict[str, Any]]:
        legacy_axis = legacy_axis or {}
        try:
            waist_um = float(legacy_axis.get("waistUm", 500.0))
        except (TypeError, ValueError):
            waist_um = 500.0
        try:
            offset_mm = float(legacy_axis.get("waistZOffsetMm", 0.0))
        except (TypeError, ValueError):
            offset_mm = 0.0
        try:
            m_sq = float(legacy_axis.get("mSquared", 1.0))
        except (TypeError, ValueError):
            m_sq = 1.0
        return ({"waistRadiusUm": waist_um}, {"waistZOffsetMm": offset_mm, "mSquared": m_sq})

    profile_x, prop_x = _profile_axis(legacy.get("spatialModeX"))
    profile_y, prop_y = _profile_axis(legacy.get("spatialModeY"))

    tm = legacy.get("transverseMode") or {"kind": "TEM00"}
    tm_kind = (tm.get("kind") or "TEM00").upper()
    if tm_kind == "TEM_MN":
        family, m, n = "HG", int(tm.get("indicesM", 0)), int(tm.get("indicesN", 0))
        label = f"HG{m}{n}"
    elif tm_kind == "LG_PL":
        family, m, n = "LG", int(tm.get("indicesP", 0)), int(tm.get("indicesL", 0))
        label = f"LG{m}{n}"
    elif tm_kind == "MULTIMODE":
        family, m, n, label = "measured", 0, 0, "multimode"
    else:
        family, m, n, label = "HG", 0, 0, "TEM00"

    return {
        "powerMw": power_mw,
        "spectrum": {
            "centerWavelengthNm": wavelength_nm,
            "wavelengthReference": "vacuum",
            "linewidth": linewidth,
        },
        "polarization": {
            "basis": "beamLocalXY",
            "normalization": "unit_jones",
            "jones": {
                "exRe": float(pol.get("exRe", 1.0)),
                "exIm": float(pol.get("exIm", 0.0)),
                "eyRe": float(pol.get("eyRe", 0.0)),
                "eyIm": float(pol.get("eyIm", 0.0)),
            },
        },
        "spatialEnvelope": {
            "transverseProfile": {
                "kind": "elliptical_gaussian",
                "x": profile_x,
                "y": profile_y,
                "hardAperture": None,
            },
            "propagation": {
                "model": "m2_gaussian",
                "x": prop_x,
                "y": prop_y,
            },
        },
        "transverseMode": {"family": family, "m": m, "n": n, "label": label},
    }


def default_laser_beam(wavelength_nm: float = 780.241, power_mw: float = 1.0) -> dict[str, Any]:
    """Build a fresh V2 BeamSource (camelCase) for newly-spawned laser
    SceneObjects. Mirror of the alembic 0029 backfill defaults so a fresh
    laser behaves the same as a backfilled one."""
    return {
        "powerMw": power_mw,
        "spectrum": {
            "centerWavelengthNm": wavelength_nm,
            "wavelengthReference": "vacuum",
            "linewidth": {"kind": "delta"},
        },
        "polarization": {
            "basis": "beamLocalXY",
            "normalization": "unit_jones",
            "jones": {"exRe": 1.0, "exIm": 0.0, "eyRe": 0.0, "eyIm": 0.0},
        },
        "spatialEnvelope": {
            "transverseProfile": {
                "kind": "elliptical_gaussian",
                "x": {"waistRadiusUm": 500.0},
                "y": {"waistRadiusUm": 500.0},
                "hardAperture": None,
            },
            "propagation": {
                "model": "m2_gaussian",
                "x": {"waistZOffsetMm": 0.0, "mSquared": 1.0},
                "y": {"waistZOffsetMm": 0.0, "mSquared": 1.0},
            },
        },
        "transverseMode": {"family": "HG", "m": 0, "n": 0, "label": "TEM00"},
    }


def _find_polarization_binding_by_role(
    scene_object: SceneObject | dict[str, Any] | None, role: str
) -> dict[str, Any] | None:
    if scene_object is None:
        return None
    if isinstance(scene_object, dict):
        properties = scene_object.get("properties") or {}
    else:
        properties = scene_object.properties or {}
    bindings = properties.get("anchorBindings") or []
    for b in bindings:
        if (
            isinstance(b, dict)
            and b.get("kind") == POLARIZATION_REFERENCE_BINDING_KIND
            and (b.get("payload") or {}).get("role") == role
        ):
            return b
    return None


def get_waveplate_axis_deg_beam_local(
    scene_object: SceneObject | dict[str, Any] | None,
) -> float | None:
    """V2 Phase 4 read of waveplate fast-axis angle from
    polarizationReference binding (role=fast)."""
    b = _find_polarization_binding_by_role(scene_object, "fast")
    if b is None:
        return None
    try:
        return float((b.get("payload") or {}).get("axisDegBeamLocal", 0.0))
    except (TypeError, ValueError):
        return None


def get_polarizer_axis_deg_beam_local(
    scene_object: SceneObject | dict[str, Any] | None,
) -> float | None:
    """V2 Phase 4 read of polarizer transmission-axis angle from
    polarizationReference binding (role=transmission)."""
    b = _find_polarization_binding_by_role(scene_object, "transmission")
    if b is None:
        return None
    try:
        return float((b.get("payload") or {}).get("axisDegBeamLocal", 0.0))
    except (TypeError, ValueError):
        return None


# V2 Phase 8: isolator reuses the same role="transmission" binding readers
# the polarizer uses, since the field semantics are identical.
get_isolator_axis_deg_beam_local = get_polarizer_axis_deg_beam_local


def legacy_isolator_kind_params_from_binding(
    scene_object: SceneObject | dict[str, Any] | None,
) -> dict[str, Any]:
    """Synthesise the legacy isolator transmissionAxisDegBeamLocal
    kindParams field from the V2 polarizationReference binding
    (role=transmission)."""
    angle = get_isolator_axis_deg_beam_local(scene_object)
    if angle is None:
        return {}
    return {"transmissionAxisDegBeamLocal": angle}


# V2 Phase 8 isolator writer is defined below after the polarizer writer
# (they share the same role="transmission" binding).


def legacy_waveplate_kind_params_from_binding(
    scene_object: SceneObject | dict[str, Any] | None,
) -> dict[str, Any]:
    """Synthesise the legacy waveplate kindParams field from the V2 binding."""
    angle = get_waveplate_axis_deg_beam_local(scene_object)
    if angle is None:
        return {}
    return {"fastAxisDegBeamLocal": angle}


def legacy_polarizer_kind_params_from_binding(
    scene_object: SceneObject | dict[str, Any] | None,
) -> dict[str, Any]:
    angle = get_polarizer_axis_deg_beam_local(scene_object)
    if angle is None:
        return {}
    return {"transmissionAxisDegBeamLocal": angle}


def _make_polarization_reference_binding(
    anchor_id: str, role: str, axis_deg: float, name: str
) -> dict[str, Any]:
    return {
        "id": uuid7_str(),
        "name": name,
        "anchorId": anchor_id,
        "kind": POLARIZATION_REFERENCE_BINDING_KIND,
        "frame": "anchorLocalXY",
        "payload": {"role": role, "axisDegBeamLocal": axis_deg},
    }


def _upsert_polarization_binding(
    scene_object: SceneObject, role: str, axis_deg: float, name: str
) -> None:
    """Overwrite the role-matching binding's axis if it exists, else append."""
    properties = dict(scene_object.properties or {})
    bindings = list(properties.get("anchorBindings") or [])
    new_bindings: list[Any] = []
    replaced = False
    for b in bindings:
        if (
            isinstance(b, dict)
            and b.get("kind") == POLARIZATION_REFERENCE_BINDING_KIND
            and (b.get("payload") or {}).get("role") == role
        ):
            payload = dict(b.get("payload") or {})
            payload["axisDegBeamLocal"] = axis_deg
            payload["role"] = role
            new_bindings.append({**b, "payload": payload})
            replaced = True
        else:
            new_bindings.append(b)
    if not replaced:
        anchor_id = pick_optical_surface_anchor_id(
            getattr(scene_object, "_pickable_anchors", None) or []
        ) or "optical_anchor"
        new_bindings.append(_make_polarization_reference_binding(
            anchor_id=anchor_id, role=role, axis_deg=axis_deg, name=name,
        ))
    properties["anchorBindings"] = new_bindings
    scene_object.properties = properties
    flag_modified(scene_object, "properties")


def write_waveplate_axis_deg_beam_local(scene_object: SceneObject, axis_deg: float) -> None:
    _upsert_polarization_binding(
        scene_object, role="fast", axis_deg=axis_deg, name="Fast axis",
    )


def write_polarizer_axis_deg_beam_local(scene_object: SceneObject, axis_deg: float) -> None:
    _upsert_polarization_binding(
        scene_object, role="transmission", axis_deg=axis_deg, name="Transmission axis",
    )


def write_isolator_axis_deg_beam_local(scene_object: SceneObject, axis_deg: float) -> None:  # type: ignore[no-redef]
    """V2 Phase 8: same write path as the polarizer (shared role)."""
    _upsert_polarization_binding(
        scene_object, role="transmission", axis_deg=axis_deg, name="Isolator transmission axis",
    )


async def bootstrap_isolator_default_binding(
    scene_object: SceneObject,
    asset: Asset3D | None,
) -> bool:
    return await bootstrap_polarization_axis_binding(
        scene_object, asset, role="transmission", name="Isolator transmission axis",
    )


def get_beam_splitter_coating_normal(
    scene_object: SceneObject | dict[str, Any] | None,
) -> list[float] | None:
    """V2 Phase 6 read of the beam_splitter internal coating normal from
    its opticalSurface binding (same payload key as the mirror cutover)."""
    return get_mirror_normal_body_local(scene_object)


def legacy_beam_splitter_kind_params_from_bindings(
    scene_object: SceneObject | dict[str, Any] | None,
    *,
    polarizing: bool,
) -> dict[str, Any]:
    """Synthesise the legacy beam_splitter geometry kindParams from V2
    bindings. Always returns the coating normal (defaults to the historical
    [√½, √½, 0] when no binding); only returns the PBS transmission axis
    when ``polarizing`` is True."""
    out: dict[str, Any] = {}
    normal = get_beam_splitter_coating_normal(scene_object)
    if normal is not None:
        out["coatingNormalBodyLocal"] = normal
    else:
        out["coatingNormalBodyLocal"] = [0.7071067811865475, 0.7071067811865475, 0.0]
    if polarizing:
        axis = get_polarizer_axis_deg_beam_local(scene_object)
        if axis is not None:
            out["transmissionAxisDegBeamLocal"] = axis
        else:
            out["transmissionAxisDegBeamLocal"] = 0.0
    return out


def write_beam_splitter_coating_normal(
    scene_object: SceneObject, normal_body_local: list[float]
) -> None:
    """V2 Phase 6 write of the beam_splitter coating normal — overwrites
    the existing opticalSurface binding payload, or appends one if absent.
    """
    properties = dict(scene_object.properties or {})
    bindings = list(properties.get("anchorBindings") or [])
    new_bindings: list[Any] = []
    replaced = False
    for b in bindings:
        if (
            isinstance(b, dict)
            and b.get("kind") == OPTICAL_SURFACE_BINDING_KIND
            and not replaced
        ):
            payload = dict(b.get("payload") or {})
            payload["normalBodyLocal"] = list(normal_body_local)
            new_bindings.append({**b, "payload": payload})
            replaced = True
        else:
            new_bindings.append(b)
    if not replaced:
        anchor_id = pick_optical_surface_anchor_id(
            getattr(scene_object, "_pickable_anchors", None) or []
        ) or "optical_anchor"
        new_bindings.append({
            "id": uuid7_str(),
            "name": "Internal coating",
            "anchorId": anchor_id,
            "kind": OPTICAL_SURFACE_BINDING_KIND,
            "frame": "anchorLocalXY",
            "payload": {"normalBodyLocal": list(normal_body_local)},
        })
    properties["anchorBindings"] = new_bindings
    scene_object.properties = properties
    flag_modified(scene_object, "properties")


async def bootstrap_beam_splitter_default_bindings(
    scene_object: SceneObject,
    asset: Asset3D | None,
    *,
    polarizing: bool,
) -> bool:
    """For freshly-spawned beam_splitter / PBS instances, attach the
    default opticalSurface binding (coating normal = [√½, √½, 0]) and,
    when polarizing, also a polarizationReference binding (role=transmission,
    axis=0°). Mirrors the alembic 0032 backfill defaults."""
    if asset is None:
        return False
    anchor_id = pick_optical_surface_anchor_id(asset.anchors or [])
    if anchor_id is None:
        return False

    added = False
    properties = dict(scene_object.properties or {})
    bindings = list(properties.get("anchorBindings") or [])
    if not any(
        isinstance(b, dict) and b.get("kind") == OPTICAL_SURFACE_BINDING_KIND for b in bindings
    ):
        bindings.append({
            "id": uuid7_str(),
            "name": "Internal coating",
            "anchorId": anchor_id,
            "kind": OPTICAL_SURFACE_BINDING_KIND,
            "frame": "anchorLocalXY",
            "payload": {"normalBodyLocal": [0.7071067811865475, 0.7071067811865475, 0.0]},
        })
        added = True
    if polarizing and not any(
        isinstance(b, dict)
        and b.get("kind") == POLARIZATION_REFERENCE_BINDING_KIND
        and (b.get("payload") or {}).get("role") == "transmission"
        for b in bindings
    ):
        bindings.append({
            "id": uuid7_str(),
            "name": "PBS transmission axis",
            "anchorId": anchor_id,
            "kind": POLARIZATION_REFERENCE_BINDING_KIND,
            "frame": "anchorLocalXY",
            "payload": {"role": "transmission", "axisDegBeamLocal": 0.0},
        })
        added = True
    if added:
        properties["anchorBindings"] = bindings
        scene_object.properties = properties
        flag_modified(scene_object, "properties")
    return added


def get_aom_rf_direction_body_local(
    scene_object: SceneObject | dict[str, Any] | None,
) -> list[float] | None:
    """V2 Phase 7 read of AOM RF / acoustic direction from rfDirection binding."""
    if scene_object is None:
        return None
    if isinstance(scene_object, dict):
        properties = scene_object.get("properties") or {}
    else:
        properties = scene_object.properties or {}
    bindings = properties.get("anchorBindings") or []
    for b in bindings:
        if (
            isinstance(b, dict)
            and b.get("kind") == RF_DIRECTION_BINDING_KIND
            and isinstance(b.get("payload"), dict)
        ):
            raw = b["payload"].get("directionBodyLocal")
            if isinstance(raw, list) and len(raw) >= 3:
                try:
                    return [float(raw[0]), float(raw[1]), float(raw[2])]
                except (TypeError, ValueError):
                    continue
    return None


def legacy_aom_kind_params_from_binding(
    scene_object: SceneObject | dict[str, Any] | None,
) -> dict[str, Any]:
    """Synthesise the legacy AOM RF / acoustic direction kindParams from
    the V2 rfDirection binding. Defaults to [-1, 0, 0] (MT80 convention)
    when no binding exists."""
    direction = get_aom_rf_direction_body_local(scene_object) or [-1.0, 0.0, 0.0]
    return {
        "rfPropagationDirectionBodyLocal": direction,
        # The acoustic_axis_body_local field aliased the same vector in V1;
        # keep it populated for any reader that still consults it.
        "acousticAxisBodyLocal": direction,
    }


def write_aom_rf_direction_body_local(
    scene_object: SceneObject, direction_body_local: list[float]
) -> None:
    """Overwrite-or-append the rfDirection binding payload."""
    properties = dict(scene_object.properties or {})
    bindings = list(properties.get("anchorBindings") or [])
    new_bindings: list[Any] = []
    replaced = False
    for b in bindings:
        if (
            isinstance(b, dict)
            and b.get("kind") == RF_DIRECTION_BINDING_KIND
            and not replaced
        ):
            payload = dict(b.get("payload") or {})
            payload["directionBodyLocal"] = list(direction_body_local)
            new_bindings.append({**b, "payload": payload})
            replaced = True
        else:
            new_bindings.append(b)
    if not replaced:
        anchor_id = pick_optical_surface_anchor_id(
            getattr(scene_object, "_pickable_anchors", None) or []
        ) or "optical_anchor"
        new_bindings.append({
            "id": uuid7_str(),
            "name": "RF / acoustic propagation",
            "anchorId": anchor_id,
            "kind": RF_DIRECTION_BINDING_KIND,
            "frame": "anchorLocalXY",
            "payload": {"directionBodyLocal": list(direction_body_local)},
        })
    properties["anchorBindings"] = new_bindings
    scene_object.properties = properties
    flag_modified(scene_object, "properties")
    # SA does not detect JSONB attribute reassignment via plain dict equality
    # comparison without a MutableDict wrapper. Explicitly flag the column as
    # modified so commit() flushes the change.
    flag_modified(scene_object, "properties")


async def bootstrap_aom_default_binding(
    scene_object: SceneObject,
    asset: Asset3D | None,
    *,
    default_direction: list[float] | None = None,
) -> bool:
    """Default rfDirection = [-1, 0, 0] (MT80 convention: body -X is
    transducer → absorber)."""
    if asset is None:
        return False
    if any(
        isinstance(b, dict) and b.get("kind") == RF_DIRECTION_BINDING_KIND
        for b in (scene_object.properties or {}).get("anchorBindings", [])
    ):
        return False
    anchor_id = pick_optical_surface_anchor_id(asset.anchors or [])
    if anchor_id is None:
        return False
    direction = default_direction if default_direction is not None else [-1.0, 0.0, 0.0]
    binding = {
        "id": uuid7_str(),
        "name": "RF / acoustic propagation",
        "anchorId": anchor_id,
        "kind": RF_DIRECTION_BINDING_KIND,
        "frame": "anchorLocalXY",
        "payload": {"directionBodyLocal": list(direction)},
    }
    scene_object.properties = append_binding(scene_object.properties, binding)
    flag_modified(scene_object, "properties")
    return True


async def bootstrap_polarization_axis_binding(
    scene_object: SceneObject,
    asset: Asset3D | None,
    role: str,
    name: str,
    default_axis_deg: float = 0.0,
) -> bool:
    """Attach a default polarizationReference binding for a freshly-spawned
    waveplate or polarizer. Returns True iff one was added."""
    existing = _find_polarization_binding_by_role(scene_object, role)
    if existing is not None:
        return False
    if asset is None:
        return False
    anchor_id = pick_optical_surface_anchor_id(asset.anchors or [])
    if anchor_id is None:
        return False
    binding = _make_polarization_reference_binding(
        anchor_id=anchor_id, role=role, axis_deg=default_axis_deg, name=name,
    )
    scene_object.properties = append_binding(scene_object.properties, binding)
    flag_modified(scene_object, "properties")
    return True


async def bootstrap_laser_default_binding_and_source(
    scene_object: SceneObject,
    component: Component,
    asset: Asset3D | None,
) -> bool:
    """If ``scene_object`` is a freshly-created laser_source with no
    emissionReference binding yet, attach a default one referencing the
    asset's preferred emission anchor and seed an opticalSources[] entry
    with the default V2 beam. Returns True iff a binding was added.
    """
    if find_binding(scene_object, kind=EMISSION_REFERENCE_BINDING_KIND) is not None:
        return False
    if asset is None:
        return False
    anchor_id = pick_optical_surface_anchor_id(asset.anchors or [])
    if anchor_id is None:
        return False

    # Default emission direction = anchor.directionBodyLocal if present, else +X.
    normal = [1.0, 0.0, 0.0]
    for a in (asset.anchors or []):
        if isinstance(a, dict) and a.get("id") == anchor_id:
            d = a.get("directionBodyLocal")
            if isinstance(d, dict):
                try:
                    normal = [float(d.get("x", 1.0)), float(d.get("y", 0.0)), float(d.get("z", 0.0))]
                except (TypeError, ValueError):
                    pass
            break

    binding = {
        "id": uuid7_str(),
        "name": "Laser output",
        "anchorId": anchor_id,
        "kind": EMISSION_REFERENCE_BINDING_KIND,
        "frame": "anchorLocalXY",
        "payload": {"normalBodyLocal": normal},
    }
    properties = append_binding(scene_object.properties, binding)

    # Add a default opticalSource if none exists for this binding.
    sources = list(properties.get("opticalSources") or [])
    sources.append({
        "id": uuid7_str(),
        "bindingId": binding["id"],
        "enabled": True,
        "beam": default_laser_beam(),
    })
    properties["opticalSources"] = sources

    scene_object.properties = properties
    flag_modified(scene_object, "properties")
    return True


async def bootstrap_mirror_default_binding(
    scene_object: SceneObject,
    component: Component,
    asset: Asset3D | None,
) -> bool:
    """If ``scene_object`` is a freshly-created mirror with no
    opticalSurface binding yet, attach a default one (normal=[1,0,0]) bound
    to the asset's preferred anchor. Returns True iff a binding was added.

    Caller is expected to be inside an open async session; the SceneObject
    row's ``properties`` is mutated in-place. ``await session.commit()``
    or refresh is the caller's responsibility.
    """
    if find_binding(scene_object, kind=OPTICAL_SURFACE_BINDING_KIND) is not None:
        return False
    if asset is None:
        return False
    anchor_id = pick_optical_surface_anchor_id(asset.anchors or [])
    if anchor_id is None:
        return False
    binding = make_optical_surface_binding(
        anchor_id=anchor_id,
        normal_body_local=[1.0, 0.0, 0.0],
    )
    scene_object.properties = append_binding(scene_object.properties, binding)
    flag_modified(scene_object, "properties")
    return True
