"""Pytest mirror of frontend ray-tracer-v3 tests. Covers pose round-trip
and scene-level tracing parity with the frontend."""

from __future__ import annotations

import math

import pytest

from app.optical import kinds  # noqa: F401
from app.optical.beam_ray import BeamRay, Vec3, make_beam_ray
from app.optical.pose import (
    V3Pose,
    dir_body_to_lab,
    dir_lab_to_body,
    point_body_to_lab,
    point_lab_to_body,
)
from app.optical.kinds.aom_v3.physics import bragg_angle_rad
from app.optical.ray_tracer_v3 import (
    TraceOptions,
    V3AssetSnapshot,
    V3ComponentBinding,
    V3ComponentSnapshot,
    V3Scene,
    V3SceneObject,
    V3TransitionDescriptor,
    emit_scene_source_rays,
    flatten_scene,
    intersect_face,
    nearest_face_hit,
    trace_ray_scene,
    trace_ray_through_asset,
)
from app.optical.registry import Face


# ---------------------------------------------------------------------------
# Asset templates
# ---------------------------------------------------------------------------

def lens_asset(cid: str, focal_mm: float) -> V3AssetSnapshot:
    return V3AssetSnapshot(
        catalog_id=cid,
        kind="lens",
        faces=[
            Face(id="A", position_mm_body_local=Vec3(0, 0, -1.5),
                 normal_body_local=Vec3(0, 0, -1), aperture_mm=12.7, aperture_shape="circle"),
            Face(id="B", position_mm_body_local=Vec3(0, 0, 1.5),
                 normal_body_local=Vec3(0, 0, 1), aperture_mm=12.7, aperture_shape="circle"),
        ],
        transitions=[V3TransitionDescriptor(in_face="A", out_face="B", op="abcd_thin_lens")],
        default_params={"focalLengthMm": focal_mm},
    )


def mirror_asset(cid: str, reflectivity: float = 1.0) -> V3AssetSnapshot:
    return V3AssetSnapshot(
        catalog_id=cid,
        kind="mirror",
        faces=[
            Face(id="A", position_mm_body_local=Vec3(0, 0, 0),
                 normal_body_local=Vec3(0, 0, 1), aperture_mm=12.7, aperture_shape="circle"),
        ],
        transitions=[V3TransitionDescriptor(in_face="A", out_face="A", op="reflect_specular")],
        default_params={"reflectivity": reflectivity},
    )


def laser_source_asset() -> V3AssetSnapshot:
    return V3AssetSnapshot(
        catalog_id="laser_780",
        kind="laser_source",
        faces=[
            Face(id="out", position_mm_body_local=Vec3(0, 0, 0),
                 normal_body_local=Vec3(0, 0, 1), aperture_mm=1, aperture_shape="circle"),
        ],
        transitions=[
            V3TransitionDescriptor(in_face="out", out_face="out", op="emit_laser_source"),
        ],
        default_params={
            "centerWavelengthNm": 780.241,
            "nominalPowerMw": 50,
            "spatialModeX": {"waistUm": 250, "waistZOffsetMm": 0},
            "spatialModeY": {"waistUm": 80, "waistZOffsetMm": 1.2},
            "polarization": {"exRe": 1, "exIm": 0, "eyRe": 0, "eyIm": 0},
        },
    )


def laser_source_x_asset() -> V3AssetSnapshot:
    return V3AssetSnapshot(
        catalog_id="dbr_852_tosa_high_power_laser_source",
        kind="laser_source",
        faces=[
            Face(id="out", position_mm_body_local=Vec3(5.974999904632568, 0, 0),
                 normal_body_local=Vec3(1, 0, 0), aperture_mm=12.5, aperture_shape="circle"),
        ],
        transitions=[
            V3TransitionDescriptor(in_face="out", out_face="out", op="emit_laser_source"),
        ],
        default_params={
            "centerWavelengthNm": 852.347,
            "nominalPowerMw": 40,
        },
    )


def aom_asset() -> V3AssetSnapshot:
    return V3AssetSnapshot(
        catalog_id="aom_dynamic_rf",
        kind="aom",
        faces=[
            Face(id="A1", position_mm_body_local=Vec3(0, 0, -0.8),
                 normal_body_local=Vec3(0, 0, -1), aperture_mm=1, aperture_shape="circle"),
            Face(id="B1", position_mm_body_local=Vec3(0, 0, 0.8),
                 normal_body_local=Vec3(0, 0, 1), aperture_mm=1, aperture_shape="circle"),
        ],
        transitions=[
            V3TransitionDescriptor(in_face="A1", out_face="B1", op="diffract_aom", params={"order": 1}),
        ],
        default_params={
            "requiresRfDrive": True,
            "centerFreqMhz": 80,
            "acousticVelocityMps": 4200,
            "refractiveIndex": 2.26,
            "crystalLengthMm": 1.6,
            "figureOfMeritM2": 1e-10,
            "acousticBeamWidthMm": 1.5,
        },
    )


