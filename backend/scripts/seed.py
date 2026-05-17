from __future__ import annotations

import asyncio
import json
import math
import re
from pathlib import Path
import sys

from sqlalchemy import select, text

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.db import AsyncSessionLocal, engine  # noqa: E402
from app.models import (  # noqa: E402
    Asset3D,
    Base,
    BeamPath,
    Collection,
    CollectionMember,
    Component,
    Connection,
    DeviceState,
    SceneObject,
)
from app.routers.collections import get_master_collection  # noqa: E402


def _parse_fiber_meta(part: str) -> dict[str, object]:
    # Extract fiber type / wavelength / length / connector polish from
    # Thorlabs patch-cable part numbers like P1-980A-FC-1, P3-1064PMY-2,
    # P5-630PM-FC-2 etc. The PM/SM split, design wavelength and connector
    # geometry are encoded directly in the part number; everything else
    # falls through to DEFAULT_KIND_PARAMS["fiber"] via the deep-merge in
    # default_kind_params_for_component.
    is_pm = "PM" in part
    fiber_type = "polarization_maintaining" if is_pm else "single_mode"

    wavelength = 1310 if "SMF28" in part else 780
    if "SMF28" not in part:
        for tok in part.split("-")[1:]:
            stripped = tok.lstrip("S")
            m = re.match(r"^(\d+)", stripped)
            if m:
                v = int(m.group(1))
                if v >= 100:
                    wavelength = v
                    break

    length_m = 1
    last = part.rsplit("-", 1)[-1]
    if last.isdigit():
        length_m = int(last)

    prefix = part.split("-", 1)[0]
    polish_a, polish_b = {
        "P1": ("PC", "PC"),
        "P3": ("APC", "APC"),
        "P5": ("PC", "APC"),
    }.get(prefix, ("PC", "PC"))

    return {
        "fiber_type": fiber_type,
        "wavelength_nm": wavelength,
        "length_m": length_m,
        "polish_a": polish_a,
        "polish_b": polish_b,
    }


def _build_fiber_override(part: str) -> dict[str, object]:
    # Build a minimal fiberKindParamsOverride from the parsed meta. Deep-
    # merged into DEFAULT_KIND_PARAMS["fiber"] in components.py so anything
    # not set here (MFD, NA, attenuation curve, etc.) inherits the default.
    meta = _parse_fiber_meta(part)
    wl = float(meta["wavelength_nm"])
    is_pm = meta["fiber_type"] == "polarization_maintaining"

    def end_spec(polish: str) -> dict[str, object]:
        spec: dict[str, object] = {
            "connectorType": "FC",
            "polish": polish,
            "polishAngleDeg": 8.0 if polish == "APC" else 0.0,
        }
        if not is_pm:
            spec["slowAxisDegInBodyFrame"] = None
        return spec

    override: dict[str, object] = {
        "fiberType": meta["fiber_type"],
        "designWavelengthNm": wl,
        "wavelengthRangeNm": [wl - 20.0, wl + 20.0],
        "endA": end_spec(meta["polish_a"]),
        "endB": end_spec(meta["polish_b"]),
    }
    if not is_pm:
        # Single-mode telecom cutoff heuristic: roughly 0.85 × design
        # wavelength keeps a comfortable single-mode margin.
        override["cutoffWavelengthNm"] = round(wl * 0.85, 1)
    return override


# NIR Free-Space Isolators 690 - 1080 nm. Specs lifted from the Thorlabs
# overview tables at
# https://www.thorlabs.com/nir-free-space-isolators-690---1080-nm?tabName=Overview
# (snapshot 2026-05-12). Tuple layout:
#   (centerWavelengthNm, tuningRangeNm | None, transmissionPercent,
#    isolationDb, maxBeamDiameterMm, maxPowerW, isTandem, housing)
# - tuningRangeNm is None for fixed-narrowband models (no user-rotatable
#   polarizer rings). When given as [low, high] it's the adjustable
#   narrowband range; the catalog stores the range, the solver uses the
#   center wavelength as the design point.
# - transmissionPercent is the typical at center wavelength. For ranges
#   on the Thorlabs page (e.g. "48 - 55%"), midpoint is used; the
#   forwardLossDb derivation is rounded to 2 decimals so re-runs are
#   deterministic.
# - isolationDb stores a single dB number suitable for the solver. When
#   Thorlabs publishes a range like "34 - 40 dB", the midpoint is used;
#   "≥X dB" and "X dB (Min)" map straight to X. Catalogs that need the
#   raw range can read `properties.isolationDbRange` (set below).
_ISOLATOR_SPECS: dict[str, tuple] = {
    # 850 nm only (per 2026-05-12 user scope reduction; other-wavelength
    # variants removed from the catalog).
    "IO-3D-850-VLP":  (850,  None,        86, 37,   2.7,  0.7,  False, "standard"),
    "IO-3-850-HP":    (850,  [835, 865],  92, 37,   2.7, 15.0,  False, "high_power"),
    "IO-5-850-VLP":   (850,  [830, 870],  88, 35,   4.7,  1.7,  False, "standard"),
    "IOT-5-850-VLP":  (850,  [830, 870],  80, 55,   4.7,  1.7,  True,  "tandem"),
    "IOT-5-850-MP":   (850,  [830, 870],  80, 60,   4.7,  7.0,  True,  "tandem_medium_power"),
    "IO-5-850-HP":    (850,  [835, 865],  92, 41,   4.7, 40.0,  False, "high_power"),
}

# Thorlabs publishes some isolation values as a range ("34 - 40 dB") rather
# than a single number. The single-number spec above takes the midpoint so
# the solver has one figure of merit, but the catalog UI keeps the full
# range too. Map: part → (lowDb, highDb). Parts not listed here had a
# single published value (e.g. "≥38 dB" → just (38, 38)).
_ISOLATOR_ISOLATION_RANGE_DB: dict[str, tuple[float, float]] = {
    "IO-3D-850-VLP":  (34, 40),
    "IO-3-850-HP":    (34, 40),
    "IO-5-850-HP":    (38, 44),
}


def _build_isolator_meta(part: str) -> dict[str, object]:
    # Build properties + isolatorKindParamsOverride from the Thorlabs spec.
    # forwardLossDb is derived from transmission: -10 * log10(T) where T
    # is fraction. Solver consumes the override via the bootstrapper in
    # routers/components.py (mirrors the fiberKindParamsOverride path).
    spec = _ISOLATOR_SPECS.get(part)
    if spec is None:
        return {}
    center_nm, tuning, trans_pct, iso_db, beam_mm, max_pw, is_tandem, housing = spec
    forward_loss_db = round(-10.0 * math.log10(trans_pct / 100.0), 2)
    props: dict[str, object] = {
        "centerWavelengthNm": float(center_nm),
        "transmissionPercent": float(trans_pct),
        "isolationDb": float(iso_db),
        "maxBeamDiameterMm": float(beam_mm),
        "maxPowerW": float(max_pw),
        "housing": housing,
        "isTandem": bool(is_tandem),
        "isolatorKindParamsOverride": {
            "forwardLossDb": forward_loss_db,
            "isolationDb": float(iso_db),
        },
    }
    if tuning is not None:
        props["tuningRangeNm"] = [float(tuning[0]), float(tuning[1])]
    iso_range = _ISOLATOR_ISOLATION_RANGE_DB.get(part)
    if iso_range is not None:
        props["isolationDbRange"] = [float(iso_range[0]), float(iso_range[1])]
    return props


