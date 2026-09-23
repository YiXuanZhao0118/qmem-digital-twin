"""Phase 2 of docs/surface-optics.md: surface-model parts inside the anchor tracer.

The reference for the lens is the existing anchor path: the same LA1509,
traced once through its thick-lens op and once through its surfaces, placed
with a rotated + translated pose, must leave identically at normal incidence.
"""

from __future__ import annotations

import dataclasses
import logging
import math
from types import SimpleNamespace

import pytest

from app.optical import anchor_ops  # noqa: F401  (registers the ops)
from app.optical.anchor_tracer import (
    AnchorTraceOptions,
    V3Anchor,
    V3AnchorBindingSlot,
    V3AnchorScene,
    V3AssetAnchorSnapshot,
    trace_ray_anchor_scene,
)
from app.optical.beam_ray import Vec3, make_beam_ray
from app.optical.db_scene_loader import anchor_asset_to_snapshot
from app.optical.pose import V3Pose, dir_body_to_lab_t, point_body_to_lab_t, pose_to_transform
from app.optical.solver import solve_anchor_scene
from app.optical.surfaces import parse_surface_model

X = {"x": 1, "y": 0, "z": 0}
Y = {"x": 0, "y": 1, "z": 0}
POSE = V3Pose(x_mm=100.0, y_mm=-40.0, z_mm=25.0, rx_deg=10.0, ry_deg=-5.0, rz_deg=30.0)


def surf(sid, x, front, back, shape=None, radius=12.7, coating=None, normal=X, axis_y=Y):
    return {
        "id": sid,
        "positionMmBodyLocal": {"x": x, "y": 0, "z": 0},
        "axisXBodyLocal": normal, "axisYBodyLocal": axis_y,
        "shape": shape or {"type": "plane"},
        "aperture": {"shape": "circle", "radiusMm": radius},
        "front": front, "back": back,
        "coating": coating or {"type": "ar", "reflectance": 0.0},
    }


LA1509_SURFACES = {
    "media": {"glass": {"n": 1.5168}},
    "surfaces": [
        surf("A", 0.0, "glass", "air", shape={"type": "sphere", "radiusMm": 51.5}),
        surf("B", 3.6, "air", "glass"),
    ],
}


def anchor(aid, x=0.0, axis=Vec3(1, 0, 0)):
    return V3Anchor(
        id=aid, position_body=Vec3(x, 0, 0), axis_x_body=axis,
        axis_y_body=Vec3(0, 1, 0), axis_z_body=Vec3(0, 0, 1) if axis.x > 0 else Vec3(0, 0, -1),
        aperture_mm=0.0,
    )


def slot(asset, pose=POSE, sid="obj"):
    return V3AnchorBindingSlot(
        scene_object_id=sid, binding_id="b", asset=asset,
        effective_transform=pose_to_transform(pose),
    )


def thick_lens_op_asset():
    return V3AssetAnchorSnapshot(
        catalog_id="la1509_ops", kind="lens", anchors=[anchor("intercept_in")],
        default_params={
            "focalLengthMm": 100.0, "transmittance": 1.0,
            "radiusFrontMm": 51.5, "refractiveIndex": 1.5168, "centerThicknessMm": 3.6,
        },
    )


def surface_lens_asset(anchors=None):
    return V3AssetAnchorSnapshot(
        catalog_id="la1509_surfaces", kind="lens",
        anchors=anchors if anchors is not None else [anchor("intercept_in")],
        default_params={"focalLengthMm": 100.0},
        surface_model=parse_surface_model(LA1509_SURFACES),
    )


def on_axis_ray(pose=POSE, back_off=20.0, waist=0.8, jones=(1 + 0j, 0j)):
    t = pose_to_transform(pose)
    d = dir_body_to_lab_t(Vec3(1, 0, 0), t)
    o = point_body_to_lab_t(Vec3(-back_off, 0, 0), t)
    return make_beam_ray(origin=o, direction=d, wavelength_nm=780.0,
                         waist_radius_mm=waist, jones=jones)