# ---------------------------------------------------------------------------
# Pose round-trip
# ---------------------------------------------------------------------------

POSE_CASES = [
    ("identity", V3Pose()),
    ("pure translation", V3Pose(x_mm=100, y_mm=-50, z_mm=25)),
    ("ry=90", V3Pose(ry_deg=90)),
    ("rx=45 ry=30 rz=10", V3Pose(x_mm=5, y_mm=10, z_mm=15, rx_deg=45, ry_deg=30, rz_deg=10)),
]


@pytest.mark.parametrize("name,pose", POSE_CASES)
def test_point_round_trip(name: str, pose: V3Pose):
    orig = Vec3(3, -2, 7)
    body = point_lab_to_body(orig, pose)
    back = point_body_to_lab(body, pose)
    assert back.x == pytest.approx(orig.x, abs=1e-9)
    assert back.y == pytest.approx(orig.y, abs=1e-9)
    assert back.z == pytest.approx(orig.z, abs=1e-9)


@pytest.mark.parametrize("name,pose", POSE_CASES)
def test_dir_round_trip(name: str, pose: V3Pose):
    orig = Vec3(0.3, -0.8, 0.5)
    body = dir_lab_to_body(orig, pose)
    back = dir_body_to_lab(body, pose)
    assert back.x == pytest.approx(orig.x, abs=1e-9)
    assert back.y == pytest.approx(orig.y, abs=1e-9)
    assert back.z == pytest.approx(orig.z, abs=1e-9)


# ---------------------------------------------------------------------------
# Frontend-parity sanity check: known transform behaviour. Uses the
# project's Euler convention THREE.Euler(rxDeg, rzDeg, -ryDeg, "YXZ"),
# documented in frames.sceneObjectToQuaternion.
# ---------------------------------------------------------------------------

def test_parity_rxDeg90_swings_z_to_y():
    """rxDeg=90 → THREE's X angle = 90 → ordinary X rotation.
    Body +z should rotate toward lab -y (right-hand rule about +x axis:
    +y→+z, +z→-y)."""
    pose = V3Pose(rx_deg=90)
    body = Vec3(0, 0, 1)
    lab = dir_body_to_lab(body, pose)
    assert lab.y == pytest.approx(-1, abs=1e-9)
    assert lab.x == pytest.approx(0, abs=1e-9)
    assert lab.z == pytest.approx(0, abs=1e-9)


# ---------------------------------------------------------------------------
# Single-asset trace (Phase 3a port)
# ---------------------------------------------------------------------------

def test_scene_laser_source_emits_initial_ray():
    scene = V3Scene(objects=[
        V3SceneObject(
            id="laser1",
            asset=laser_source_asset(),
            pose=V3Pose(x_mm=1, y_mm=2, z_mm=3),
            dynamic_sources={"centerWavelengthNm": 795, "laserPowerMw": 12},
        ),
    ])
    [ray] = emit_scene_source_rays(scene)
    assert ray.origin == Vec3(1, 2, 3)
    assert ray.direction.z == pytest.approx(1, abs=1e-12)
    assert ray.wavelength_nm == pytest.approx(795, abs=1e-12)
    assert ray.power_mw == pytest.approx(12, abs=1e-12)
    assert ray.qx.real == pytest.approx(0, abs=1e-12)
    assert ray.qy.real == pytest.approx(-1.2, abs=1e-12)


def test_scene_laser_source0_v3_shape_uses_plus_x_and_legacy_beam_dynamic_sources():
    scene = V3Scene(objects=[
        V3SceneObject(
            id="LASER_SOURCE0",
            asset=laser_source_x_asset(),
            pose=V3Pose(x_mm=-1132.1858548404816, z_mm=1920.1284444354371),
            dynamic_sources={
                "powerMw": 40,
                "spectrum": {"centerWavelengthNm": 852},
                "polarization": {
                    "basis": "beamLocalXY",
                    "jones": {"exRe": 0, "exIm": 0, "eyRe": 1, "eyIm": 0},
                    "normalization": "unit_jones",
                },
                "spatialEnvelope": {
                    "propagation": {
                        "x": {"waistZOffsetMm": 2},
                        "y": {"waistZOffsetMm": 4},
                        "model": "m2_gaussian",
                    },
                    "transverseProfile": {
                        "x": {"waistRadiusUm": 500},
                        "y": {"waistRadiusUm": 600},
                        "kind": "elliptical_gaussian",
                    },
                },
            },
        ),
    ])
    [ray] = emit_scene_source_rays(scene)
    assert ray.origin.x == pytest.approx(-1126.210854935849, abs=1e-9)
    assert ray.origin.z == pytest.approx(1920.1284444354371, abs=1e-9)
    assert ray.direction.x == pytest.approx(1, abs=1e-12)
    assert ray.wavelength_nm == pytest.approx(852, abs=1e-12)
    assert ray.power_mw == pytest.approx(40, abs=1e-12)
    assert ray.qx.real == pytest.approx(-2, abs=1e-12)
    assert ray.qy.real == pytest.approx(-4, abs=1e-12)
    assert ray.jones[0].real == pytest.approx(0, abs=1e-12)
    assert ray.jones[1].real == pytest.approx(1, abs=1e-12)


