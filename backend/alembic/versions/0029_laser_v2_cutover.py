"""V2 Phase 3: cut `laser_source` over to opticalSources[] (hard cutover).

Revision ID: 0029_laser_v2_cutov
Revises: 0028_mirror_v2_cutov

V2 schema (docs/optical-schema-v2.md §3) puts a laser's emitted-beam
parameters (wavelength, power, spectrum/linewidth, polarization,
spatial envelope, transverse mode) on
``objects.properties.opticalSources[].beam`` instead of
``optical_elements.kind_params``. The emission geometry (start direction
and reference) lives on
``objects.properties.anchorBindings[emissionReference]``.

Per-row migration for every {laser_source} OpticalElement:

1. Read kind_params (centerWavelengthNm, nominalPowerMw, spectrum,
   spatialModeX, spatialModeY, transverseMode, polarization, ...).
2. Pick a binding anchor on the parent Asset3D (preference order matches
   v2_bindings.pick_optical_surface_anchor_id):
   ``optical_anchor`` → ``intercept_face`` / ``intercept_in`` / ``intercept_out``
   / id-or-name containing "optical" → first anchor with id.
3. Append an ``emissionReference`` binding to objects.properties.anchorBindings
   (defaults the payload normal from the picked anchor's directionBodyLocal,
   else [1, 0, 0]).
4. Append an ``opticalSources[]`` entry referencing that binding, with a
   V2-shaped ``beam`` translated from the legacy kind_params via the
   field-mapping below.
5. Strip the V2-tracked fields from kind_params. After this migration
   kind_params for laser_source is effectively ``{}``; we keep the row
   so DEFAULT_KIND_PARAMS / OpticalElement bootstrap stays simple.

Field mapping legacy → V2 BeamSource:
    centerWavelengthNm                 → beam.spectrum.centerWavelengthNm
    spectrum.components[0].fwhmMhz·1e6 → beam.spectrum.linewidth.fwhmHz
    spectrum.components[0].lineshape   → beam.spectrum.linewidth.kind
    nominalPowerMw                     → beam.powerMw
    polarization.{exRe..eyIm}          → beam.polarization.jones.{exRe..eyIm}
    spatialModeX.waistUm               → beam.spatialEnvelope.transverseProfile.x.waistRadiusUm
    spatialModeX.waistZOffsetMm        → beam.spatialEnvelope.propagation.x.waistZOffsetMm
    spatialModeX.mSquared              → beam.spatialEnvelope.propagation.x.mSquared
    (same for spatialModeY)
    transverseMode.kind == "TEM00"     → beam.transverseMode = HG(0,0) "TEM00"
    transverseMode.kind == "TEM_mn"    → HG(indices_m, indices_n)

Downgrade: lifts V2 beam back into kind_params and drops the emissionReference
binding + the opticalSources[] entry.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any

import sqlalchemy as sa

from alembic import op


revision = "0029_laser_v2_cutov"
down_revision = "0028_mirror_v2_cutov"
branch_labels = None
depends_on = None


LASER_KIND = "laser_source"
EMISSION_BINDING_KIND = "emissionReference"

# Legacy kindParams keys that are migrated to opticalSources[].beam and then
# stripped. Keys outside this set (none today, but future user-set knobs like
# `rinDbcPerHz` if anyone ever wired them) survive the migration in
# kind_params.
V2_TRACKED_LASER_KEYS = (
    "centerWavelengthNm",
    "nominalPowerMw",
    "spectrum",
    "spatialModeX",
    "spatialModeY",
    "transverseMode",
    "polarization",
)


def _uuid7() -> str:
    ts_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    rand = int.from_bytes(os.urandom(10), "big")
    rand_a = rand & ((1 << 12) - 1)
    rand_b = (rand >> 12) & ((1 << 62) - 1)
    value = (ts_ms << 80) | (0x7 << 76) | (rand_a << 64) | (0b10 << 62) | rand_b
    return str(uuid.UUID(int=value))


def _pick_anchor_id(asset_anchors: list) -> str | None:
    if not asset_anchors:
        return None
    by_id = {a.get("id"): a for a in asset_anchors if isinstance(a, dict)}
    if "optical_anchor" in by_id:
        return "optical_anchor"
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


def _anchor_direction(asset_anchors: list, anchor_id: str | None) -> list[float]:
    if anchor_id is None or not asset_anchors:
        return [1.0, 0.0, 0.0]
    for a in asset_anchors:
        if isinstance(a, dict) and a.get("id") == anchor_id:
            d = a.get("directionBodyLocal")
            if isinstance(d, dict):
                try:
                    return [float(d.get("x", 1.0)), float(d.get("y", 0.0)), float(d.get("z", 0.0))]
                except (TypeError, ValueError):
                    pass
    return [1.0, 0.0, 0.0]


def _legacy_to_beam(kp: dict[str, Any]) -> dict[str, Any]:
    """Translate legacy laser kindParams into a V2 BeamSource (camelCase)."""
    # Power
    try:
        power_mw = float(kp.get("nominalPowerMw", 1.0))
    except (TypeError, ValueError):
        power_mw = 1.0

    # Wavelength (default rubidium D2 if missing)
    try:
        wavelength_nm = float(kp.get("centerWavelengthNm", 780.241))
    except (TypeError, ValueError):
        wavelength_nm = 780.241

    # Linewidth: take from the first spectrum component if any.
    spectrum_in = kp.get("spectrum") or {}
    components = spectrum_in.get("components") or []
    linewidth: dict[str, Any] = {"kind": "delta"}
    if components:
        first = components[0] if isinstance(components[0], dict) else {}
        ls = (first.get("lineshape") or "delta").lower()
        if ls == "voigt":
            g = first.get("voigtGaussianFwhmMhz")
            l = first.get("voigtLorentzianFwhmMhz")
            if g and l:
                linewidth = {
                    "kind": "voigt",
                    "gaussianFwhmHz": float(g) * 1e6,
                    "lorentzianFwhmHz": float(l) * 1e6,
                }
        elif ls in ("gaussian", "lorentzian"):
            fwhm_mhz = first.get("fwhmMhz")
            if fwhm_mhz is not None:
                linewidth = {"kind": ls, "fwhmHz": float(fwhm_mhz) * 1e6}
        elif ls == "delta":
            linewidth = {"kind": "delta"}

    # Polarization Jones vector
    pol_in = kp.get("polarization") or {}
    jones = {
        "exRe": float(pol_in.get("exRe", 1.0)),
        "exIm": float(pol_in.get("exIm", 0.0)),
        "eyRe": float(pol_in.get("eyRe", 0.0)),
        "eyIm": float(pol_in.get("eyIm", 0.0)),
    }

    # Spatial envelope: per-axis Gaussian with M^2 propagation.
    def _axis(legacy: dict[str, Any] | None) -> tuple[dict[str, Any], dict[str, Any]]:
        legacy = legacy or {}
        try:
            waist_um = float(legacy.get("waistUm", 500.0))
        except (TypeError, ValueError):
            waist_um = 500.0
        try:
            offset_mm = float(legacy.get("waistZOffsetMm", 0.0))
        except (TypeError, ValueError):
            offset_mm = 0.0
        try:
            m_sq = float(legacy.get("mSquared", 1.0))
        except (TypeError, ValueError):
            m_sq = 1.0
        return ({"waistRadiusUm": waist_um}, {"waistZOffsetMm": offset_mm, "mSquared": m_sq})

    profile_x, prop_x = _axis(kp.get("spatialModeX"))
    profile_y, prop_y = _axis(kp.get("spatialModeY"))

    # Transverse mode — current schema uses kind=TEM00/TEM_mn/LG_pl/multimode;
    # V2 uses {family: HG/LG/measured, m, n}.
    tm_in = kp.get("transverseMode") or {"kind": "TEM00"}
    tm_kind = (tm_in.get("kind") or "TEM00").upper()
    if tm_kind == "TEM_MN":
        family = "HG"
        m = int(tm_in.get("indicesM", 0))
        n = int(tm_in.get("indicesN", 0))
        label = f"HG{m}{n}"
    elif tm_kind == "LG_PL":
        family = "LG"
        m = int(tm_in.get("indicesP", 0))
        n = int(tm_in.get("indicesL", 0))
        label = f"LG{m}{n}"
    elif tm_kind == "MULTIMODE":
        family = "measured"
        m = 0
        n = 0
        label = "multimode"
    else:
        family = "HG"
        m = 0
        n = 0
        label = "TEM00"

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
            "jones": jones,
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


def _beam_to_legacy(beam: dict[str, Any]) -> dict[str, Any]:
    """Reverse mapping for downgrade — V2 BeamSource → legacy laser kindParams.

    Best-effort: linewidth round-trips for gaussian/lorentzian/voigt/delta;
    everything else preserves the values inserted by upgrade()."""
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
    # 1 nm at 780 nm ≈ 384.2 THz / 800 GHz. Use c/λ in THz.
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
        legacy_tm = {"kind": "TEM_mn", "indicesM": int(tm.get("m", 0)), "indicesN": int(tm.get("n", 0))}
    elif family == "LG":
        legacy_tm = {"kind": "LG_pl", "indicesP": int(tm.get("m", 0)), "indicesL": int(tm.get("n", 0))}
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


def upgrade() -> None:
    bind = op.get_bind()

    rows = bind.execute(
        sa.text(
            """
            SELECT oe.object_id, oe.kind_params, o.properties, c.asset_3d_id
            FROM optical_elements oe
            JOIN objects o    ON o.id = oe.object_id
            JOIN components c ON c.id = o.component_id
            WHERE oe.element_kind = :kind
            """
        ),
        {"kind": LASER_KIND},
    ).fetchall()

    asset_cache: dict[str, list] = {}

    for object_id, kp_raw, props_raw, asset_3d_id in rows:
        kp = kp_raw if isinstance(kp_raw, dict) else (json.loads(kp_raw) if kp_raw else {})
        props = props_raw if isinstance(props_raw, dict) else (json.loads(props_raw) if props_raw else {})
        kp = dict(kp or {})
        props = dict(props or {})

        # Build the V2 beam from the legacy kindParams.
        beam = _legacy_to_beam(kp)

        # Look up the asset's anchors to choose the emissionReference target.
        anchors: list = []
        if asset_3d_id is not None:
            cached = asset_cache.get(str(asset_3d_id))
            if cached is None:
                row = bind.execute(
                    sa.text("SELECT anchors FROM assets_3d WHERE id = :id"),
                    {"id": asset_3d_id},
                ).fetchone()
                cached = row[0] if row else []
                if isinstance(cached, str):
                    cached = json.loads(cached)
                cached = cached or []
                asset_cache[str(asset_3d_id)] = cached
            anchors = cached

        anchor_id = _pick_anchor_id(anchors)

        # Idempotency: don't double-insert if a previous run already added them.
        bindings = props.get("anchorBindings") or []
        if not isinstance(bindings, list):
            bindings = []
        sources = props.get("opticalSources") or []
        if not isinstance(sources, list):
            sources = []

        if anchor_id is not None and not any(
            isinstance(b, dict) and b.get("kind") == EMISSION_BINDING_KIND for b in bindings
        ):
            normal = _anchor_direction(anchors, anchor_id)
            new_binding = {
                "id": _uuid7(),
                "name": "Laser output",
                "anchorId": anchor_id,
                "kind": EMISSION_BINDING_KIND,
                "frame": "anchorLocalXY",
                "payload": {"normalBodyLocal": normal},
            }
            bindings.append(new_binding)
            props["anchorBindings"] = bindings
            binding_id = new_binding["id"]
        else:
            existing = next(
                (b for b in bindings if isinstance(b, dict) and b.get("kind") == EMISSION_BINDING_KIND),
                None,
            )
            binding_id = existing["id"] if existing else _uuid7()

        if not any(isinstance(s, dict) and s.get("bindingId") == binding_id for s in sources):
            sources.append({
                "id": _uuid7(),
                "bindingId": binding_id,
                "enabled": True,
                "beam": beam,
            })
            props["opticalSources"] = sources

        # Hard cutover: strip the V2-tracked fields from kindParams.
        for key in V2_TRACKED_LASER_KEYS:
            kp.pop(key, None)

        bind.execute(
            sa.text(
                "UPDATE optical_elements SET kind_params = CAST(:kp AS JSONB) WHERE object_id = :oid"
            ),
            {"kp": json.dumps(kp), "oid": object_id},
        )
        bind.execute(
            sa.text("UPDATE objects SET properties = CAST(:p AS JSONB) WHERE id = :oid"),
            {"p": json.dumps(props), "oid": object_id},
        )


def downgrade() -> None:
    bind = op.get_bind()

    rows = bind.execute(
        sa.text(
            """
            SELECT oe.object_id, oe.kind_params, o.properties
            FROM optical_elements oe
            JOIN objects o ON o.id = oe.object_id
            WHERE oe.element_kind = :kind
            """
        ),
        {"kind": LASER_KIND},
    ).fetchall()

    for object_id, kp_raw, props_raw in rows:
        kp = kp_raw if isinstance(kp_raw, dict) else (json.loads(kp_raw) if kp_raw else {})
        props = props_raw if isinstance(props_raw, dict) else (json.loads(props_raw) if props_raw else {})
        kp = dict(kp or {})
        props = dict(props or {})

        sources = props.get("opticalSources") or []
        bindings = props.get("anchorBindings") or []

        beam: dict[str, Any] | None = None
        kept_sources: list = []
        consumed_binding_id: str | None = None
        for s in sources:
            if isinstance(s, dict) and isinstance(s.get("beam"), dict) and beam is None:
                beam = s["beam"]
                consumed_binding_id = s.get("bindingId")
                continue
            kept_sources.append(s)
        if kept_sources != sources:
            props["opticalSources"] = kept_sources

        kept_bindings = []
        for b in bindings:
            if (
                isinstance(b, dict)
                and b.get("kind") == EMISSION_BINDING_KIND
                and consumed_binding_id is not None
                and b.get("id") == consumed_binding_id
            ):
                continue
            kept_bindings.append(b)
        if kept_bindings != bindings:
            props["anchorBindings"] = kept_bindings

        if beam is not None:
            kp.update(_beam_to_legacy(beam))

        bind.execute(
            sa.text(
                "UPDATE optical_elements SET kind_params = CAST(:kp AS JSONB) WHERE object_id = :oid"
            ),
            {"kp": json.dumps(kp), "oid": object_id},
        )
        bind.execute(
            sa.text("UPDATE objects SET properties = CAST(:p AS JSONB) WHERE id = :oid"),
            {"p": json.dumps(props), "oid": object_id},
        )
