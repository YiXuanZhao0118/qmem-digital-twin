"""Unit tests for solve_v3_scene — orchestrator that runs trace_ray_scene
per initial ray and serializes results.

End-to-end IO-3 isolator test lives in test_solver_v3_isolator.py.
"""

from __future__ import annotations

import math

import pytest

from app.optical import kinds  # noqa: F401  ensure ops registered
from app.optical.beam_ray import Vec3, make_beam_ray
from app.optical.pose import V3Pose
from app.optical.ray_tracer_v3 import (
    TraceOptions,
    V3AssetSnapshot,
    V3Scene,
    V3SceneObject,
    V3TransitionDescriptor,
)
from app.optical.registry import Face
from app.optical.solver_v3 import (
    V3SolverResult,
    beam_ray_to_dict,
    solve_v3_scene,
)


def lens_asset(cid: str, focal_mm: float) -> V3AssetSnapshot:
    return V3AssetSnapshot(
        catalog_id=cid,
        kind="lens",
        faces=[
            Face(id="A", position_mm_body_local=Vec3(0, 0, -1.5),
                 normal_body_local=Vec3(0, 0, -1),
                 aperture_mm=12.7, aperture_shape="circle"),
            Face(id="B", position_mm_body_local=Vec3(0, 0, 1.5),
                 normal_body_local=Vec3(0, 0, 1),
                 aperture_mm=12.7, aperture_shape="circle"),
        ],
        transitions=[V3TransitionDescriptor(in_face="A", out_face="B", op="abcd_thin_lens")],
        default_params={"focalLengthMm": focal_mm},
    )


def laser_source_asset() -> V3AssetSnapshot:
    return V3AssetSnapshot(
        catalog_id="laser_780",
        kind="laser_source",
        faces=[
            Face(id="out", position_mm_body_local=Vec3(0, 0, 0),
                 normal_body_local=Vec3(0, 0, 1),
                 aperture_mm=1, aperture_shape="circle"),
        ],
        transitions=[
            V3TransitionDescriptor(in_face="out", out_face="out", op="emit_laser_source"),
        ],
        default_params={
            "centerWavelengthNm": 780.241,
            "nominalPowerMw": 50,
        },
    )


# ---------------------------------------------------------------------------
# Single ray through a single lens scene
# ---------------------------------------------------------------------------

def test_solve_v3_single_lens_one_segment():
    scene = V3Scene(objects=[
        V3SceneObject(id="so1", asset=lens_asset("l1", 50), pose=V3Pose()),
    ])
    ray = make_beam_ray(
        origin=Vec3(0, 0, -10),
        direction=Vec3(0, 0, 1),
        wavelength_nm=780,
    )
    result = solve_v3_scene(scene, [ray])

    assert isinstance(result, V3SolverResult)
    assert len(result.segments) == 1
    assert result.segments[0].asset_catalog_id == "l1"
    assert result.segments[0].face_in_id == "A"
    assert result.segments[0].op == "abcd_thin_lens"
    assert len(result.final_rays) == 1
    assert result.errors == []


def test_solve_v3_multiple_rays():
    scene = V3Scene(objects=[
        V3SceneObject(id="so1", asset=lens_asset("l1", 50), pose=V3Pose()),
    ])
    rays = [
        make_beam_ray(origin=Vec3(0, 0, -10), direction=Vec3(0, 0, 1),
                      wavelength_nm=780),
        make_beam_ray(origin=Vec3(0, 0, -20), direction=Vec3(0, 0, 1),
                      wavelength_nm=850),
    ]
    result = solve_v3_scene(scene, rays)
    assert len(result.segments) == 2  # each ray hits the lens once
    assert len(result.final_rays) == 2


# ---------------------------------------------------------------------------
# Empty inputs
# ---------------------------------------------------------------------------

def test_solve_v3_empty_scene_warns():
    scene = V3Scene(objects=[])
    ray = make_beam_ray(origin=Vec3(0, 0, 0), direction=Vec3(0, 0, 1),
                        wavelength_nm=780)
    result = solve_v3_scene(scene, [ray])
    assert any("no objects" in w for w in result.warnings)
    assert len(result.final_rays) == 1  # ray escapes


def test_solve_v3_no_rays_warns():
    scene = V3Scene(objects=[
        V3SceneObject(id="so1", asset=lens_asset("l1", 50), pose=V3Pose()),
    ])
    result = solve_v3_scene(scene, [])
    assert any("no initial rays or laser_source emitters" in w for w in result.warnings)
    assert result.segments == []


def test_solve_v3_uses_laser_source_when_no_initial_rays():
    scene = V3Scene(objects=[
        V3SceneObject(id="laser1", asset=laser_source_asset(),
                      pose=V3Pose(z_mm=-20)),
        V3SceneObject(id="lens1", asset=lens_asset("l1", 50),
                      pose=V3Pose()),
    ])
    result = solve_v3_scene(scene, [])
    assert result.errors == []
    assert len(result.segments) == 1
    assert result.segments[0].asset_catalog_id == "l1"
    assert result.final_rays[0]["powerMw"] == pytest.approx(50, abs=1e-12)


# ---------------------------------------------------------------------------
# Serialization round-trip
# ---------------------------------------------------------------------------

def test_serialize_beam_ray():
    ray = make_beam_ray(origin=Vec3(1, 2, 3), direction=Vec3(0, 0, 1),
                        wavelength_nm=780, power_mw=2.5)
    d = beam_ray_to_dict(ray)
    assert d["origin"] == {"x": 1.0, "y": 2.0, "z": 3.0}
    assert d["direction"] == {"x": 0.0, "y": 0.0, "z": 1.0}
    assert d["powerMw"] == 2.5
    assert d["wavelengthNm"] == 780.0
    assert d["jones"][0] == {"re": 1.0, "im": 0.0}
    assert d["jones"][1] == {"re": 0.0, "im": 0.0}


def test_solver_result_to_dict():
    scene = V3Scene(objects=[
        V3SceneObject(id="so1", asset=lens_asset("l1", 50), pose=V3Pose()),
    ])
    ray = make_beam_ray(origin=Vec3(0, 0, -10), direction=Vec3(0, 0, 1),
                        wavelength_nm=780)
    result = solve_v3_scene(scene, [ray])
    d = result.to_dict()
    assert "runId" in d
    assert "segments" in d
    assert "finalRays" in d
    assert d["segments"][0]["op"] == "abcd_thin_lens"


# ---------------------------------------------------------------------------
# Options propagate through
# ---------------------------------------------------------------------------

def test_solve_v3_max_steps_warns():
    scene = V3Scene(objects=[
        V3SceneObject(id="so1", asset=lens_asset("l1", 50), pose=V3Pose()),
    ])
    ray = make_beam_ray(origin=Vec3(0, 0, -10), direction=Vec3(0, 0, 1),
                        wavelength_nm=780)
    result = solve_v3_scene(scene, [ray], TraceOptions(max_steps=0))
    assert any("max_steps" in w for w in result.warnings)