def trace(scene_slots, ray):
    return trace_ray_anchor_scene(ray, V3AnchorScene(slots=scene_slots), AnchorTraceOptions())


def test_surface_lens_leaves_like_the_thick_lens_op():
    jones = (complex(0.6, 0.1), complex(0.3, -0.7))
    ops = trace([slot(thick_lens_op_asset())], on_axis_ray(jones=jones))
    srf = trace([slot(surface_lens_asset())], on_axis_ray(jones=jones))
    (a,), (b,) = ops.final_rays, srf.final_rays
    assert (a.origin - b.origin).length() < 1e-12
    assert a.direction.dot(b.direction) == pytest.approx(1.0, abs=1e-15)
    for qa, qb in ((a.qx, b.qx), (a.qy, b.qy)):
        assert qb == pytest.approx(qa, rel=1e-12)
    assert abs(b.qxy - a.qxy) < 1e-12
    assert b.path_length_mm == pytest.approx(a.path_length_mm, abs=1e-12)
    assert b.power_mw == pytest.approx(a.power_mw, abs=1e-15)
    for ja, jb in zip(a.jones, b.jones):
        assert jb == pytest.approx(ja, abs=1e-12)


def test_the_glass_is_a_segment_of_its_own():
    res = trace([slot(surface_lens_asset())], on_axis_ray())
    t = pose_to_transform(POSE)
    media = [s.medium for s in res.lab_segments]
    assert media == [None, "glass", None]     # approach, inside the lens, escape tail
    entry, glass, _tail = res.lab_segments
    assert entry.anchor_id == "A" and entry.op_kind == "lens"
    assert (glass.start - point_body_to_lab_t(Vec3(0, 0, 0), t)).length() < 1e-12
    assert (glass.end - point_body_to_lab_t(Vec3(3.6, 0, 0), t)).length() < 1e-12
    # The in-glass Q is the reduced Q just past face A: 1/Q̂ = 1/q − (n−1)/R
    # (a round beam, so the lab-frame rotation leaves it alone).
    q_at_a = complex(entry.qx_re_at_start, entry.qx_im_at_start) + 20.0
    expect = 1.0 / (1.0 / q_at_a - (1.5168 - 1.0) / 51.5)
    assert complex(glass.qx_re_at_start, glass.qx_im_at_start) == pytest.approx(expect, rel=1e-12)
    assert complex(glass.qy_re_at_start, glass.qy_im_at_start) == pytest.approx(expect, rel=1e-12)


def test_anchors_of_a_surface_model_part_are_not_hit():
    """A stray anchor on a surface-model asset (here an intercept_face mirror
    anchor in the middle of the glass) must not fire."""
    stray = anchor("intercept_face", x=1.8)
    res = trace([slot(surface_lens_asset(anchors=[stray]))], on_axis_ray())
    assert [s.medium for s in res.lab_segments] == [None, "glass", None]


def test_plate_then_mirror_back_through_the_plate():
    """Mixed scene: a surface-model plate, then an anchor-op mirror facing
    back. The returning ray is a new ray (new exclude key) and must go
    through the plate again — two in-glass segments, one each way."""
    plate = V3AssetAnchorSnapshot(
        catalog_id="plate", kind="window", anchors=[],
        surface_model=parse_surface_model({
            "media": {"glass": {"n": 1.5}},
            "surfaces": [surf("A", 0.0, "glass", "air"), surf("B", 5.0, "air", "glass")],
        }),
    )
    mirror = V3AssetAnchorSnapshot(
        catalog_id="m", kind="mirror", default_params={"reflectivity": 1.0},
        anchors=[anchor("intercept_face", axis=Vec3(-1, 0, 0))],
    )
    pose0 = V3Pose()
    slots = [slot(plate, pose0, "plate"), slot(mirror, V3Pose(x_mm=50.0), "mirror")]
    ray = make_beam_ray(origin=Vec3(-20, 0, 0), direction=Vec3(1, 0, 0), wavelength_nm=780.0)
    res = trace(slots, ray)
    glass = [s for s in res.lab_segments if s.medium == "glass"]
    assert len(glass) == 2
    assert glass[0].end.x == pytest.approx(5.0) and glass[1].end.x == pytest.approx(0.0)
    (final,) = res.final_rays
    assert final.direction.dot(Vec3(-1, 0, 0)) == pytest.approx(1.0)


