"""Tracer-level: the aperture_truncation descriptor on the lab segment that
enters a truncating lens (Stage 1 + the Stage 3 focalLengthMm field).

Builds a one-lens anchor scene and traces a wide beam through it, asserting the
ENTRY segment carries the full descriptor (pre-truncation power) and the
DOWNSTREAM segment carries the reduced power.
"""

import math

import pytest

from app.optical import anchor_ops  # noqa: F401  (register ops)
from app.optical.anchor_tracer import (
    AnchorTraceOptions, V3Anchor, V3AnchorBindingSlot, V3AnchorScene,
    V3AssetAnchorSnapshot, trace_ray_anchor_scene,
)
from app.optical.beam_ray import Vec3, make_beam_ray
from app.optical.pose import V3Transform


def _lens_scene(aperture_mm: float, f_mm: float, transmittance: float):
    anchor = V3Anchor(
        id="intercept_in",
        position_body=Vec3(0, 0, 0),
        axis_x_body=Vec3(0, 0, 1),     # optical axis +z
        axis_y_body=Vec3(0, 1, 0),
        axis_z_body=Vec3(1, 0, 0),
        aperture_mm=aperture_mm,
    )
    snap = V3AssetAnchorSnapshot(
        catalog_id="a230tm_b_step", kind="lens_plano_convex", anchors=[anchor],
        default_params={"focalLengthMm": f_mm, "transmittance": transmittance},
    )
    slot = V3AnchorBindingSlot(
        scene_object_id="lens0", binding_id="b0", asset=snap,
        effective_transform=V3Transform(origin=Vec3(0, 0, 0)),
    )
    return V3AnchorScene(slots=[slot])


def test_entry_segment_carries_full_descriptor():
    a, f, t = 2.475, 4.51, 0.995
    scene = _lens_scene(a, f, t)
    # Waist == aperture radius at the lens ⇒ strong, predictable clip.
    ray = make_beam_ray(
        origin=Vec3(0, 0, -0.1), direction=Vec3(0, 0, 1),
        wavelength_nm=850, waist_radius_mm=a, power_mw=1.0,
    )
    res = trace_ray_anchor_scene(ray, scene, AnchorTraceOptions())

    entry = next(s for s in res.lab_segments if s.aperture_truncation is not None)
    d = entry.aperture_truncation
    assert d["apertureMm"] == pytest.approx(a)
    assert d["focalLengthMm"] == pytest.approx(f)        # Stage 3 field
    assert d["transmittance"] == pytest.approx(t)
    t_ap = 1.0 - math.exp(-2.0)
    assert d["transmittedFraction"] == pytest.approx(t_ap, rel=1e-3)
    assert d["combinedFraction"] == pytest.approx(t_ap * t, rel=1e-3)
    # Entry segment power is PRE-truncation.
    assert entry.power_mw == pytest.approx(1.0, rel=1e-9)

    # The lens output ray is attenuated by the combined fraction.
    assert res.final_rays[0].power_mw == pytest.approx(t_ap * t, rel=1e-3)