def test_laser_source_emitted_ray_can_seed_scene_tracing():
    scene = V3Scene(objects=[
        V3SceneObject(id="laser1", asset=laser_source_asset(),
                      pose=V3Pose(z_mm=-20)),
        V3SceneObject(id="lens1", asset=lens_asset("test_lens", 50),
                      pose=V3Pose()),
    ])
    [ray] = emit_scene_source_rays(scene)
    result = trace_ray_scene(ray, scene)
    assert len(result.steps) == 1
    assert result.steps[0].asset.catalog_id == "test_lens"
    assert result.final_rays[0].power_mw == pytest.approx(50, abs=1e-12)


def test_single_asset_lens_trace():
    ray = make_beam_ray(
        origin=Vec3(0, 0, -10),
        direction=Vec3(0, 0, 1),
        wavelength_nm=780,
    )
    result = trace_ray_through_asset(ray, lens_asset("test_lens", 50))
    assert len(result.steps) == 1
    assert result.steps[0].face_in.id == "A"
    assert len(result.final_rays) == 1
    out = result.final_rays[0]
    assert out.origin.z == pytest.approx(1.5, abs=1e-9)


def test_scene_dynamic_sources_reach_aom_op():
    scene = V3Scene(objects=[
        V3SceneObject(
            id="aom1",
            asset=aom_asset(),
            pose=V3Pose(),
            dynamic_sources={"aomFreqMhz": 110, "rfDrivePowerW": 0.01},
        ),
    ])
    ray = make_beam_ray(
        origin=Vec3(0, 0, -10),
        direction=Vec3(0, 0, 1),
        wavelength_nm=780,
    )
    result = trace_ray_scene(ray, scene)
    assert len(result.steps) == 1
    out = result.steps[0].out_rays[0]
    theta = bragg_angle_rad(780, 110, 4200, 2.26)
    assert out.direction.x == pytest.approx(math.sin(2 * theta), abs=1e-9)
    assert out.power_mw > 0


# ---------------------------------------------------------------------------
# Scene-level trace
# ---------------------------------------------------------------------------

def test_scene_two_lenses_in_series():
    scene = V3Scene(objects=[
        V3SceneObject(id="lens1", asset=lens_asset("lens_50", 50),
                      pose=V3Pose()),
        V3SceneObject(id="lens2", asset=lens_asset("lens_80", 80),
                      pose=V3Pose(z_mm=100)),
    ])
    ray = make_beam_ray(
        origin=Vec3(0, 0, -10),
        direction=Vec3(0, 0, 1),
        wavelength_nm=780,
    )
    result = trace_ray_scene(ray, scene, TraceOptions(max_steps=10))
    assert len(result.steps) == 2
    assert result.steps[0].asset.catalog_id == "lens_50"
    assert result.steps[1].asset.catalog_id == "lens_80"

    out = result.final_rays[0]
    assert out.origin.z == pytest.approx(101.5, abs=1e-9)


def test_scene_offaxis_lens_centers_in_body():
    scene = V3Scene(objects=[
        V3SceneObject(id="lens_off", asset=lens_asset("lens_50", 50),
                      pose=V3Pose(x_mm=5, z_mm=50)),
    ])
    ray = make_beam_ray(
        origin=Vec3(5, 0, 0),
        direction=Vec3(0, 0, 1),
        wavelength_nm=780,
    )
    result = trace_ray_scene(ray, scene)
    assert len(result.steps) == 1
    # In body frame the hit is on-axis
    assert result.steps[0].ray_in.origin.x == pytest.approx(0, abs=1e-9)
    assert result.steps[0].ray_in.origin.z == pytest.approx(-1.5, abs=1e-9)
    # In lab frame the exit is at (5, 0, 51.5)
    out = result.final_rays[0]
    assert out.origin.x == pytest.approx(5, abs=1e-9)
    assert out.origin.z == pytest.approx(51.5, abs=1e-9)


