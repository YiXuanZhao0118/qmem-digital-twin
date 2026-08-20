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

from app.optical.anchor_ops.misc_ops import _samples, ta_ase_table_mw
from app.optical.anchor_tracer import V3Anchor, V3AnchorScene
from app.optical.beam_ray import BeamRay, Vec3, make_beam_ray
from app.optical.jones import jones_axis_to_lab, sp_rotation_axis_to_lab
from app.optical.pose import dir_body_to_lab_t, point_body_to_lab_t


def _q_at_waist_mm(
    w0_um: float, wavelength_nm: float, m2: float = 1.0, z_offset_mm: float = 0.0,
) -> complex:
    """Embedded-Gaussian q at the emit point.

    z_R is reduced by M² (``zR = π·w₀²/(M²·λ)``) so the EMBEDDED fundamental
    Gaussian carried in q diverges at the real, M²-enhanced rate. ``Re(q) =
    -z_offset`` places the beam waist ``z_offset`` mm downstream (+axisX) of
    the emit anchor — the emit point sits ``z_offset`` before the waist.
    The real transverse width is recovered downstream by multiplying the
    q-derived embedded width by ``√(M²)`` (folded into BeamRay.width_mult).
    """
    if w0_um <= 0 or wavelength_nm <= 0:
        return complex(0.0, 0.0)
    w0_mm = w0_um / 1000.0
    lam_mm = wavelength_nm * 1e-6
    m2_eff = m2 if (m2 and m2 > 0) else 1.0
    zR_mm = math.pi * w0_mm * w0_mm / (m2_eff * lam_mm)
    return complex(-z_offset_mm, zR_mm)


def _facet_beam(
    mode_x: dict, mode_y: dict, wavelength_nm: float, fallback_w0_um: float,
) -> tuple[complex, complex, float, float, float, float]:
    """(qx, qy, m2x, m2y, width_mult_x, width_mult_y) for one TA facet.

    ASE leaves through the same facet and collimator as the amplified beam,
    so it is given that facet's waveguide mode rather than a circular guess:
    the OUTPUT facet uses ``outputSpatialModeX/Y`` (identical to what
    ``tapered_amplifier_anchor_op`` imposes on an injected beam), the SEED
    facet uses ``inputSpatialModeX/Y``. An axis with no usable waist falls
    back to ``fallback_w0_um``, keeping the legacy circular behaviour for
    assets that declare neither.
    """
    def axis(mode: dict) -> tuple[complex, float, float]:
        w0 = float(mode.get("waistUm", 0.0) or 0.0)
        if w0 <= 0.0:
            return _q_at_waist_mm(fallback_w0_um, wavelength_nm), 1.0, 1.0
        m2 = float(mode.get("mSquared", 1.0) or 1.0)
        q = _q_at_waist_mm(
            w0, wavelength_nm, m2, float(mode.get("waistZOffsetMm", 0.0) or 0.0),
        )
        # TEM00 facet: mode_factor = 1, so width_mult = sqrt(M2).
        return q, m2, math.sqrt(m2)

    qx, m2x, wmx = axis(mode_x)
    qy, m2y, wmy = axis(mode_y)
    return qx, qy, m2x, m2y, wmx, wmy