def test_a_lost_ray_becomes_a_solver_warning():
    """Face A smaller than face B: a ray through the rim meets B from glass."""
    rim = V3AssetAnchorSnapshot(
        catalog_id="rimmed", kind="window", anchors=[],
        surface_model=parse_surface_model({
            "media": {"glass": {"n": 1.5}},
            "surfaces": [surf("A", 0.0, "glass", "air", radius=2.0),
                         surf("B", 5.0, "air", "glass", radius=10.0)],
        }),
    )
    ray = make_beam_ray(origin=Vec3(-20, 5, 0), direction=Vec3(1, 0, 0), wavelength_nm=780.0)
    result = solve_anchor_scene(V3AnchorScene(slots=[slot(rim, V3Pose())]), [ray])
    assert any("rimmed" in w and "'glass' side" in w for w in result.warnings)
    assert all(s["medium"] is None for s in result.to_dict()["labSegments"])


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------

def _row(kind="lens", anchors=None, surface_model=LA1509_SURFACES):
    return SimpleNamespace(
        kind_id=kind, catalog_id="row", name="row", default_params={},
        anchors=anchors if anchors is not None else [], surface_model=surface_model,
    )


def test_loader_parses_the_surface_model_even_without_anchors():
    snap = anchor_asset_to_snapshot(_row())
    assert snap is not None and snap.anchors == []
    assert [s.id for s in snap.surface_model.surfaces] == ["A", "B"]


@pytest.mark.parametrize("kind", ["tapered_amplifier", "laser_source", "detector", "fiber", "eom"])
def test_loader_ignores_a_surface_model_on_an_op_only_kind(kind):
    assert anchor_asset_to_snapshot(_row(kind=kind)) is None


def test_loader_ignores_and_logs_a_surface_model_that_does_not_validate(caplog):
    bad = {"surfaces": [surf("A", 0.0, "glass", "air")]}   # 'glass' is not declared
    with caplog.at_level(logging.WARNING):
        assert anchor_asset_to_snapshot(_row(surface_model=bad)) is None
    assert "surface_model ignored" in caplog.text


def test_loader_leaves_assets_without_a_surface_model_alone():
    stored = {
        "id": "intercept_in",
        "positionMmBodyLocal": {"x": 0, "y": 0, "z": 0},
        "axisXBodyLocal": X, "axisYBodyLocal": Y, "axisZBodyLocal": {"x": 0, "y": 0, "z": 1},
        "apertureMm": 5.0,
    }
    snap = anchor_asset_to_snapshot(_row(anchors=[stored], surface_model=None))
    assert snap.surface_model is None and [a.id for a in snap.anchors] == ["intercept_in"]


# ---------------------------------------------------------------------------
# Clear-aperture descriptor (BeamScope readout + POP)
# ---------------------------------------------------------------------------

