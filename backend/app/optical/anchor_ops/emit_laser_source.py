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
    jones     = polarization Jones vector, defined in the anchor's
                (axisY, axisZ) transverse basis — E_s along axisY,
                E_p along axisZ. Default (E_s = 1, E_p = 0) = linear along
                axisY; overridden by default_params.polarization
                (exRe/exIm/...) or per-instance dynamic_sources.
    qx, qy    = at the waist (Im = zR, Re = 0) from default_params
                .spatialModeX.waistUm
"""

from __future__ import annotations

import math
from typing import Any

from app.optical.anchor_tracer import V3Anchor, V3AnchorScene
from app.optical.beam_ray import BeamRay, Vec3, make_beam_ray
from app.optical.jones import jones_axis_to_lab
from app.optical.pose import dir_body_to_lab_t, point_body_to_lab_t


def _q_at_waist_mm(w0_um: float, wavelength_nm: float) -> complex:
    if w0_um <= 0 or wavelength_nm <= 0:
        return complex(0.0, 0.0)
    w0_mm = w0_um / 1000.0
    lam_mm = wavelength_nm * 1e-6
    zR_mm = math.pi * w0_mm * w0_mm / lam_mm
    return complex(0.0, zR_mm)


def _pick_polarization(dynamic: dict, default_params: dict) -> tuple[complex, complex]:
    # Per-instance polarization (SceneObject.dynamic_sources) wins over the
    # asset default. Accept both the legacy flat shape (exRe/exIm/eyRe/eyIm)
    # and the V2 beam shape (polarization.jones.{exRe,…}).
    for src in (dynamic, default_params):
        pol = (src or {}).get("polarization")
        if isinstance(pol, dict):
            j = pol.get("jones") if isinstance(pol.get("jones"), dict) else pol
            if isinstance(j, dict) and any(k in j for k in ("exRe", "exIm", "eyRe", "eyIm")):
                return (
                    complex(float(j.get("exRe", 1.0)), float(j.get("exIm", 0.0))),
                    complex(float(j.get("eyRe", 0.0)), float(j.get("eyIm", 0.0))),
                )
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

    jones_body = _pick_polarization(dynamic, default_params)
    # The Jones vector is defined in the anchor's transverse basis: jones[0]
    # = E along axisY, jones[1] = E along axisZ. Reference the s-axis to the
    # anchor's axisY so rotating the emitter's mount rotates the emitted
    # polarization with it (physical fast/pol axis, not world-up).
    jones_lab = jones_axis_to_lab(
        jones_body, anchor.axis_y_body, dir_lab,
        lambda v: dir_body_to_lab_t(v, slot_transform),
    )

    def _waist_um(axis_key: str, fallback: float) -> float:
        # Per-instance spatial mode (SceneObject.dynamic_sources) wins over the
        # asset default_params, so a per-object beam waist / divergence applies.
        for src in (dynamic, default_params):
            mode = (src or {}).get(axis_key)
            if isinstance(mode, dict) and isinstance(mode.get("waistUm"), (int, float)) and mode["waistUm"] > 0:
                return float(mode["waistUm"])
        return fallback

    w0_x = _waist_um("spatialModeX", 250.0)
    w0_y = _waist_um("spatialModeY", w0_x)
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
        if not slot.powered_on:
            continue  # instrument power off → no emission
        for anchor in slot.asset.anchors:
            if anchor.id != "intercept_out":
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


def emit_ta_ase_rays(
    scene: V3AnchorScene,
    seeded_object_ids: set[str],
) -> list[tuple[BeamRay, str, str]]:
    """Decision 6b: a ``tapered_amplifier`` with NO upstream seed emits
    broadband ASE out both facets (forward + backward), linearly polarized
    along the gain axis (anchor axisY). A *seeded* TA — one whose
    ``scene_object_id`` appears in ``seeded_object_ids`` — emits no ASE (the
    seed extracts the inversion). Emitted from the ``intercept_in`` anchor along
    ±axisX (BOTH facets); per-facet power defaults to ``default_params.ase.powerMw``
    (the catalog shape), overridable per direction by the flat
    ``aseForwardMw`` / ``aseBackwardMw`` keys.
    """
    out: list[tuple[BeamRay, str, str]] = []
    for slot in scene.slots:
        if slot.asset.kind != "tapered_amplifier":
            continue
        if not slot.powered_on:
            continue  # instrument power off → no ASE
        if slot.scene_object_id in seeded_object_ids:
            continue
        dp = slot.asset.default_params or {}
        anchor = next((a for a in slot.asset.anchors if a.id == "intercept_in"), None)
        if anchor is None:
            continue
        wl = float(dp.get("centerWavelengthNm", 780.0))
        w0 = float((dp.get("spatialModeX") or {}).get("waistUm", 250.0))
        origin_lab = point_body_to_lab_t(anchor.position_body, slot.effective_transform)
        ax = anchor.axis_x_body
        # ASE power per facet. The catalog stores it as nested ``ase.powerMw``
        # (kinds.json), so use that as the per-facet default; the flat
        # ``aseForwardMw`` / ``aseBackwardMw`` keys (when present) override it
        # per direction. Without the nested fallback a catalog TA emitted ZERO
        # ASE because the flat keys are never seeded.
        ase = dp.get("ase") if isinstance(dp.get("ase"), dict) else {}
        ase_default_mw = float(ase.get("powerMw", 0.0) or 0.0)
        for power_key, axis_body in (
            ("aseForwardMw", ax),
            ("aseBackwardMw", Vec3(-ax.x, -ax.y, -ax.z)),
        ):
            power = float(dp.get(power_key, ase_default_mw))
            if power <= 0.0:
                continue
            dir_lab = dir_body_to_lab_t(axis_body, slot.effective_transform)
            # ASE is linearly polarized along the gain axis = anchor axisY.
            # jones[0] (E_s) is referenced to axisY, so E_s=1 ⇒ field along
            # the physical gain axis regardless of beam direction / world-up.
            jones_lab = jones_axis_to_lab(
                (complex(1.0, 0.0), complex(0.0, 0.0)), anchor.axis_y_body, dir_lab,
                lambda v: dir_body_to_lab_t(v, slot.effective_transform),
            )
            ray = make_beam_ray(
                origin=origin_lab, direction=dir_lab,
                wavelength_nm=wl, power_mw=power,
            ).replaced(
                jones=jones_lab,
                qx=_q_at_waist_mm(w0, wl), qy=_q_at_waist_mm(w0, wl),
                exclude_face_key=f"{slot.scene_object_id}/{slot.binding_id}/{anchor.id}",
            )
            out.append((ray, slot.scene_object_id, slot.scene_object_id))
    return out