def _mode_factors(default_params: dict, dynamic: dict) -> tuple[float, float]:
    """Per-axis effective-WIDTH multiplier from the transverse mode.

    ``transverseModeType`` + ``mode_index_1`` / ``mode_index_2`` (per-instance
    dynamic_sources win over asset default_params):
      - HG: x × √(2m+1), y × √(2n+1)  (m=index_1, n=index_2)
      - LG: both axes × √(2p+|l|+1)   (p=index_1, l=index_2)
    Absent / TEM00 → (1.0, 1.0). This scales only the displayed width, not
    propagation (the donut/lobe SHAPE is not modelled by the q-tracer).
    """
    for src in (dynamic, default_params):
        mt = (src or {}).get("transverseModeType")
        if isinstance(mt, str) and mt.strip():
            i1 = int((src or {}).get("mode_index_1", 0) or 0)
            i2 = int((src or {}).get("mode_index_2", 0) or 0)
            kind = mt.strip().upper()
            if kind == "HG":
                return (math.sqrt(2 * abs(i1) + 1), math.sqrt(2 * abs(i2) + 1))
            if kind == "LG":
                f = math.sqrt(2 * abs(i1) + abs(i2) + 1)
                return (f, f)
            break
    return (1.0, 1.0)


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
    # ``nominalPowerMw`` is the asset's own param key, so a per-instance tunable
    # override (SceneObject.dynamic_sources, keyed by the asset key) is read
    # FIRST — it must win over the legacy ``powerMw``/``laserPowerMw`` aliases
    # the opticalSources beam path injects, else tuning power per-instance no-ops.
    power_mw = float(
        dynamic.get("nominalPowerMw")
        if isinstance(dynamic.get("nominalPowerMw"), (int, float))
        else dynamic.get("laserPowerMw")
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

    def _mode_field(axis_key: str, field: str, fallback: float, positive: bool) -> float:
        # Per-instance spatial mode (SceneObject.dynamic_sources) wins over the
        # asset default_params, so per-object beam waist / M² / waist offset apply.
        for src in (dynamic, default_params):
            mode = (src or {}).get(axis_key)
            if isinstance(mode, dict) and isinstance(mode.get(field), (int, float)):
                v = float(mode[field])
                if not positive or v > 0:
                    return v
        return fallback

    w0_x = _mode_field("spatialModeX", "waistUm", 250.0, positive=True)
    w0_y = _mode_field("spatialModeY", "waistUm", w0_x, positive=True)
    m2_x = _mode_field("spatialModeX", "mSquared", 1.0, positive=True)
    m2_y = _mode_field("spatialModeY", "mSquared", 1.0, positive=True)
    zoff_x = _mode_field("spatialModeX", "waistZOffsetMm", 0.0, positive=False)
    zoff_y = _mode_field("spatialModeY", "waistZOffsetMm", 0.0, positive=False)
    qx = _q_at_waist_mm(w0_x, wavelength_nm, m2_x, zoff_x)
    qy = _q_at_waist_mm(w0_y, wavelength_nm, m2_y, zoff_y)

    # Real width = embedded (q-derived) width × √(M²) × transverse-mode factor.
    fac_x, fac_y = _mode_factors(default_params, dynamic)
    width_mult_x = math.sqrt(m2_x) * fac_x
    width_mult_y = math.sqrt(m2_y) * fac_y

    # spatialModeX/Y are defined in the SAME anchor basis as the Jones vector
    # (X along axisY, Y along axisZ), so Q is built there and re-expressed in
    # the beam-local frame the ray carries it in — rotating the emitter's
    # mount now rotates its astigmatism with it, exactly like the polarization.
    return make_beam_ray(
        origin=origin_lab,
        direction=dir_lab,
        wavelength_nm=wavelength_nm,
        power_mw=power_mw,
    ).replaced(
        jones=jones_lab, qx=qx, qy=qy,
        width_mult_x=width_mult_x, width_mult_y=width_mult_y,
        m2x=m2_x, m2y=m2_y,
    ).rotated_frame(sp_rotation_axis_to_lab(
        anchor.axis_y_body, dir_lab,
        lambda v: dir_body_to_lab_t(v, slot_transform),
    ))


def emit_anchor_source_rays(
    scene: V3AnchorScene,
) -> list[tuple[BeamRay, str, str, str]]:
    """Emit one ray per emit_point anchor on each laser_source slot.

    Returns list of (ray, emitter_scene_object_id, source_scene_object_id,
    emission_key) tuples — same shape as the old
    emit_scene_source_rays_with_provenance plus the emission key, so the
    trace queue seeding stays uniform.
    """
    out: list[tuple[BeamRay, str, str, str]] = []
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
            out.append((
                ray, slot.scene_object_id, slot.scene_object_id, "main",
            ))
    return out


def emit_ta_ase_rays(
    scene: V3AnchorScene,
    seeded_object_ids: set[str],
) -> list[tuple[BeamRay, str, str, str]]:
    """Decision 6b: a ``tapered_amplifier`` with NO upstream seed emits
    broadband ASE out both facets (forward + backward), linearly polarized
    along the gain axis (anchor axisY). A *seeded* TA — one whose
    ``scene_object_id`` appears in ``seeded_object_ids`` — emits no ASE (the
    seed extracts the inversion).

    GEOMETRY: each facet emits from its OWN anchor along that anchor's outward
    normal — forward out of ``intercept_out``, backward out of ``intercept_in``.
    Assets carrying only ``intercept_in`` keep the legacy behaviour (both
    facets from that one anchor, along ±axisX).

    POWER, per facet, first match wins:
      1. the flat ``aseForwardMw`` / ``aseBackwardMw`` keys (explicit override)
      2. ``aseSamples`` interpolated at ``driveCurrentMa``
      3. the nested catalog default ``ase.powerMw``

    Each facet is also gated by its own
    ``SceneObject.properties.emissionVisuals[<key>].visible``: an emission the
    user hid is never emitted, so downstream optics stop reflecting it too.
    """
    out: list[tuple[BeamRay, str, str, str]] = []
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
        out_anchor = next(
            (a for a in slot.asset.anchors if a.id == "intercept_out"), None,
        )
        wl = float(dp.get("centerWavelengthNm", 780.0))
        legacy_w0 = float((dp.get("spatialModeX") or {}).get("waistUm", 250.0))
        ax = anchor.axis_x_body
        # Per-facet emitter: (anchor, outward direction). With both anchors
        # present each facet emits from its own; with only intercept_in we keep
        # the legacy ±axisX pair off that single anchor.
        # The 4th item is the mode prefix: forward ASE carries the OUTPUT
        # facet mode (same profile an injected beam gets), backward the seed
        # facet's own mode.
        facets = (
            [("aseForwardMw", out_anchor, out_anchor.axis_x_body, "output",
              "forward"),
             ("aseBackwardMw", anchor, ax, "input", "backward")]
            if out_anchor is not None else
            [("aseForwardMw", anchor, ax, "output", "forward"),
             ("aseBackwardMw", anchor, Vec3(-ax.x, -ax.y, -ax.z), "input",
              "backward")]
        )
        # The catalog stores ASE as nested ``ase.powerMw`` (kinds.json), so
        # that is the last-resort per-facet default — without it a catalog TA
        # emitted ZERO ASE because the flat keys are never seeded.
        ase = dp.get("ase") if isinstance(dp.get("ase"), dict) else {}
        ase_default_mw = float(ase.get("powerMw", 0.0) or 0.0)
        table = ta_ase_table_mw(
            _samples(dp, "aseSamples"), float(dp.get("driveCurrentMa", 0.0)),
        )
        table_mw = {
            "aseForwardMw": table[0] if table else None,
            "aseBackwardMw": table[1] if table else None,
        }
        visuals = slot.emission_visuals or {}
        for power_key, facet_anchor, axis_body, mode_prefix, emission_key in facets:
            power = float(
                dp.get(power_key, table_mw[power_key] if table else ase_default_mw),
            )
            if power <= 0.0:
                continue
            # Hidden by the user (Visualization card) — skip the whole
            # emission, not just its rendering.
            if (visuals.get(emission_key) or {}).get("visible") is False:
                continue
            origin_lab = point_body_to_lab_t(
                facet_anchor.position_body, slot.effective_transform,
            )
            dir_lab = dir_body_to_lab_t(axis_body, slot.effective_transform)
            # ASE is linearly polarized along the gain axis = anchor axisY.
            # jones[0] (E_s) is referenced to axisY, so E_s=1 ⇒ field along
            # the physical gain axis regardless of beam direction / world-up.
            jones_lab = jones_axis_to_lab(
                (complex(1.0, 0.0), complex(0.0, 0.0)), facet_anchor.axis_y_body, dir_lab,
                lambda v: dir_body_to_lab_t(v, slot.effective_transform),
            )
            qx, qy, m2x, m2y, wmx, wmy = _facet_beam(
                dp.get(f"{mode_prefix}SpatialModeX") or {},
                dp.get(f"{mode_prefix}SpatialModeY") or {},
                wl, legacy_w0,
            )
            ray = make_beam_ray(
                origin=origin_lab, direction=dir_lab,
                wavelength_nm=wl, power_mw=power,
            ).replaced(
                jones=jones_lab,
                qx=qx, qy=qy, m2x=m2x, m2y=m2y,
                width_mult_x=wmx, width_mult_y=wmy,
                exclude_face_key=f"{slot.scene_object_id}/{slot.binding_id}/{facet_anchor.id}",
            ).rotated_frame(sp_rotation_axis_to_lab(
                facet_anchor.axis_y_body, dir_lab,
                lambda v: dir_body_to_lab_t(v, slot.effective_transform),
            ))
            out.append((
                ray, slot.scene_object_id, slot.scene_object_id, emission_key,
            ))
    return out