ASSETS = [
    {
        "name": "primitive_table",
        "asset_type": "primitive",
        "file_path": "primitive://table",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_box",
        "asset_type": "primitive",
        "file_path": "primitive://box",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_mirror",
        "asset_type": "primitive",
        "file_path": "primitive://mirror",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_lens",
        "asset_type": "primitive",
        "file_path": "primitive://lens",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_chamber",
        "asset_type": "primitive",
        "file_path": "primitive://vacuum_chamber",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_thorlabs_post_holder",
        "asset_type": "primitive",
        "file_path": "primitive://thorlabs_post_holder",
        "source": "https://www.thorlabs.com/half-inch-post-holders",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_thorlabs_post",
        "asset_type": "primitive",
        "file_path": "primitive://thorlabs_post",
        "source": "https://www.thorlabs.com/optical-posts-half-inch-and-12-mm",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "primitive_thorlabs_clamping_fork",
        "asset_type": "primitive",
        "file_path": "primitive://thorlabs_clamping_fork",
        "source": "https://www.thorlabs.com/clamping-forks-for-pedestal-posts?pn=CF038C%2FM-P5",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "thorlabs_cf175cm_p5_edrawing",
        "asset_type": "edrawing_html",
        "file_path": "cf175c_m_edrawing.html",
        "source": "Thorlabs eDrawing",
        "source_url": "https://media.thorlabs.com/globalassets/items/c/cf/cf1/cf175c_m/ttn026566-e0w.html?v=0116105356",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        "name": "thorlabs_cf175cm_p5_stl",
        "asset_type": "stl",
        "file_path": "uploads/cf175c_m-p5.stl",
        "source": "FreeCAD STEP export",
        "source_url": "https://www.thorlabs.com/item/CF175C_M-P5?aID=4063768eebb43d2e49d40f1ce64ce7a8&aC=2",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        # Authoritative TOPTICA BoosTA pro 3D model — provided by user. GLB
        # carries embedded materials/colours so the wireframe in the viewer
        # matches the real product (black bottom + blue lid + aluminium
        # flanges) without any procedural mesh code. Replaces the earlier
        # `createBoostaProModule` placeholder mesh.
        "name": "toptica_boosta_pro_glb",
        "asset_type": "glb",
        "file_path": "uploads/toptica_boosta_pro.glb",
        "source": "user_upload",
        "unit": "mm",
        "scale_factor": 1.0,
        # Two-port TA — same anchor convention as AOM/lens entries.
        # GLB body extent: 275 × 115 × 90 mm (X × Y × Z), centred at origin.
        # The user-supplied BoosTA GLB is oriented so the +X face is the
        # seed-side (per the in-code comment in TaperedAmplifierAdjustControls
        # alignInputToLaser, which sorts apertures by max-X to pick INPUT) —
        # but the TOPTICA datasheet labels that face "backward" (housing-front
        # vs housing-back). Two languages, same physics.
        # Apertures (radius mm): TA chips taper from ~1.5 mm at the seed end
        # to ~3-4 mm at the output end; using radii 0.75 / 2.0 mm.
        "anchors": [
            {
                "id": "intercept_in",
                "positionMmBodyLocal": {"x": 137.5, "y": 0.0, "z": 0.0},
                "directionBodyLocal": {"x": 1.0, "y": 0.0, "z": 0.0},
                "apertureMm": 0.75,
            },
            {
                "id": "intercept_out",
                "positionMmBodyLocal": {"x": -137.5, "y": 0.0, "z": 0.0},
                "directionBodyLocal": {"x": -1.0, "y": 0.0, "z": 0.0},
                "apertureMm": 2.0,
            },
        ],
    },
    {
        # AA Optoelectronic MT80-style AOM — GLB built from user's Blender
        # source via backend/scripts/fix_aom_blend.py (boolean-cuts the
        # input/output through-holes + adds a TeO₂ Bragg-cell crystal +
        # strips operand cutters). Authored in Blender at NATIVE METRES so
        # `unit` MUST be "m"; if the upload UI default of "mm" leaks through
        # the asset renders at 1/1000 scale and looks invisible.
        "name": "aom_aa_mt80_glb",
        "asset_type": "glb",
        "file_path": "uploads/aom_aa_mt80.glb",
        "source": "user_upload",
        "unit": "m",
        "scale_factor": 1.0,
        # AOM contract requires intercept_in / intercept_out anchors with
        # apertureMm set (alembic 0021 backfills these on existing rows;
        # seed.py mirrors the same shape so a fresh DB matches a migrated
        # one). MT80-A1.5-IR housing 59.5 mm, axis 18 mm in from each end
        # → ports at body Y = ±11.75 mm; active aperture 1.5 mm → radius
        # 0.75 mm.
        # Phase 8 refactor (2026-05-10, per user): RF / acoustic propagation
        # direction lives on a third anchor `rf_direction` rather than in
        # kindParams.rfPropagationDirectionBodyLocal. Position is body
        # origin (it's a direction, not a point); apertureMm is unused
        # for this anchor. Default direction reflects the MT80 transducer-
        # to-absorber path (body −X) — the legacy kindParams default.
        "anchors": [
            {
                "id": "intercept_in",
                "positionMmBodyLocal": {"x": 0.0, "y": -11.75, "z": 0.0},
                "directionBodyLocal": {"x": 0.0, "y": 1.0, "z": 0.0},
                "apertureMm": 0.75,
            },
            {
                "id": "intercept_out",
                "positionMmBodyLocal": {"x": 0.0, "y": 11.75, "z": 0.0},
                "directionBodyLocal": {"x": 0.0, "y": -1.0, "z": 0.0},
                "apertureMm": 0.75,
            },
            {
                "id": "rf_direction",
                "positionMmBodyLocal": {"x": 0.0, "y": 0.0, "z": 0.0},
                "directionBodyLocal": {"x": -1.0, "y": 0.0, "z": 0.0},
                "apertureMm": None,
            },
        ],
    },
    {
        # Thorlabs LA1614-B — N-BK7 plano-convex lens, Ø1/2", f = 150 mm,
        # AR coating 650–1050 nm. STEP downloaded from
        # https://www.thorlabs.com/item/LA1614-B and converted to STL via
        # FreeCAD (see .claude/skills/thorlabs-component-import/scripts/
        # freecad_step_to_stl.py).
        "name": "thorlabs_la1614_b_stl",
        "asset_type": "stl",
        "file_path": "uploads/thorlabs_la1614_b.stl",
        "source": "FreeCAD STEP export",
        "source_url": "https://www.thorlabs.com/item/LA1614-B",
        "unit": "mm",
        "scale_factor": 1.0,
        # Plano-convex lens: anchor "in" on the curved side, "out" on the
        # flat side, both pointing along +Y. Aperture matches the Ø12.7 mm
        # clear aperture (radius 6.35 mm). The seed is conservative —
        # users can override per-instance via PerObjectApertureEditor.
        "anchors": [
            {
                "id": "intercept_in",
                "positionMmBodyLocal": {"x": 0.0, "y": -1.0, "z": 0.0},
                "directionBodyLocal": {"x": 0.0, "y": 1.0, "z": 0.0},
                "apertureMm": 6.35,
            },
            {
                "id": "intercept_out",
                "positionMmBodyLocal": {"x": 0.0, "y": 1.0, "z": 0.0},
                "directionBodyLocal": {"x": 0.0, "y": -1.0, "z": 0.0},
                "apertureMm": 6.35,
            },
        ],
    },
    {
        # Thorlabs LA1540-B — N-BK7 plano-convex lens, Ø1/2", f = 15 mm,
        # AR coating 650–1050 nm. Same import pipeline as LA1614-B.
        "name": "thorlabs_la1540_b_stl",
        "asset_type": "stl",
        "file_path": "uploads/thorlabs_la1540_b.stl",
        "source": "FreeCAD STEP export",
        "source_url": "https://www.thorlabs.com/item/LA1540-B",
        "unit": "mm",
        "scale_factor": 1.0,
        "anchors": [
            {
                "id": "intercept_in",
                "positionMmBodyLocal": {"x": 0.0, "y": -1.0, "z": 0.0},
                "directionBodyLocal": {"x": 0.0, "y": 1.0, "z": 0.0},
                "apertureMm": 6.35,
            },
            {
                "id": "intercept_out",
                "positionMmBodyLocal": {"x": 0.0, "y": 1.0, "z": 0.0},
                "directionBodyLocal": {"x": 0.0, "y": -1.0, "z": 0.0},
                "apertureMm": 6.35,
            },
        ],
    },
    {
        # Thorlabs KS1 — Ø1" Precision Kinematic Mirror Mount, 3 adjusters.
        # Mechanical part (mount only — optic mounts separately), so no
        # optical anchors. STEP downloaded from /item/KS1 and converted to
        # STL via FreeCAD (same pipeline as LA1614-B).
        "name": "thorlabs_ks1_stl",
        "asset_type": "stl",
        "file_path": "uploads/thorlabs_ks1.stl",
        "source": "FreeCAD STEP export",
        "source_url": "https://www.thorlabs.com/item/KS1",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    {
        # Thorlabs KS1T — SM1-Threaded Ø1" Precision Kinematic Mirror Mount,
        # 3 adjusters. Same form-factor as KS1 with internal SM1 threading
        # for mounting SM1-threaded optics.
        "name": "thorlabs_ks1t_stl",
        "asset_type": "stl",
        "file_path": "uploads/thorlabs_ks1t.stl",
        "source": "FreeCAD STEP export",
        "source_url": "https://www.thorlabs.com/item/KS1T",
        "unit": "mm",
        "scale_factor": 1.0,
    },
    # ---- NIR Free-Space Isolators 850 nm STL assets (2026-05-12) ----
    # Only 850 nm kept after the 2026-05-12 scope reduction; the other
    # wavelength variants in the family (730/780/795/830/895/940/980/1030/
    # 1050 nm) were dropped from the catalog. STEP downloaded per item
    # from /item/<PART> and converted via FreeCAD (thorlabs-component-import
    # skill). Naming: thorlabs_<part-lowercased-with-_>.
    {"name": "thorlabs_io_3_850_hp_stl",    "asset_type": "stl", "file_path": "uploads/thorlabs_io_3_850_hp.stl",    "source": "FreeCAD STEP export", "source_url": "https://www.thorlabs.com/item/IO-3-850-HP",    "unit": "mm", "scale_factor": 1.0},
    {"name": "thorlabs_io_3d_850_vlp_stl",  "asset_type": "stl", "file_path": "uploads/thorlabs_io_3d_850_vlp.stl",  "source": "FreeCAD STEP export", "source_url": "https://www.thorlabs.com/item/IO-3D-850-VLP",  "unit": "mm", "scale_factor": 1.0},
    {"name": "thorlabs_io_5_850_hp_stl",    "asset_type": "stl", "file_path": "uploads/thorlabs_io_5_850_hp.stl",    "source": "FreeCAD STEP export", "source_url": "https://www.thorlabs.com/item/IO-5-850-HP",    "unit": "mm", "scale_factor": 1.0},
    {"name": "thorlabs_io_5_850_vlp_stl",   "asset_type": "stl", "file_path": "uploads/thorlabs_io_5_850_vlp.stl",   "source": "FreeCAD STEP export", "source_url": "https://www.thorlabs.com/item/IO-5-850-VLP",   "unit": "mm", "scale_factor": 1.0},
    {"name": "thorlabs_iot_5_850_mp_stl",   "asset_type": "stl", "file_path": "uploads/thorlabs_iot_5_850_mp.stl",   "source": "FreeCAD STEP export", "source_url": "https://www.thorlabs.com/item/IOT-5-850-MP",   "unit": "mm", "scale_factor": 1.0},
    {"name": "thorlabs_iot_5_850_vlp_stl",  "asset_type": "stl", "file_path": "uploads/thorlabs_iot_5_850_vlp.stl",  "source": "FreeCAD STEP export", "source_url": "https://www.thorlabs.com/item/IOT-5-850-VLP",  "unit": "mm", "scale_factor": 1.0},
]


COMPONENTS = [
    {
        "name": "optical_table_1",
        "component_type": "optical_table",
        "brand": "Newport",
        "model": "RS4000 1200x3600x457 + S-2000A",
        "asset": "primitive_table",
        "properties": {
            "geometry": "newport_rs4000_table",
            "dimensionsMm": [3600, 1200, 457],
            "topHeightMm": 860,
            "holeGrid": [144, 48],
            "thread": "M6",
            "isolatorModel": "S-2000A",
            "isolatorCount": 6,
        },
        "object": {
            "name": "optical_table_1_object_1",
            "x_mm": 0,
            "y_mm": 0,
            "z_mm": 0,
            "visible": True,
            "locked": False,
        },
    },
    {
        "name": "vacuum_chamber_1",
        "component_type": "vacuum_chamber",
        "brand": "QMEM",
        "model": "Rb-memory-cell",
        "asset": "primitive_chamber",
        "properties": {"geometry": "vacuum_chamber", "radiusMm": 150, "heightMm": 220},
        "object": {"x_mm": 500, "y_mm": 220, "z_mm": 110, "rz_deg": 0},
        "state": {"pressurePa": 0.00002, "temperatureC": 24.2},
    },
    {
        "name": "laser_852nm_1",
        "component_type": "laser",
        "brand": "Toptica",
        "model": "DL pro 852",
        "asset": "primitive_box",
        "properties": {"geometry": "laser", "wavelengthNm": 852, "dimensionsMm": [260, 90, 80]},
        "object": {"x_mm": -650, "y_mm": -220, "z_mm": 55, "rz_deg": 0},
        "state": {"enabled": True, "powerMw": 18.5, "wavelengthNm": 852},
    },
    {
        "name": "laser_894nm_1",
        "component_type": "laser",
        "brand": "Toptica",
        "model": "DL pro 894",
        "asset": "primitive_box",
        "properties": {"geometry": "laser", "wavelengthNm": 894, "dimensionsMm": [260, 90, 80]},
        "object": {"x_mm": -650, "y_mm": 180, "z_mm": 55, "rz_deg": 0},
        "state": {"enabled": True, "powerMw": 12.0, "wavelengthNm": 894},
    },
    {
        "name": "mirror_001",
        "component_type": "mirror",
        "brand": "Thorlabs",
        "model": "PF10-03-P01",
        "asset": "primitive_mirror",
        "properties": {"geometry": "mirror", "diameterMm": 25.4},
        "object": {"x_mm": -220, "y_mm": -220, "z_mm": 90, "rz_deg": 45},
    },
    {
        "name": "mirror_002",
        "component_type": "mirror",
        "brand": "Thorlabs",
        "model": "PF10-03-P01",
        "asset": "primitive_mirror",
        "properties": {"geometry": "mirror", "diameterMm": 25.4},
        "object": {"x_mm": 120, "y_mm": 180, "z_mm": 90, "rz_deg": -45},
    },
    {
        "name": "lens_001",
        "component_type": "lens",
        "brand": "Edmund Optics",
        "model": "AC254-150-B",
        "asset": "primitive_lens",
        "properties": {"geometry": "lens", "focalLengthMm": 150, "diameterMm": 25.4},
        "object": {"x_mm": 180, "y_mm": -220, "z_mm": 95, "rz_deg": 0},
    },
    {
        "name": "aom_001",
        "component_type": "aom",
        "brand": "Gooch & Housego",
        "model": "AOMO 3080",
        "asset": "primitive_box",
        "properties": {"geometry": "aom", "frequencyMHz": 80, "dimensionsMm": [110, 70, 70]},
        "object": {"x_mm": -20, "y_mm": -220, "z_mm": 65, "rz_deg": 0},
        "state": {"enabled": True, "rfPowerDbm": 24.0},
    },
    {
        "name": "eom_9ghz_001",
        "component_type": "eom",
        "brand": "Qubig",
        "model": "PM-C9G",
        "asset": "primitive_box",
        "properties": {"geometry": "eom", "frequencyGHz": 9.192, "dimensionsMm": [140, 80, 70]},
        "object": {"x_mm": 330, "y_mm": -220, "z_mm": 65, "rz_deg": 0},
        "state": {"enabled": True, "rfPowerDbm": 19.8},
    },
    {
        # Generic EOSpace fiber-coupled phase modulator catalog entry (library-only,
        # no scene object). Dimensions match a typical EOSpace slim-bar package;
        # user can replace with a specific PM-0K1-* / PM-0S5-* / PM-AV*-* variant
        # via the Object panel after dragging into the scene.
        "name": "eom_eospace_pm_nir",
        "component_type": "eom",
        "brand": "EOSpace",
        "model": "PM-0K1-NIR (generic)",
        "asset": "primitive_box",
        "properties": {
            "geometry": "eom",
            "dimensionsMm": [140, 30, 30],
            "sourceUrl": "https://www.eospace.com/phase-modulator",
        },
    },
    {
        # AA Optoelectronic MT80-A1.5-IR — 80 MHz center freq, 1.5 mm aperture,
        # IR (700..1100 nm) Bragg-regime AOM. For the model used in the
        # digital twin: L = 25 mm, v_a = 4200 m/s, n ≈ 2.26.
        # Equations follow https://en.wikipedia.org/wiki/Acousto-optic_modulator —
        # Bragg condition 2*Λ*sin(θ_B)=λ/n, deflection θ=λf/v_a, ±1 order
        # frequency shift ±f_acoustic.
        "name": "aa_optoelectronic_mt80_a1_5_ir",
        "component_type": "aom",
        "brand": "AA Optoelectronic",
        "model": "MT80-A1.5-IR",
        # GLB carries the real housing geometry (input/output through-holes,
        # internal TeO₂ crystal, top SMA stub). The procedural `createAom`
        # primitive is a fallback only for environments without the GLB.
        "asset": "aom_aa_mt80_glb",
        "properties": {
            "geometry": "aom",
            "centerFrequencyMhz": 80,
            "modulationBandwidthMhz": 15,
            "activeApertureMm": 1.5,
            "clearApertureMm": 3.9,
            "wavelengthRangeNm": [700, 1100],
            "material": "TeO2",
            "acousticMode": "longitudinal",
            "regime": "bragg",
            "refractiveIndex": 2.26,
            "acousticVelocityMPerS": 4200,
            "crystalLengthMm": 25.0,
            "figureOfMeritM2": 34e-15,
            "acousticBeamWidthMm": 1.5,
            # Body +Y is laser -> 0th, body -X is transducer -> absorber,
            # and body +/-Z is perpendicular to the outline drawing.
            "acousticAxisBodyLocal": [-1, 0, 0],
            "rfPropagationDirectionBodyLocal": [-1, 0, 0],
            "braggAngularAcceptanceMrad": 2.0,
            "diffractionEfficiencyTypical": 0.85,
            "rfPowerMaxW": 2.0,
            "diffractionOrder": 1,
            "riseTimeNs": 150,
            "polarization": "linear",
            # Outline drawing (PRO 004) values: 59.5 × 22.4 × 17.3 mm housing,
            # body length 50.9, optical axis 8 mm above bottom and 18 mm in
            # from each end, ø3.9 clear aperture, SMA top connector at 11.2 mm
            # transverse offset, 2× M2.5 mounting holes (depth 2.5 mm).
            "dimensionsMm": [59.5, 22.4, 17.3],
            "bodyLengthMm": 50.9,
            "opticalAxisHeightMm": 8,
            "opticalAxisFromEndMm": 18,
            "rfConnector": "SMA",
            "rfConnectorOffsetMm": 11.2,
            "mountingHolesM": 2.5,
            "mountingHoleDepthMm": 2.5,
            "sourceUrl": "https://aaoptoelectronic.com/mt80-a1-5-ir/",
            "physicsReferenceUrl": "https://en.wikipedia.org/wiki/Acousto-optic_modulator",
        },
        "physics_capabilities": ["optical", "rf"],
        "notes": (
            "Acousto-optic modulator (Bragg cell, TeO2 longitudinal mode). "
            "Bragg condition: 2*Lambda_a*sin(theta_B) = lambda/n. The deflected "
            "selected +/-1 order is frequency-shifted by +/-f_acoustic; deflection "
            "angle theta = lambda*f/v_a. MT80-A1.5-IR is modeled in the thick-grating "
            "Bragg regime, so only 0th plus the selected +/-1st order carry meaningful "
            "power; the opposite first order is drawn as a suppressed sideband and higher "
            "orders are omitted. RF/acoustic propagation direction controls which physical "
            "side is +1 versus -1. Diffraction efficiency "
            "eta = sin^2((pi*L/(2*lambda*cos(theta_B)))*sqrt(2*M2*P_d/W))."
        ),
    },
    {
        # Toptica TA-0690-0500-2 tapered amplifier chip — quote QO2603250001,
        # NT$142,000 (HC Photonics, 2026-03-25). Single-pass amplifier for
        # 675..695 nm; full 250 mW output only inside 680..690 nm. M² typ < 1.5,
        # max amplifier current 1.1 A. Limited life-time, no warranty outside
        # 680..690 nm.
        "name": "toptica_ta_0690_0500_2",
        "component_type": "tapered_amplifier",
        "brand": "TOPTICA Photonics",
        "model": "TA-0690-0500-2",
        "asset": "primitive_box",
        "properties": {
            "geometry": "tapered_amplifier",
            "wavelengthRangeNm": [675, 695],
            "wavelengthFullPowerNm": [680, 690],
            "outputPowerMaxMw": 250,
            "outputPowerOutsideBandMw": 200,
            "inputPowerRangeMw": [5, 40],
            "maxAmplifierCurrentMa": 1100,
            "mSquaredTypical": 1.5,
            "polarization": "linear",
            "passes": "single",
            "form": "chip_on_heatsink",
            "compatibleSystem": "TOPTICA BoosTA",
            "dimensionsMm": [60, 30, 25],
            "sourceUrl": (
                "https://www.toptica.com/products/laser-diodes-and-amplifiers/"
                "tapered-amplifier-chips"
            ),
            "quoteRef": "HCP QO2603250001 / 1TR20260325001",
            "purchasePriceTwd": 142000,
            "vendor": "HC Photonics Corp.",
        },
        "physics_capabilities": ["optical"],
        "notes": (
            "Toptica TA chip for single-pass amplification at 675..695 nm. "
            "Full output 250 mW; outside 680..690 nm max 200 mW. Input must "
            "be linearly polarized 5..40 mW. M^2 typ < 1.5. Max amplifier "
            "current 1100 mA. Optical-chain model: small-signal gain "
            "G0 = exp(g0*L); saturated output "
            "P_out = P_sat * ln(1 + (P_in/P_sat)*(G0-1)) + ASE."
        ),
    },
    {
        # TOPTICA BoosTA pro — full optical-amplifier MODULE (chip + heat
        # management + beam-shaping optics + housing). Drives up to +20 dB
        # on a linearly-polarised seed, with a "high-bandwidth current
        # modulation board" inside; feedback-loopable for power locking.
        # Geometry from the official 8-page technical drawing
        # (TOPTICA, 20.03.2024, sheet 1/8 .. 8/8): outer envelope
        # 275 × 115 × 90 mm, optical axis 47 mm above the bottom of the
        # housing, mounting-clamp channels (depth 5 mm) along both sides.
        # The seed enters the BACKWARD port and the amplified beam exits
        # the FORWARD port; ASE leaks out BOTH faces even without a seed.
        "name": "toptica_boosta_pro",
        "component_type": "tapered_amplifier",
        "brand": "TOPTICA Photonics",
        "model": "BoosTA pro",
        # Real GLB from TOPTICA — includes housing colours, panel features,
        # and screw heads. Frontend's loadAssetObject dispatches by asset
        # extension, so this skips the procedural createBoostaProModule
        # path. The procedural mesh is kept as a fallback for environments
        # where the GLB is missing.
        "asset": "toptica_boosta_pro_glb",
        "properties": {
            "geometry": "boosta_pro_module",
            "dimensionsMm": [275, 115, 90],
            "opticalAxisHeightMm": 47,  # above bottom of housing
            "wavelengthRangeNm": [630, 1090],  # full BoosTA pro range
            "outputPowerMaxMw": 3000,
            "gainMaxDb": 20,
            "maxAmplifierCurrentMa": 5000,  # DLC BoosTA pro HP goes to 7000
            "polarization": "linear",
            "form": "module",
            "seedPort": "backward",
            "outputPort": "forward",
            "mountingClampChannelDepthMm": 5,
            "sourceUrl": "https://www.toptica.com/products/laser-diodes-and-amplifiers/optical-amplifiers/boosta-pro",
        },
        # No `object` field — BoosTA pro is a CATALOG TEMPLATE only. Drag
        # from the Components panel to instantiate. Avoids cluttering the
        # active scene every time seed.py re-runs.
        "physics_capabilities": ["optical"],
        "notes": (
            "TOPTICA BoosTA pro — boxed tapered amplifier with internal "
            "current-modulation board, 20 dB max gain, linear polarisation. "
            "Default seed port: backward (-X face), output port: forward "
            "(+X face). Optical axis 47 mm above the housing floor. With "
            "no seed the chip emits broadband ASE in BOTH directions; with "
            "seed the backward emission is partly suppressed as the gain "
            "medium is extracted by the seed."
        ),
    },
    {
        "name": "rf_generator_001",
        "component_type": "rf_generator",
        "brand": "Rohde & Schwarz",
        "model": "SMB100A",
        "asset": "primitive_box",
        "properties": {"geometry": "rf_generator", "dimensionsMm": [280, 220, 100]},
        "object": {"x_mm": -610, "y_mm": 500, "z_mm": 60, "rz_deg": 0},
        "state": {"enabled": True, "frequencyGHz": 9.192, "powerDbm": 5.0},
    },
    {
        "name": "rf_amp_001",
        "component_type": "rf_amplifier",
        "brand": "Mini-Circuits",
        "model": "ZHL-42W+",
        "asset": "primitive_box",
        "properties": {
            "geometry": "rf_amplifier",
            "dimensionsMm": [180, 140, 70],
            "datasheetUrl": "https://www.minicircuits.com/pdfs/ZHL-42W+.pdf",
            "frequencyRangeMhz": [10.0, 4200.0],
            "gainDb": 33.0,
            "outputPowerP1dbDbm": 30.0,
            "outputPowerMaxDbm": 30.0,
            "supplyVoltageV": 15.0,
            "supplyCurrentA": 0.8,
            "connectorType": "sma",
            "physics_capabilities": ["rf"],
            "notes": (
                "Mini-Circuits ZHL-42W+ — 10 MHz to 4.2 GHz coaxial amplifier, "
                "33 dB typ gain, +30 dBm typ output, +15 V supply, SMA female "
                "on each end (rf_in / rf_out)."
            ),
        },
        "object": {"x_mm": -250, "y_mm": 500, "z_mm": 50, "rz_deg": 0},
        "state": {"enabled": True, "temperatureC": 33.5, "rfPowerDbm": 28.2},
    },
    {
        "name": "rf_amp_zhl_1_2w_plus_001",
        "component_type": "rf_amplifier",
        "brand": "Mini-Circuits",
        "model": "ZHL-1-2W+",
        "asset": "primitive_box",
        "properties": {
            "geometry": "rf_amplifier",
            # Approximate envelope of the heatsink variant: 108 mm length
            # (flange-to-flange), 50 mm width across the heatsink base, and
            # 50 mm total height including the fins.
            "dimensionsMm": [108, 50, 50],
            "datasheetUrl": "https://www.minicircuits.com/pdfs/ZHL-1-2W+.pdf",
            "frequencyRangeMhz": [5.0, 500.0],
            "gainDb": 29.0,
            "outputPowerP1dbDbm": 29.0,
            "outputPowerMaxDbm": 30.0,
            "inputPowerMaxDbm": 0.0,
            "noiseFigureDb": 9.0,
            "supplyVoltageV": 24.0,
            "supplyCurrentA": 0.6,
            "connectorType": "sma",
            "physics_capabilities": ["rf"],
            "notes": (
                "Mini-Circuits ZHL-1-2W+ — coaxial high-power amplifier, "
                "5 to 500 MHz, +30 dBm rated output (~2 W), 29 dB min gain "
                "(30 dB typ), 9 dB NF typ, +24 V at 0.6 A typ. SMA female "
                "on each end; rf_in on the +X face, rf_out on the -X face. "
                "+24V / GND feedthrough posts on the +Y face."
            ),
        },
        "object": {"x_mm": -250, "y_mm": 620, "z_mm": 50, "rz_deg": 0},
        "state": {"enabled": True, "temperatureC": 35.0, "rfPowerDbm": 28.5},
    },
    {
        "name": "thorlabs_post_holder_ph50em",
        "component_type": "post_holder",
        "brand": "Thorlabs",
        "model": "PH50E/M",
        "asset": "primitive_thorlabs_post_holder",
        "properties": {
            "geometry": "thorlabs_post_holder",
            "series": "Half-inch pedestal post holder",
            "diameterMm": 12.7,
            "heightMm": 54.7,
            "baseDiameterMm": 31.8,
            "thumbscrew": "5 mm spring-loaded hex-locking thumbscrew",
            "sourceUrl": "https://www.thorlabs.com/half-inch-post-holders?aID=4063768eebb43d2e49d40f1ce64ce7a8&aC=2",
        },
        "object": {"x_mm": 680, "y_mm": -280, "z_mm": 0, "rz_deg": 0},
    },
    {
        "name": "thorlabs_post_tr50m",
        "component_type": "optical_post",
        "brand": "Thorlabs",
        "model": "TR50/M",
        "asset": "primitive_thorlabs_post",
        "properties": {
            "geometry": "thorlabs_post",
            "diameterMm": 12.7,
            "heightMm": 50,
            "material": "303 stainless steel",
            "topThread": "M4",
            "bottomThread": "M6",
            "sourceUrl": "https://www.thorlabs.com/optical-posts-half-inch-and-12-mm?tabName=Overview",
        },
        "object": {"x_mm": 760, "y_mm": -280, "z_mm": 0, "rz_deg": 0},
    },
    {
        "name": "thorlabs_clamping_fork_cf038cm_p5",
        "component_type": "clamping_fork",
        "brand": "Thorlabs",
        "model": "CF038C/M-P5",
        "asset": "primitive_thorlabs_clamping_fork",
        "properties": {
            "geometry": "thorlabs_clamping_fork",
            "slotLengthMm": 10.2,
            "slotWidthMm": 10.2,
            "screw": "M6 x 1.0 captive screw",
            "package": "5 pack",
            "material": "303 stainless steel",
            "sourceUrl": "https://www.thorlabs.com/clamping-forks-for-pedestal-posts?pn=CF038C%2FM-P5&tabName=Overview",
        },
        "object": {"x_mm": 840, "y_mm": -280, "z_mm": 0, "rz_deg": 0},
    },
    {
        "name": "thorlabs_clamping_fork_cf175cm_p5_edrawing",
        "component_type": "clamping_fork_3d_model",
        "brand": "Thorlabs",
        "model": "CF175C/M-P5",
        "asset": "thorlabs_cf175cm_p5_edrawing",
        "properties": {
            "geometry": "edrawing_html",
            "slotLengthMm": 44.4,
            "screw": "M6 x 1.0 captive screw",
            "package": "5 pack",
            "modelViewer": "eDrawing HTML",
            "sourceUrl": "https://media.thorlabs.com/globalassets/items/c/cf/cf1/cf175c_m/ttn026566-e0w.html?v=0116105356",
        },
        "object": {"x_mm": 930, "y_mm": -280, "z_mm": 0, "rz_deg": 0},
    },
    {
        "name": "thorlabs_clamping_fork_cf175cm_p5",
        "component_type": "clamping_fork",
        "brand": "Thorlabs",
        "model": "CF175C/M-P5",
        "asset": "thorlabs_cf175cm_p5_stl",
        "properties": {
            "geometry": "stl_mesh",
            "slotLengthMm": 44.4,
            "screw": "M6 x 1.0 captive screw",
            "package": "5 pack",
            "sourceStep": "uploads/603e2c4d-fe81-497d-9953-9440f722f102_cf175c_m-p5-step.step",
            "sourceUrl": "https://www.thorlabs.com/item/CF175C_M-P5?aID=4063768eebb43d2e49d40f1ce64ce7a8&aC=2",
            "edrawingUrl": "https://media.thorlabs.com/globalassets/items/c/cf/cf1/cf175c_m/ttn026566-e0w.html?v=0116105356",
        },
        "object": {"x_mm": 1040, "y_mm": -280, "z_mm": 0, "rz_deg": 0},
    },
    {
        # Thorlabs LA1614-B — N-BK7 plano-convex lens. component_type
        # "lens_plano_convex" maps to the new ElementKind via
        # OPTICAL_COMPONENT_TYPE_TO_KIND so auto-register attaches a
        # plano-convex optical row with focalMm=150, transmission=0.99
        # (see DEFAULT_KIND_PARAMS in routers/components.py). Material
        # and AR-coating range live in `properties` for future spectral
        # filtering. Object is parked in front of the laser path —
        # user can drag it into a real beam line in the viewer.
        "name": "thorlabs_lens_la1614_b",
        "component_type": "lens_plano_convex",
        "brand": "Thorlabs",
        "model": "LA1614-B",
        "asset": "thorlabs_la1614_b_stl",
        "properties": {
            "geometry": "stl_mesh",
            "focalLengthMm": 150,
            "diameterMm": 12.7,
            "material": "N-BK7",
            "arCoatingRangeNm": [650, 1050],
            "sourceStep": "uploads/LA1614-B-Step.step",
            "sourceUrl": "https://www.thorlabs.com/item/LA1614-B",
        },
        "object": {"x_mm": 700, "y_mm": -120, "z_mm": 0, "rz_deg": 0},
    },
    {
        # Thorlabs LA1540-B — N-BK7 plano-convex, Ø1/2", f = 15 mm.
        # Short-focal companion to LA1614-B for tight focusing setups.
        "name": "thorlabs_lens_la1540_b",
        "component_type": "lens_plano_convex",
        "brand": "Thorlabs",
        "model": "LA1540-B",
        "asset": "thorlabs_la1540_b_stl",
        "properties": {
            "geometry": "stl_mesh",
            "focalLengthMm": 15,
            "diameterMm": 12.7,
            "material": "N-BK7",
            "arCoatingRangeNm": [650, 1050],
            "sourceStep": "uploads/LA1540-B-Step.step",
            "sourceUrl": "https://www.thorlabs.com/item/LA1540-B",
        },
        "object": {"x_mm": 760, "y_mm": -120, "z_mm": 0, "rz_deg": 0},
    },
    {
        # Thorlabs KS1 — Ø1" Precision Kinematic Mirror Mount, 3 adjusters.
        # Holds Ø1" (25.4 mm) unmounted optics via included retaining ring.
        # Pure mechanical mount: no OPTICAL_COMPONENT_TYPE_TO_KIND mapping,
        # so auto-register is skipped — renders as STL only.
        "name": "thorlabs_mirror_mount_ks1",
        "component_type": "mirror_mount",
        "brand": "Thorlabs",
        "model": "KS1",
        "asset": "thorlabs_ks1_stl",
        "properties": {
            "geometry": "stl_mesh",
            "opticDiameterMm": 25.4,
            "adjusters": 3,
            "retainingRing": True,
            "sourceStep": "uploads/KS1-Step.step",
            "sourceUrl": "https://www.thorlabs.com/item/KS1",
        },
    },
    {
        # Thorlabs KS1T — SM1-Threaded Ø1" Precision Kinematic Mirror Mount,
        # 3 adjusters. Internal SM1 threading lets it hold SM1-threaded
        # optics directly (no retaining ring needed).
        "name": "thorlabs_mirror_mount_ks1t",
        "component_type": "mirror_mount",
        "brand": "Thorlabs",
        "model": "KS1T",
        "asset": "thorlabs_ks1t_stl",
        "properties": {
            "geometry": "stl_mesh",
            "opticDiameterMm": 25.4,
            "adjusters": 3,
            "internalThread": "SM1",
            "sourceStep": "uploads/KS1T-Step.step",
            "sourceUrl": "https://www.thorlabs.com/item/KS1T",
        },
    },
    {
        # Coherent TORNOS Faraday Isolator — 850 nm / 4 mm aperture (added
        # 2026-05-12 from coherent.com TORNOS datasheet). Internal optics
        # are two optically-contacted PBS cubes with a Faraday rotator in
        # between (the same PBS+FR+PBS structure the user described for the
        # isolator kind redesign). No public STEP file in the datasheet —
        # uses primitive_box as a placeholder with the real Ø22.0 × 51.4 mm
        # cylinder bounding box. colorHex pulls the EOT/Newport vintage red
        # anodized aluminium look (renderer respects properties.colorHex as
        # a per-component override; isolator default stays #1a1a1c).
        # forwardLossDb = -10 * log10(0.95) ≈ 0.22 for the spec ≥95% T.
        "name": "coherent_tornos_850_4",
        "component_type": "isolator",
        "brand": "Coherent",
        "model": "TORNOS-850-4",
        "asset": "primitive_box",
        "properties": {
            "geometry": "isolator",
            "diameterMm": 22.0,
            "lengthMm": 51.4,
            "dimensionsMm": [22.0, 51.4, 22.0],
            "centerWavelengthNm": 850.0,
            "transmissionPercent": 95.0,
            "isolationDb": 33.0,
            "clearApertureMm": 4.0,
            "maxPowerW": 5.0,
            "housing": "tornos_compact_cylinder",
            "isTandem": False,
            "colorHex": "#b8211b",
            "datasheetUrl": "https://www.coherent.com/lasers/components-accessories",
            "isolatorKindParamsOverride": {
                "isolationDb": 33.0,
                "forwardLossDb": 0.22,
            },
        },
    },
]


# ---- Bulk Thorlabs imports (Phase 1: placeholder registration) ----
# Source: https://www.thorlabs.com/clamping-forks-for-pedestal-posts (all /item/ links).
# -P5 5-pack variants intentionally skipped (same model as single-pack).
# Real STEP -> STL CAD pipeline runs on demand per item via thorlabs-component-import skill.

# Per-part lengths (mm) for Ø25.0 mm RS-series pedestal pillar posts & spacers.
# Pillar-post catalog numbers encode length in inches (RS<inches>P...): RS05P=0.5",
# RS075P=0.75", RS1P=1", RS1.5P=1.5", RS2P=2", RS2.5P=2.5", RS3P=3", RS3.5P=3.5",
# RS4P=4", RS6P=6". The Thorlabs sheet lists their actual lengths in mm — those
# values (not raw inch×25.4) are used here.
_RS_PILLAR_LENGTHS = {
    "RS05P": 12.5, "RS075P": 19.0, "RS1P": 25.0, "RS1.5P": 38.0, "RS2P": 50.0,
    "RS2.5P": 65.0, "RS3P": 75.0, "RS3.5P": 90.0, "RS4P": 100.0, "RS6P": 155.0,
}
_RS_LENGTHS_MM: dict[str, float] = {}
for _stem, _len in _RS_PILLAR_LENGTHS.items():
    _RS_LENGTHS_MM[f"{_stem}4M"] = _len   # M4-tapped variant
    _RS_LENGTHS_MM[f"{_stem}_M"] = _len   # M6-tapped variant (RS*P/M)
# M6-tap post spacers: RS<L>/M = Ø25 mm spacer L mm thick (4–10 mm range)
for _n in (4, 5, 6, 7, 8, 9, 10):
    _RS_LENGTHS_MM[f"RS{_n}_M"] = float(_n)
# Thin post spacers RS*M (no slash): thickness in mm, 1–10 mm
for _n in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10):
    _RS_LENGTHS_MM[f"RS{_n}M"] = float(_n)