def test_surface_lens_clips_and_reports_like_the_lens_op():
    """A beam as wide as the 12.7 mm aperture through the LA1509: the surface
    path must clip the same power as the thick-lens op (one aperture, at the
    entry plane) and carry the same descriptor — except focalLengthMm, which
    is the part's own ray-traced EFL instead of the nominal parameter."""
    wide_anchor = dataclasses.replace(anchor("intercept_in"), aperture_mm=12.7)
    ops_asset = dataclasses.replace(thick_lens_op_asset(), anchors=[wide_anchor])
    srf_asset = surface_lens_asset()
    ops = trace([slot(ops_asset)], on_axis_ray(waist=10.0))
    srf = trace([slot(srf_asset)], on_axis_ray(waist=10.0))
    a = ops.lab_segments[0].aperture_truncation
    b = srf.lab_segments[0].aperture_truncation
    assert 0.8 < a["transmittedFraction"] < 0.99
    for key in ("apertureMm", "wEffMm", "decenterMm", "transmittedFraction",
                "transmittance", "combinedFraction"):
        assert b[key] == pytest.approx(a[key], rel=1e-12, abs=1e-12), key
    assert b["focalLengthMm"] == pytest.approx(51.5 / (1.5168 - 1), rel=1e-7)
    assert srf.final_rays[0].power_mw == pytest.approx(ops.final_rays[0].power_mw, rel=1e-12)


def test_a_surface_plate_carries_no_lens_descriptor():
    plate = V3AssetAnchorSnapshot(
        catalog_id="plate", kind="window", anchors=[],
        surface_model=parse_surface_model({
            "media": {"glass": {"n": 1.5}},
            "surfaces": [surf("A", 0.0, "glass", "air"), surf("B", 5.0, "air", "glass")],
        }),
    )
    res = trace([slot(plate)], on_axis_ray())
    assert all(s.aperture_truncation is None for s in res.lab_segments)


def test_a_cylindrical_surface_lens_reports_its_clip_but_no_pop_focal_length():
    """A round-aperture Airy pattern is meaningless for a cylindrical lens:
    the descriptor keeps the clip readout but focalLengthMm = 0 (POP off)."""
    cyl = V3AssetAnchorSnapshot(
        catalog_id="cyl", kind="lens_cylindrical", anchors=[],
        surface_model=parse_surface_model({
            "media": {"glass": {"n": 1.5}},
            "surfaces": [
                {**surf("A", 0.0, "glass", "air", shape={"type": "cylinder", "radiusMm": 20.0}),
                 "aperture": {"shape": "rectangle", "widthMm": 10.0, "heightMm": 12.0}},
                {**surf("B", 3.0, "air", "glass"),
                 "aperture": {"shape": "rectangle", "widthMm": 10.0, "heightMm": 12.0}},
            ],
        }),
    )
    res = trace([slot(cyl, V3Pose())], make_beam_ray(
        origin=Vec3(-20, 0, 0), direction=Vec3(1, 0, 0), wavelength_nm=780.0, waist_radius_mm=4.0))
    at = res.lab_segments[0].aperture_truncation
    assert at["apertureMm"] == 5.0 and at["focalLengthMm"] == 0.0
    assert 0.5 < at["transmittedFraction"] < 0.99


# ---------------------------------------------------------------------------
# Faraday rotation and a waveplate's fastAxisDeg, against their ops
# ---------------------------------------------------------------------------

def _rod(faraday=True):
    medium = {"n": 1.95}
    if faraday:
        medium.update({"faradayRotationDegPerMm": 45.0 / 18.0, "magneticAxis": X})
    return parse_surface_model({
        "media": {"tgg": medium},
        "surfaces": [surf("A", -9.0, "tgg", "air"), surf("B", 9.0, "air", "tgg")],
    })


@pytest.mark.parametrize("direction", [1.0, -1.0])
def test_faraday_medium_rotates_like_the_faraday_op(direction):
    """Forward and backward: the same Jones out as faraday_anchor_op (whose
    handedness was reversed on 2026-06-12), so an isolator keeps working."""
    op_asset = V3AssetAnchorSnapshot(
        catalog_id="rot_op", kind="faraday_rotator", anchors=[anchor("optical_center")],
        default_params={"rotationDeg": 45.0, "lengthMm": 18.0, "refractiveIndex": 1.95},
    )
    srf_asset = V3AssetAnchorSnapshot(catalog_id="rot_srf", kind="faraday_rotator",
                                      anchors=[], surface_model=_rod())
    jones = (complex(0.8, 0.1), complex(-0.2, 0.55))
    ray = make_beam_ray(origin=Vec3(-30.0 * direction, 0, 0), direction=Vec3(direction, 0, 0),
                        wavelength_nm=852.0, jones=jones)
    (a,) = trace([slot(op_asset, V3Pose())], ray).final_rays
    (b,) = trace([slot(srf_asset, V3Pose())], ray).final_rays
    for ja, jb in zip(a.jones, b.jones):
        assert jb == pytest.approx(ja, abs=1e-12)
    assert b.power_mw == pytest.approx(a.power_mw, abs=1e-15)


