"""Laser-source emit pass for the anchor tracer (Phase 9.3).

Unlike passive elements, a laser_source doesn't WAIT for an incoming ray
— it spawns the initial rays that seed the trace queue. This module
exposes ``emit_anchor_source_rays(scene)`` returning ``[(ray, emitter_id,
source_id), ...]`` ready to feed ``trace_ray_anchor_scene``.

Each ``emit_point`` anchor on a ``laser_source`` Asset3D emits one ray
with:
    origin    = anchor.position transformed to lab
    direction = anchor.axisX transformed to lab
    wavelength_nm = dynamic_sources.centerWavelengthNm
                    OR default_params.centerWavelengthNm
                    OR 780 (fallback)
    power_mw  = dynamic_sources.laserPowerMw / powerMw
                    OR default_params.nominalPowerMw / 1 mW fallback
    jones     = anchor's axisY direction (E_s = 1, E_p = 0) by default,
                overridden by default_params.polarization (exRe/exIm/...)
    qx, qy    = at the waist (Im = zR, Re = 0) from default_params
                .spatialModeX.waistUm
"""

from __future__ import annotations

import math
from typing import Any

from app.optical.anchor_tracer import V3Anchor, V3AnchorScene
from app.optical.beam_ray import BeamRay, Vec3, make_beam_ray
from app.optical.jones import jones_body_to_lab
from app.optical.pose import dir_body_to_lab_t, point_body_to_lab_t


def _q_at_waist_mm(w0_um: float, wavelength_nm: float) -> complex:
    if w0_um <= 0 or wavelength_nm <= 0:
        return complex(0.0, 0.0)
    w0_mm = w0_um / 1000.0
    lam_mm = wavelength_nm * 1e-6
    zR_mm = math.pi * w0_mm * w0_mm / lam_mm
    return complex(0.0, zR_mm)


def _pick_polarization(default_params: dict) -> tuple[complex, complex]:
    pol = default_params.get("polarization")
    if isinstance(pol, dict):
        ex_re = float(pol.get("exRe", 1.0))
        ex_im = float(pol.get("exIm", 0.0))
        ey_re = float(pol.get("eyRe", 0.0))
        ey_im = float(pol.get("eyIm", 0.0))
        return (complex(ex_re, ex_im), complex(ey_re, ey_im))
    return (complex(1.0, 0.0), complex(0.0, 0.0))


def _ray_from_anchor(
    anchor: V3Anchor, slot_transform, default_params: dict, dynamic: dict,
) -> BeamRay:
    origin_lab = point_body_to_lab_t(anchor.position_body, slot_transform)
    dir_lab = dir_body_to_lab_t(anchor.axis_x_body, slot_transform)

    wavelength_nm = float(
        dynamic.get("centerWavelengthNm")
        if isinstance(dynamic.get("centerWavelengthNm"), (int, float))
        else default_params.get("centerWavelengthNm", 780.0)
    )
    power_mw = float(
        dynamic.get("laserPowerMw")
        if isinstance(dynamic.get("laserPowerMw"), (int, float))
        else dynamic.get("powerMw")
        if isinstance(dynamic.get("powerMw"), (int, float))
        else default_params.get("nominalPowerMw", 1.0)
    )

    jones_body = _pick_polarization(default_params)
    jones_lab = jones_body_to_lab(
        jones_body, anchor.axis_x_body, dir_lab,
        lambda v: dir_body_to_lab_t(v, slot_transform),
    )

    w0_x = float(
        (default_params.get("spatialModeX") or {}).get("waistUm", 250.0)
    )
    w0_y = float(
        (default_params.get("spatialModeY") or {}).get("waistUm", w0_x)
    )
    qx = _q_at_waist_mm(w0_x, wavelength_nm)
    qy = _q_at_waist_mm(w0_y, wavelength_nm)

    return make_beam_ray(
        origin=origin_lab,
        direction=dir_lab,
        wavelength_nm=wavelength_nm,
        power_mw=power_mw,
    ).replaced(jones=jones_lab, qx=qx, qy=qy)


def emit_anchor_source_rays(
    scene: V3AnchorScene,
) -> list[tuple[BeamRay, str, str]]:
    """Emit one ray per emit_point anchor on each laser_source slot.

    Returns list of (ray, emitter_scene_object_id, source_scene_object_id)
    tuples — same shape as the old emit_scene_source_rays_with_provenance
    so the trace queue seeding stays uniform.
    """
    out: list[tuple[BeamRay, str, str]] = []
    for slot in scene.slots:
        if slot.asset.kind != "laser_source":
            continue
        for anchor in slot.asset.anchors:
            if anchor.id != "emit_point":
                continue
            ray = _ray_from_anchor(
                anchor, slot.effective_transform,
                slot.asset.default_params, slot.dynamic_sources or {},
            )
            # Tag exclude_face_key so the laser's own anchor isn't a
            # candidate hit for its own emission.
            ray = ray.replaced(
                exclude_face_key=f"{slot.scene_object_id}/{slot.binding_id}/{anchor.id}",
            )
            out.append((ray, slot.scene_object_id, slot.scene_object_id))
    return out