_THORLABS_BULK = [
    # (part_number, component_type, asset, x_mm, y_mm)
    ("MSC1", "mounting_clamp", "primitive_box", -680, -380),
    ("MSC2", "mounting_clamp", "primitive_box", -590, -380),
    ("MSC3", "mounting_clamp", "primitive_box", -500, -380),
    ("MBE1", "bench_enhancement", "primitive_box", -410, -380),
    ("SBE1", "bench_enhancement", "primitive_box", -320, -380),
    ("SBE1_M", "bench_enhancement", "primitive_box", -230, -380),
    ("SBE2", "bench_enhancement", "primitive_box", -140, -380),
    ("SBE2_M", "bench_enhancement", "primitive_box", -50, -380),
    ("BE1", "bench_enhancement", "primitive_box", 40, -380),
    ("BE1_M", "bench_enhancement", "primitive_box", 130, -380),
    ("BE1R", "bench_enhancement", "primitive_box", 220, -380),
    ("BE1R_M", "bench_enhancement", "primitive_box", 310, -380),
    ("SCF1", "clamping_fork", "primitive_thorlabs_clamping_fork", 400, -380),
    ("CF125", "clamping_fork", "primitive_thorlabs_clamping_fork", -680, -460),
    ("CF125C", "clamping_fork", "primitive_thorlabs_clamping_fork", -590, -460),
    ("CF125C_M", "clamping_fork", "primitive_thorlabs_clamping_fork", -500, -460),
    ("CF175", "clamping_fork", "primitive_thorlabs_clamping_fork", -410, -460),
    ("CF175C", "clamping_fork", "primitive_thorlabs_clamping_fork", -320, -460),
    ("CF175C_M", "clamping_fork", "primitive_thorlabs_clamping_fork", -230, -460),
    ("PF85B", "pedestal_fork", "primitive_box", -140, -460),
    ("PF125B", "pedestal_fork", "primitive_box", -50, -460),
    ("PF175B", "pedestal_fork", "primitive_box", 40, -460),
    ("PB4", "pedestal_base", "primitive_box", 130, -460),
    ("PB4R", "pedestal_base", "primitive_box", 220, -460),
    ("PB4_M", "pedestal_base", "primitive_box", 310, -460),
    ("PB4R_M", "pedestal_base", "primitive_box", 400, -460),
    ("POLARIS-CA1", "polaris_clamping_arm", "primitive_box", -680, -540),
    ("POLARIS-CA1_M", "polaris_clamping_arm", "primitive_box", -590, -540),
    ("POLARIS-CA25_M", "polaris_clamping_arm", "primitive_box", -500, -540),
    ("POLARIS-CA5", "polaris_clamping_arm", "primitive_box", -410, -540),
    ("POLARIS-CA5_M", "polaris_clamping_arm", "primitive_box", -320, -540),
    ("POLARIS-CA5C", "polaris_clamping_arm", "primitive_box", -230, -540),
    ("POLARIS-CA5C_M", "polaris_clamping_arm", "primitive_box", -140, -540),
    ("POLARIS-SCA1", "polaris_clamping_arm", "primitive_box", -50, -540),
    ("POLARIS-SCA1_M", "polaris_clamping_arm", "primitive_box", 40, -540),
    ("POLARIS-SCA25_M", "polaris_clamping_arm", "primitive_box", 130, -540),
    ("TBP", "pedestal_post", "primitive_thorlabs_post", -680, -620),
    ("TBP_M", "pedestal_post", "primitive_thorlabs_post", -590, -620),
    ("TBP_M-JP", "pedestal_post", "primitive_thorlabs_post", -500, -620),
    ("TBP05", "pedestal_post", "primitive_thorlabs_post", -410, -620),
    ("TBP05_M", "pedestal_post", "primitive_thorlabs_post", -320, -620),
    ("TBP05_M-JP", "pedestal_post", "primitive_thorlabs_post", -230, -620),
    ("RBP", "pedestal_post", "primitive_thorlabs_post", -140, -620),
    ("RBP_M", "pedestal_post", "primitive_thorlabs_post", -50, -620),
    ("RBP1", "pedestal_post", "primitive_thorlabs_post", 40, -620),
    ("RBP1_M", "pedestal_post", "primitive_thorlabs_post", 130, -620),
    ("RBP2", "pedestal_post", "primitive_thorlabs_post", 220, -620),
    ("RBP2_M", "pedestal_post", "primitive_thorlabs_post", 310, -620),
    # ---- Mirrors / coated optics (added 2026-05-01) ----
    ("BB1-E03", "mirror", "primitive_mirror", -680, -700),
    # ---- Polarising beamsplitters (added 2026-05-04) ----
    ("PBS252", "beam_splitter", "primitive_box", -590, -700),
    # ---- Waveplates (added 2026-05-04) ----
    ("WPHSM05-850", "waveplate", "primitive_lens", -500, -700),
    # ---- Fiber patch cables (consolidated 2026-05-09) ----
    # The procedural FC connector renderer differentiates jacket colour
    # (SM yellow / PM blue) and per-end polish (PC flat boot vs APC
    # green boot + 8° tip), giving 6 visual archetypes total. Catalog
    # is reduced to the 6 representative 780 nm Thorlabs items that
    # cover all (fiberType × polish-combo) variants. x=None y=None
    # marks library-only — drag the template onto the scene to place;
    # cable length is then variable via the Bezier spline editor.
    ("P1-780A-FC-1", "fiber", "primitive_box", None, None),    # SM, PC/PC
    ("P5-780Y-FC-1", "fiber", "primitive_box", None, None),    # SM, PC/APC hybrid
    ("P3-780A-FC-1", "fiber", "primitive_box", None, None),    # SM, APC/APC
    ("P1-780PM-FC-1", "fiber", "primitive_box", None, None),   # PM, PC/PC
    ("P5-780PM-FC-1", "fiber", "primitive_box", None, None),   # PM, PC/APC hybrid
    ("P3-780PM-FC-1", "fiber", "primitive_box", None, None),   # PM, APC/APC
    # ---- Optical Posts (added 2026-05-08) ----
    # Source: https://www.thorlabs.com/optical-posts-half-inch-and-12-mm
    # All catalog-only (x=None y=None) to avoid scene clutter; STL upgrades
    # come from thorlabs_bulk_cad.py manifest. -P5 5-pack variants skipped
    # (same model as single-pack).
    # TR series (Imperial, 1/2" optical posts)
    ("TR075", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR1", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR1.5", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR2", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR3", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR4", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR6", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR8", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR10", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR12", "optical_post", "primitive_thorlabs_post", None, None),
    # TR series (Metric M6, 12 mm posts)
    ("TR20_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR30_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR40_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR50_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR75_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR100_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR150_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR200_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR250_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR300_M", "optical_post", "primitive_thorlabs_post", None, None),
    # TR Metric Japan-region variants
    ("TR20_M-JP", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR30_M-JP", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR40_M-JP", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR50_M-JP", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR75_M-JP", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR100_M-JP", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR150_M-JP", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR200_M-JP", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR250_M-JP", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR300_M-JP", "optical_post", "primitive_thorlabs_post", None, None),
    # TR Vacuum-compatible variants (V suffix)
    ("TR20V_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR30V_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR40V_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR50V_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR75V_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR075V", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR1V", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR1.5V", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR2V", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR3V", "optical_post", "primitive_thorlabs_post", None, None),
    # PLS-HC studded mounting posts (high clearance, M6 stud)
    ("PLS-HC246_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("PLS-HC373_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("PLS-HC496_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("PLS-HC1", "optical_post", "primitive_thorlabs_post", None, None),
    ("PLS-HC15", "optical_post", "primitive_thorlabs_post", None, None),
    ("PLS-HC2", "optical_post", "primitive_thorlabs_post", None, None),
    # PLS-H studded mounting posts (1/4"-20 stud)
    ("PLS-H246_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("PLS-H373_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("PLS-H496_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("PLS-H1", "optical_post", "primitive_thorlabs_post", None, None),
    ("PLS-H15", "optical_post", "primitive_thorlabs_post", None, None),
    ("PLS-H2", "optical_post", "primitive_thorlabs_post", None, None),
    # TH tapped posts (8-32 / M4 tapped through hole)
    ("TH15_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TH20_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TH060", "optical_post", "primitive_thorlabs_post", None, None),
    ("TH075", "optical_post", "primitive_thorlabs_post", None, None),
    # TR-E threaded post adapters (1/4"-20 stud + M6 tapped end)
    ("TR50E_M", "post_adapter", "primitive_thorlabs_post", None, None),
    ("TR75E_M", "post_adapter", "primitive_thorlabs_post", None, None),
    ("TR2E", "post_adapter", "primitive_thorlabs_post", None, None),
    ("TR3E", "post_adapter", "primitive_thorlabs_post", None, None),
    # TRT/TRC posts (T = tapped, C = clamping)
    ("TRT2_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TRT2", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR75T_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR75C_M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR3T", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR3C", "optical_post", "primitive_thorlabs_post", None, None),
    # TRA threaded post adapters (Metric)
    ("TRA20_M", "post_adapter", "primitive_thorlabs_post", None, None),
    ("TRA30_M", "post_adapter", "primitive_thorlabs_post", None, None),
    ("TRA40_M", "post_adapter", "primitive_thorlabs_post", None, None),
    ("TRA50_M", "post_adapter", "primitive_thorlabs_post", None, None),
    ("TRA75_M", "post_adapter", "primitive_thorlabs_post", None, None),
    ("TRA100_M", "post_adapter", "primitive_thorlabs_post", None, None),
    ("TRA150_M", "post_adapter", "primitive_thorlabs_post", None, None),
    # TRA threaded post adapters (Imperial)
    ("TRA075", "post_adapter", "primitive_thorlabs_post", None, None),
    ("TRA1", "post_adapter", "primitive_thorlabs_post", None, None),
    ("TRA1.5", "post_adapter", "primitive_thorlabs_post", None, None),
    ("TRA2", "post_adapter", "primitive_thorlabs_post", None, None),
    ("TRA3", "post_adapter", "primitive_thorlabs_post", None, None),
    ("TRA4", "post_adapter", "primitive_thorlabs_post", None, None),
    ("TRA6", "post_adapter", "primitive_thorlabs_post", None, None),
    # TRxM clamping (M-series) posts
    ("TR1M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR2M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR3M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR4M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR5M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR6M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR7M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR8M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR9M", "optical_post", "primitive_thorlabs_post", None, None),
    ("TR10M", "optical_post", "primitive_thorlabs_post", None, None),
    # SPW501 spanner wrench (tool, listed on the same overview page)
    ("SPW501", "tool", "primitive_box", None, None),
    # ---- Half-inch Post Holders (added 2026-05-08) ----
    # Source: https://www.thorlabs.com/half-inch-post-holders
    # PH series (Metric, 12 mm post holders)
    ("PH20_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH30_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH40_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH50_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH75_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH100_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH150_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    # PH series (Imperial, 1/2" post holders)
    ("PH1", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH1.5", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH2", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH3", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH4", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH6", "post_holder", "primitive_thorlabs_post_holder", None, None),
    # PH Vacuum-compatible (V suffix)
    ("PH20V_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH30V_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH40V_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH50V_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH75V_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH1V", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH1.5V", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH2V", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH3V", "post_holder", "primitive_thorlabs_post_holder", None, None),
    # PH Pedestal-style (E suffix, larger flat base)
    ("PH20E_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH30E_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH40E_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH50E_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH75E_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH100E_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH150E_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH082E", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH1E", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH1.5E", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH2E", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH3E", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH4E", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("PH6E", "post_holder", "primitive_thorlabs_post_holder", None, None),
    # CF038 Compact Clamping Forks (single-screw flat fork)
    ("CF038", "clamping_fork", "primitive_thorlabs_clamping_fork", None, None),
    ("CF038C", "clamping_fork", "primitive_thorlabs_clamping_fork", None, None),
    ("CF038C_M", "clamping_fork", "primitive_thorlabs_clamping_fork", None, None),
    # UPHA universal post-holder adapter
    ("UPHA", "post_holder", "primitive_thorlabs_post_holder", None, None),
    # TS series tower stand mounts (alternative to post holder for taller stacks)
    ("TS6H_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("TS25H", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("TS6HV_M", "post_holder", "primitive_thorlabs_post_holder", None, None),
    ("TS25HV", "post_holder", "primitive_thorlabs_post_holder", None, None),
    # ---- NIR Free-Space Isolators 850 nm (scope reduced 2026-05-12) ----
    # Source: https://www.thorlabs.com/nir-free-space-isolators-690---1080-nm
    # Only 850 nm kept; other wavelengths removed at user request. Catalog-
    # only (None, None) — drag from library to place. Per-part STL assets
    # via thorlabs-component-import skill (FreeCAD STEP export).
    ("IO-3D-850-VLP",  "isolator", "thorlabs_io_3d_850_vlp_stl",  None, None),
    ("IO-3-850-HP",    "isolator", "thorlabs_io_3_850_hp_stl",    None, None),
    ("IO-5-850-VLP",   "isolator", "thorlabs_io_5_850_vlp_stl",   None, None),
    ("IOT-5-850-VLP",  "isolator", "thorlabs_iot_5_850_vlp_stl",  None, None),
    ("IOT-5-850-MP",   "isolator", "thorlabs_iot_5_850_mp_stl",   None, None),
    ("IO-5-850-HP",    "isolator", "thorlabs_io_5_850_hp_stl",    None, None),
    # ---- Ø25.0 mm Pedestal Pillar Posts & Spacers (added 2026-05-11) ----
    # Source: https://www.thorlabs.com/1-inch-25.0-mm-pedestal-pillar-posts
    # Metric Ø25.0 mm variants only; Ø1" imperial siblings, Ø24/24.5 mm thin
    # spacers, and -P5 5-pack variants intentionally skipped. Catalog-only
    # (None, None) — drag from library to place. STEP/STL CAD on demand via
    # thorlabs-component-import skill per item.
    # RS*P4M — Ø25.0 mm Pedestal Pillar Posts, M4 Taps
    ("RS05P4M", "pedestal_post", "primitive_thorlabs_post", None, None),
    ("RS075P4M", "pedestal_post", "primitive_thorlabs_post", None, None),
    ("RS1P4M", "pedestal_post", "primitive_thorlabs_post", None, None),
    ("RS1.5P4M", "pedestal_post", "primitive_thorlabs_post", None, None),
    ("RS2P4M", "pedestal_post", "primitive_thorlabs_post", None, None),
    ("RS2.5P4M", "pedestal_post", "primitive_thorlabs_post", None, None),
    ("RS3P4M", "pedestal_post", "primitive_thorlabs_post", None, None),
    ("RS3.5P4M", "pedestal_post", "primitive_thorlabs_post", None, None),
    ("RS4P4M", "pedestal_post", "primitive_thorlabs_post", None, None),
    ("RS6P4M", "pedestal_post", "primitive_thorlabs_post", None, None),
    # RS*P/M — Ø25.0 mm Pedestal Pillar Posts, M6 Taps
    ("RS05P_M", "pedestal_post", "primitive_thorlabs_post", None, None),
    ("RS075P_M", "pedestal_post", "primitive_thorlabs_post", None, None),
    ("RS1P_M", "pedestal_post", "primitive_thorlabs_post", None, None),
    ("RS1.5P_M", "pedestal_post", "primitive_thorlabs_post", None, None),
    ("RS2P_M", "pedestal_post", "primitive_thorlabs_post", None, None),
    ("RS2.5P_M", "pedestal_post", "primitive_thorlabs_post", None, None),
    ("RS3P_M", "pedestal_post", "primitive_thorlabs_post", None, None),
    ("RS3.5P_M", "pedestal_post", "primitive_thorlabs_post", None, None),
    ("RS4P_M", "pedestal_post", "primitive_thorlabs_post", None, None),
    ("RS6P_M", "pedestal_post", "primitive_thorlabs_post", None, None),
    # RS*/M — Ø25.0 mm Post Spacers, M6 Tap
    ("RS4_M", "post_spacer", "primitive_box", None, None),
    ("RS5_M", "post_spacer", "primitive_box", None, None),
    ("RS6_M", "post_spacer", "primitive_box", None, None),
    ("RS7_M", "post_spacer", "primitive_box", None, None),
    ("RS8_M", "post_spacer", "primitive_box", None, None),
    ("RS9_M", "post_spacer", "primitive_box", None, None),
    ("RS10_M", "post_spacer", "primitive_box", None, None),
    # RS*M — Ø25.0 mm thin Post Spacers (1-10 mm thickness; sub-mm variants
    # RS01M-RS09M are Ø24.0/24.5 mm, excluded)
    ("RS1M", "post_spacer", "primitive_box", None, None),
    ("RS2M", "post_spacer", "primitive_box", None, None),
    ("RS3M", "post_spacer", "primitive_box", None, None),
    ("RS4M", "post_spacer", "primitive_box", None, None),
    ("RS5M", "post_spacer", "primitive_box", None, None),
    ("RS6M", "post_spacer", "primitive_box", None, None),
    ("RS7M", "post_spacer", "primitive_box", None, None),
    ("RS8M", "post_spacer", "primitive_box", None, None),
    ("RS9M", "post_spacer", "primitive_box", None, None),
    ("RS10M", "post_spacer", "primitive_box", None, None),
]

# Read CAD manifest produced by scripts/thorlabs_bulk_cad.py — when an
# item has status="ok" we'll prefer the real STL mesh over the
# primitive placeholder.
#
# M5 (post-P2): manifest lives inside the repo at backend/data/ so it
# can never silently desync from seed.py the way it did pre-P2 (the
# old path was `/c/repos/scripts/thorlabs_cad_manifest.json`, which
# never existed in this clone — the silent `except: pass` below
# masked it, and 180 mechanical components got linked to primitive_box
# instead of their STL meshes).
_MANIFEST_PATH = Path(__file__).resolve().parents[1] / "data" / "thorlabs_cad_manifest.json"
if not _MANIFEST_PATH.is_file():
    raise FileNotFoundError(
        f"Thorlabs CAD manifest missing at {_MANIFEST_PATH}. "
        "Either commit it (preferred — it's small, immutable, and "
        "describes which STL meshes the seed should reference) or "
        "explicitly clear ASSETS to seed without STLs. The silent "
        "fallback that produced 180 grey-box components in the pre-P2 "
        "incident has been removed by design."
    )
try:
    _THORLABS_MANIFEST: dict[str, dict] = json.loads(
        _MANIFEST_PATH.read_text(encoding="utf-8")
    )
except json.JSONDecodeError as e:
    raise ValueError(
        f"Thorlabs CAD manifest at {_MANIFEST_PATH} is unparseable: {e}. "
        "Restore it from git history or regenerate via "
        "scripts/thorlabs_bulk_cad.py."
    ) from e

for _part_key, _meta in _THORLABS_MANIFEST.items():
    if _meta.get("status") != "ok":
        continue
    _norm = _part_key.lower().replace("-", "_").replace("/", "_")
    ASSETS.append(
        {
            "name": f"thorlabs_{_norm}_stl",
            "asset_type": "stl",
            "file_path": f"uploads/thorlabs_{_norm}.stl",
            "source": "FreeCAD STEP export",
            "source_url": f"https://www.thorlabs.com/item/{_part_key}",
            "unit": "mm",
            "scale_factor": 1.0,
        }
    )

for _part, _ctype, _asset, _x, _y in _THORLABS_BULK:
    _norm = _part.lower().replace("-", "_").replace("/", "_")
    _meta = _THORLABS_MANIFEST.get(_part, {})
    _has_stl = _meta.get("status") == "ok"
    _final_asset = f"thorlabs_{_norm}_stl" if _has_stl else _asset
    _props: dict[str, object] = {
        "geometry": "stl_mesh" if _has_stl else _asset.replace("primitive_", ""),
        "sourceUrl": f"https://www.thorlabs.com/item/{_part}",
    }
    if _has_stl:
        if _meta.get("stepUrl"):
            _props["sourceStep"] = _meta["stepUrl"]
        if _meta.get("edrawingUrl"):
            _props["edrawingUrl"] = _meta["edrawingUrl"]
    # Fiber components are rendered as a procedural Bezier-spline tube with
    # PPT-style anchor + tangent-handle editing. The `fiberNodes` array
    # stores anchor positions and per-side tangent offsets in mm:
    #   - posMm:        anchor position (x, y, z) in lab mm
    #   - handleInMm:   tangent offset toward the PREVIOUS node (None for endpoint A)
    #   - handleOutMm:  tangent offset toward the NEXT node (None for endpoint B)
    # Default for a new fiber: 2 endpoints 300 mm apart, each with a single
    # tangent of length 100 mm (= 1/3 of the segment) → smooth straight line.
    if _ctype == "fiber":
        _props["geometry"] = "fiber_bezier"
        _props.setdefault("fiberNodes", [
            {"posMm": [0.0, 0.0, 50.0], "handleOutMm": [100.0, 0.0, 0.0]},
            {"posMm": [300.0, 0.0, 50.0], "handleInMm": [-100.0, 0.0, 0.0]},
        ])
        _props.setdefault("radiusMm", 1.0)
        # Per-template kindParams override — the PhysicsElement bootstrapper
        # in routers/components.py merges this into DEFAULT_KIND_PARAMS["fiber"]
        # so each catalog Thorlabs model lights up with its own spec.
        # Connector polish (PC vs APC), fiber type (PM vs SM) and design
        # wavelength come straight from the part number via the parser.
        if _part.startswith(("P1-", "P3-", "P5-")):
            _meta_fiber = _parse_fiber_meta(_part)
            _props["fiberKindParamsOverride"] = _build_fiber_override(_part)
            _props["cableLengthMm"] = float(_meta_fiber["length_m"]) * 1000.0
    # NIR Free-Space Isolators: same override pattern as fiber, but the
    # specs come from a static table because the part number doesn't
    # encode enough information (e.g. tuning range, max power, tandem
    # vs single-stage). See _ISOLATOR_SPECS above for the source data.
    if _ctype == "isolator":
        _iso_meta = _build_isolator_meta(_part)
        if _iso_meta:
            _props.update(_iso_meta)
    # Ø25.0 mm RS-series pedestal pillar posts & post spacers — feed the
    # primitive renderer the actual Thorlabs dimensions instead of the
    # 12.7 mm × 50 mm fallback. Pedestal posts get a wider flange at the
    # bottom (Ø31.8 mm × 5 mm — distinctive feature visible in product photos);
    # M-tap recess on top is M4 (Ø4.5 mm) for the *P4M variants and M6
    # (Ø6.6 mm) for the *P/M variants. Spacers are plain Ø25 mm discs.
    if _ctype == "pedestal_post" and _part in _RS_LENGTHS_MM:
        _props.setdefault("diameterMm", 25.0)
        _props.setdefault("heightMm", _RS_LENGTHS_MM[_part])
        _props.setdefault("flangeDiameterMm", 31.8)
        _props.setdefault("flangeThicknessMm", 5.0)
        _props.setdefault(
            "topTapDiameterMm",
            4.5 if _part.endswith("4M") else 6.6,
        )
    elif _ctype == "post_spacer" and _part in _RS_LENGTHS_MM:
        _props.setdefault("diameterMm", 25.0)
        _props.setdefault("heightMm", _RS_LENGTHS_MM[_part])
    _component_entry: dict[str, object] = {
        "name": f"thorlabs_{_norm}",
        "component_type": _ctype,
        "brand": "Thorlabs",
        "model": _part.replace("_M", "/M"),
        "asset": _final_asset,
        "properties": _props,
    }
    if _x is not None and _y is not None:
        _component_entry["object"] = {
            "name": f"thorlabs_{_norm}",
            "x_mm": _x,
            "y_mm": _y,
            "z_mm": 0,
            "rz_deg": 0,
        }
    COMPONENTS.append(_component_entry)


BEAM_PATHS = [
    {
        "name": "852 nm cooling/control beam",
        "wavelength_nm": 852,
        "color": "#22d3ee",
        "source": "laser_852nm_1",
        "target": "vacuum_chamber_1",
        "points": [
            [-650, -220, 95],
            [-220, -220, 95],
            [180, -220, 95],
            [330, -220, 95],
            [500, 0, 110],
            [500, 220, 110],
        ],
        "properties": {"role": "control"},
        "visible": True,
    },
    {
        "name": "894 nm signal beam",
        "wavelength_nm": 894,
        "color": "#facc15",
        "source": "laser_894nm_1",
        "target": "vacuum_chamber_1",
        "points": [
            [-650, 180, 95],
            [120, 180, 95],
            [500, 180, 110],
            [500, 220, 110],
        ],
        "properties": {"role": "signal"},
        "visible": True,
    },
]


CONNECTIONS = [
    {
        "connection_type": "rf",
        "from": "rf_generator_001",
        "from_port": "RF OUT",
        "to": "rf_amp_001",
        "to_port": "RF IN",
        "label": "9.192 GHz drive",
        "properties": {"cable": "SMA"},
    },
    {
        "connection_type": "rf",
        "from": "rf_amp_001",
        "from_port": "RF OUT",
        "to": "eom_9ghz_001",
        "to_port": "RF IN",
        "label": "EOM high power RF",
        "properties": {"cable": "SMA"},
    },
]


async def upsert_asset(session, asset_data: dict[str, object]) -> Asset3D:
    result = await session.scalars(select(Asset3D).where(Asset3D.name == asset_data["name"]))
    asset = result.first()
    if asset is None:
        asset = Asset3D(**asset_data)
        session.add(asset)
    else:
        for key, value in asset_data.items():
            setattr(asset, key, value)
    return asset


async def upsert_component(
    session,
    component_data: dict[str, object],
    assets_by_name: dict[str, Asset3D],
    master_collection_id: object,
) -> Component | None:
    result = await session.scalars(select(Component).where(Component.name == component_data["name"]))
    component = result.first()
    asset_name = component_data.pop("asset")
    # `object` is optional — library-only entries (catalog without a placed
    # SceneObject) skip the scene-object upsert. Components added via the API
    # work the same way; this lets seed.py mirror that flow for entries that
    # are templates rather than instances.
    object_data = component_data.pop("object", None)
    state_data = component_data.pop("state", None)
    component_data["asset_3d_id"] = assets_by_name[asset_name].id

    if component is not None and component.archived_at is not None:
        return None

    if component is None:
        component = Component(**component_data)
        session.add(component)
        await session.flush()
    else:
        for key, value in component_data.items():
            setattr(component, key, value)

    if object_data is not None:
        result = await session.scalars(select(SceneObject).where(SceneObject.component_id == component.id))
        scene_object = result.first()
        is_new_object = scene_object is None
        if scene_object is None:
            # The DB column default is the literal 'object' string with a
            # unique constraint, which collides as soon as more than one
            # new SceneObject is created in a single seed transaction.
            # Fall back to the component name when callers didn't supply
            # an explicit object name in object_data.
            scene_object = SceneObject(
                component_id=component.id,
                name=object_data.get("name", component.name),
            )
            session.add(scene_object)
            await session.flush()
        for key, value in object_data.items():
            setattr(scene_object, key, value)

        # Mirror routers/objects.create_object: every SceneObject must belong
        # to a collection so it shows up in the Outliner. Without this, seed-
        # created objects render in the 3D view but are invisible to the
        # collection-tree UI.
        existing_member = await session.scalars(
            select(CollectionMember).where(CollectionMember.object_id == scene_object.id)
        )
        if existing_member.first() is None:
            session.add(
                CollectionMember(
                    collection_id=master_collection_id,
                    object_id=scene_object.id,
                )
            )
        elif is_new_object:
            # Defensive: shouldn't happen but harmless if it does.
            pass

        # DeviceState is keyed by object_id (alembic 0015 — per-object
        # runtime state). Lives inside the object branch because there's
        # no place to attach a state row without a SceneObject.
        if state_data is not None:
            state = await session.get(DeviceState, scene_object.id)
            if state is None:
                state = DeviceState(object_id=scene_object.id)
                session.add(state)
            state.state = state_data
    elif state_data is not None:
        print(
            f"  WARN: skipping state for catalog-only component "
            f"{component.name!r} (no object to bind DeviceState to)"
        )

    return component


async def upsert_beam_path(
    session,
    beam_data: dict[str, object],
    components_by_name: dict[str, Component],
) -> None:
    source_name = beam_data.pop("source")
    target_name = beam_data.pop("target")
    if source_name not in components_by_name or target_name not in components_by_name:
        return
    result = await session.scalars(select(BeamPath).where(BeamPath.name == beam_data["name"]))
    beam_path = result.first()
    beam_data["source_component_id"] = components_by_name[source_name].id
    beam_data["target_component_id"] = components_by_name[target_name].id

    if beam_path is None:
        session.add(BeamPath(**beam_data))
    else:
        for key, value in beam_data.items():
            setattr(beam_path, key, value)


async def upsert_connection(
    session,
    connection_data: dict[str, object],
    components_by_name: dict[str, Component],
) -> None:
    connection_data = connection_data.copy()
    from_name = connection_data.pop("from")
    to_name = connection_data.pop("to")
    if from_name not in components_by_name or to_name not in components_by_name:
        return
    result = await session.scalars(select(Connection).where(Connection.label == connection_data["label"]))
    connection = result.first()
    connection_data["from_component_id"] = components_by_name[from_name].id
    connection_data["to_component_id"] = components_by_name[to_name].id

    if connection is None:
        session.add(Connection(**connection_data))
    else:
        for key, value in connection_data.items():
            setattr(connection, key, value)


async def seed() -> None:
    async with engine.begin() as connection:
        await connection.execute(text("CREATE EXTENSION IF NOT EXISTS pgcrypto"))
        await connection.run_sync(Base.metadata.create_all)

    async with AsyncSessionLocal() as session:
        assets_by_name: dict[str, Asset3D] = {}
        for asset_data in ASSETS:
            asset = await upsert_asset(session, asset_data.copy())
            await session.flush()
            assets_by_name[asset.name] = asset

        # Outliner is keyed by collection membership — every SceneObject we
        # create here needs a CollectionMember row pointing to a collection,
        # otherwise it renders in the 3D view but is missing from the tree.
        master_collection = await get_master_collection(session)
        await session.flush()
        master_collection_id = master_collection.id

        components_by_name: dict[str, Component] = {}
        for component_data in COMPONENTS:
            component = await upsert_component(
                session, component_data.copy(), assets_by_name, master_collection_id
            )
            if component is None:
                continue
            await session.flush()
            components_by_name[component.name] = component

        for beam_data in BEAM_PATHS:
            await upsert_beam_path(session, beam_data.copy(), components_by_name)

        for connection_data in CONNECTIONS:
            await upsert_connection(session, connection_data.copy(), components_by_name)

        await session.commit()

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(seed())
    print("Seeded qmem digital twin scene.")