def test_scene_miss_lens_escapes():
    scene = V3Scene(objects=[
        V3SceneObject(id="lens", asset=lens_asset("lens_50", 50),
                      pose=V3Pose(z_mm=50)),
    ])
    ray = make_beam_ray(
        origin=Vec3(50, 0, 0),  # 50mm off axis
        direction=Vec3(0, 0, 1),
        wavelength_nm=780,
    )
    result = trace_ray_scene(ray, scene)
    assert len(result.steps) == 0
    assert result.terminated == "escaped"
    assert len(result.final_rays) == 1


def test_scene_lens_and_rotated_mirror():
    scene = V3Scene(objects=[
        V3SceneObject(id="lens1", asset=lens_asset("lens_50", 50),
                      pose=V3Pose()),
        V3SceneObject(id="mir1", asset=mirror_asset("flat_mirror"),
                      pose=V3Pose(z_mm=50, ry_deg=180)),
    ])
    ray = make_beam_ray(
        origin=Vec3(0, 0, -10),
        direction=Vec3(0, 0, 1),
        wavelength_nm=780,
    )
    result = trace_ray_scene(ray, scene, TraceOptions(max_steps=10))
    assert len(result.steps) >= 2
    assert result.steps[0].asset.catalog_id == "lens_50"
    assert result.steps[1].asset.catalog_id == "flat_mirror"


# ---------------------------------------------------------------------------
# Phase 3c — Component binding tree
# ---------------------------------------------------------------------------

def test_flatten_single_asset_one_slot():
    scene = V3Scene(objects=[
        V3SceneObject(id="so1", asset=lens_asset("l1", 50), pose=V3Pose()),
    ])
    slots = flatten_scene(scene)
    assert len(slots) == 1
    assert slots[0].binding_id == ""
    assert slots[0].asset.catalog_id == "l1"


def test_flatten_component_three_bindings():
    comp = V3ComponentSnapshot(
        catalog_id="c1",
        bindings=[
            V3ComponentBinding(binding_id="b1", asset=lens_asset("la", 30),
                               local_pose=V3Pose(z_mm=-10)),
            V3ComponentBinding(binding_id="b2", asset=lens_asset("lb", 50),
                               local_pose=V3Pose()),
            V3ComponentBinding(binding_id="b3", asset=lens_asset("lc", 80),
                               local_pose=V3Pose(z_mm=10)),
        ],
    )
    scene = V3Scene(objects=[V3SceneObject(id="so1", component=comp, pose=V3Pose())])
    slots = flatten_scene(scene)
    assert [s.binding_id for s in slots] == ["b1", "b2", "b3"]


def test_component_two_lenses_in_series():
    stack = V3ComponentSnapshot(
        catalog_id="stack",
        bindings=[
            V3ComponentBinding(binding_id="front", asset=lens_asset("front", 50),
                               local_pose=V3Pose(z_mm=-20)),
            V3ComponentBinding(binding_id="back", asset=lens_asset("back", 80),
                               local_pose=V3Pose(z_mm=20)),
        ],
    )
    scene = V3Scene(objects=[
        V3SceneObject(id="so1", component=stack, pose=V3Pose(z_mm=100)),
    ])
    ray = make_beam_ray(
        origin=Vec3(0, 0, 0),
        direction=Vec3(0, 0, 1),
        wavelength_nm=780,
    )
    result = trace_ray_scene(ray, scene, TraceOptions(max_steps=10))
    assert len(result.steps) == 2
    assert result.steps[0].asset.catalog_id == "front"
    assert result.steps[1].asset.catalog_id == "back"
    # Back lens face B in lab: 100 + 20 + 1.5 = 121.5
    out = result.final_rays[0]
    assert out.origin.z == pytest.approx(121.5, abs=1e-9)


def test_component_excludeface_is_binding_scoped():
    # Two lens bindings with identical face id "A" — Phase 3c scoping
    # must let the ray hit both rather than incorrectly skipping the
    # second because of the first's exit face.
    stack = V3ComponentSnapshot(
        catalog_id="two_lens",
        bindings=[
            V3ComponentBinding(binding_id="l1", asset=lens_asset("l1", 50),
                               local_pose=V3Pose()),
            V3ComponentBinding(binding_id="l2", asset=lens_asset("l2", 80),
                               local_pose=V3Pose(z_mm=20)),
        ],
    )
    scene = V3Scene(objects=[V3SceneObject(id="so1", component=stack, pose=V3Pose())])
    ray = make_beam_ray(
        origin=Vec3(0, 0, -10),
        direction=Vec3(0, 0, 1),
        wavelength_nm=780,
    )
    result = trace_ray_scene(ray, scene, TraceOptions(max_steps=10))
    assert len(result.steps) == 2