def test_faraday_round_trip_accumulates_twice_the_rotation():
    """Non-reciprocal: out and back through 45° gives 90° — a polarization
    along s comes back along p."""
    from app.optical.surfaces import trace_element

    fwd = make_beam_ray(origin=Vec3(-30, 0, 0), direction=Vec3(1, 0, 0),
                        wavelength_nm=852.0, jones=(1 + 0j, 0j))
    (out,) = trace_element(_rod(), fwd).exits
    # Send the SAME physical field back: reversing the direction flips the
    # canonical p axis (p = d × s, s stays world z), so E_p changes sign.
    back = out.replaced(origin=Vec3(30, 0, 0), direction=Vec3(-1, 0, 0),
                        jones=(out.jones[0], -out.jones[1]))
    (ret,) = trace_element(_rod(), back).exits
    assert abs(ret.jones[0]) < 1e-12 and abs(abs(ret.jones[1]) - 1.0) < 1e-12


@pytest.mark.parametrize("where", ["default_params", "dynamic_sources"])
def test_waveplate_fast_axis_deg_turns_the_optic_axis_like_the_op(where):
    """A quartz plate (optic axis z, so the fast axis is y = the anchor's
    axisY) with fastAxisDeg = 30 must give the waveplate op's Jones for the
    retardance its own thickness makes."""
    from app.optical.surfaces.materials import UNIAXIAL

    o, e = UNIAXIAL["crystal_quartz"]
    L = 1.07
    delta_deg = math.degrees(2 * math.pi * (e.n(852.0) - o.n(852.0)) * L / (852.0 * 1e-6))
    wp_anchor = V3Anchor(id="intercept_in", position_body=Vec3(0, 0, 0), axis_x_body=Vec3(1, 0, 0),
                         axis_y_body=Vec3(0, 1, 0), axis_z_body=Vec3(0, 0, 1), aperture_mm=0.0)
    op_asset = V3AssetAnchorSnapshot(
        catalog_id="wp_op", kind="waveplate", anchors=[wp_anchor],
        default_params={"retardanceDeg": delta_deg, "fastAxisDeg": 30.0, "lengthMm": L},
    )
    model = parse_surface_model({
        "media": {"q": {"material": "crystal_quartz", "opticAxis": {"x": 0, "y": 0, "z": 1}}},
        "surfaces": [surf("A", 0.0, "q", "air"), surf("B", L, "air", "q")],
    })
    params = {"fastAxisDeg": 30.0}
    srf_asset = V3AssetAnchorSnapshot(
        catalog_id="wp_srf", kind="waveplate", anchors=[wp_anchor], surface_model=model,
        default_params=params if where == "default_params" else {},
    )
    srf_slot = V3AnchorBindingSlot(
        scene_object_id="obj", binding_id="b", asset=srf_asset,
        effective_transform=pose_to_transform(V3Pose()),
        dynamic_sources=params if where == "dynamic_sources" else None,
    )
    jones = (complex(0.8, 0.0), complex(0.6, 0.0))
    ray = make_beam_ray(origin=Vec3(-20, 0, 0), direction=Vec3(1, 0, 0), wavelength_nm=852.0, jones=jones)
    (a,) = trace([slot(op_asset, V3Pose())], ray).final_rays
    (b,) = trace([srf_slot], ray).final_rays
    for ja, jb in zip(a.jones, b.jones):
        assert jb == pytest.approx(ja, abs=1e-10)
