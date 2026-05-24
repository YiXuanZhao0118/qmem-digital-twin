"""Parity test — Python runs the SAME JSON fixtures the frontend vitest
runs, ensuring TS and Python ray tracers agree numerically.

Fixtures live under:
    frontend/src/optical/__tests__/parity/golden/*.json

Any divergence between TS and Python is caught by either side failing.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.optical import kinds  # noqa: F401  ensure ops registered
from app.optical.beam_ray import BeamRay, Vec3, make_beam_ray
from app.optical.ray_tracer_v3 import (
    V3AssetSnapshot,
    V3TransitionDescriptor,
    trace_ray_through_asset,
)
from app.optical.registry import Face


REPO_ROOT = Path(__file__).resolve().parents[4]
GOLDEN_DIR = REPO_ROOT / "frontend" / "src" / "optical" / "__tests__" / "parity" / "golden"


# ---------------------------------------------------------------------------
# Fixture loaders
# ---------------------------------------------------------------------------

def _vec3(d: dict) -> Vec3:
    return Vec3(float(d["x"]), float(d["y"]), float(d["z"]))


def _face(d: dict) -> Face:
    return Face(
        id=d["id"],
        position_mm_body_local=_vec3(d["positionMmBodyLocal"]),
        normal_body_local=_vec3(d["normalBodyLocal"]) if "normalBodyLocal" in d else None,
        aperture_mm=float(d["apertureMm"]),
        aperture_shape=d.get("apertureShape", "rectangle"),
    )


def _transition(d: dict) -> V3TransitionDescriptor:
    return V3TransitionDescriptor(
        in_face=d["in"],
        out_face=d["out"],
        op=d["op"],
        params=d.get("params"),
        matrix5x5=d.get("matrix5x5"),
        abcd=d.get("abcd"),
        via=tuple(d.get("via") or ()),
    )


def _asset(d: dict) -> V3AssetSnapshot:
    return V3AssetSnapshot(
        catalog_id=d["catalogId"],
        kind=d["kind"],
        faces=[_face(f) for f in d["faces"]],
        transitions=[_transition(t) for t in d["transitions"]],
        default_params=d.get("defaultParams", {}),
    )


def _ray_in(d: dict) -> BeamRay:
    base = make_beam_ray(
        origin=_vec3(d["origin"]),
        direction=_vec3(d["direction"]),
        wavelength_nm=float(d["wavelengthNm"]),
        waist_radius_mm=float(d.get("waistRadiusMm", 0.5)),
        power_mw=float(d.get("powerMw", 1.0)),
    )
    if "jones" in d:
        js = d["jones"]
        jones = (
            complex(js[0]["re"], js[0].get("im", 0.0)),
            complex(js[1]["re"], js[1].get("im", 0.0)),
        )
        base = base.replaced(jones=jones)
    return base


def _all_fixtures() -> list[tuple[str, dict]]:
    fixtures = []
    for path in sorted(GOLDEN_DIR.glob("*.json")):
        with path.open(encoding="utf-8") as fh:
            fixtures.append((path.stem, json.load(fh)))
    return fixtures


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def _run(fixture: dict) -> None:
    asset = _asset(fixture["asset"])
    ray = _ray_in(fixture["rayIn"])
    result = trace_ray_through_asset(ray, asset)

    expected = fixture["expected"]
    tol = fixture["tolerance"]

    assert len(result.final_rays) == expected["finalRayCount"], \
        f'{fixture["name"]}: finalRayCount {len(result.final_rays)} != {expected["finalRayCount"]}'

    for i, exp in enumerate(expected["rays"]):
        act = result.final_rays[i]
        assert act.origin.x == pytest.approx(exp["origin"]["x"], abs=tol["positionMm"]), \
            f'[{i}] origin.x'
        assert act.origin.y == pytest.approx(exp["origin"]["y"], abs=tol["positionMm"]), \
            f'[{i}] origin.y'
        assert act.origin.z == pytest.approx(exp["origin"]["z"], abs=tol["positionMm"]), \
            f'[{i}] origin.z'
        assert act.direction.x == pytest.approx(exp["direction"]["x"], abs=tol["directionAbs"])
        assert act.direction.y == pytest.approx(exp["direction"]["y"], abs=tol["directionAbs"])
        assert act.direction.z == pytest.approx(exp["direction"]["z"], abs=tol["directionAbs"])
        assert act.power_mw == pytest.approx(exp["powerMw"], abs=tol["powerMw"])
        assert act.wavelength_nm == exp["wavelengthNm"]
        if "pathLengthMm" in exp:
            assert act.path_length_mm == pytest.approx(
                exp["pathLengthMm"], abs=tol["positionMm"],
            )
        if "qxAfterLens" in exp:
            assert act.qx.real == pytest.approx(exp["qxAfterLens"]["re"], abs=tol["qAbs"])
            assert act.qx.imag == pytest.approx(exp["qxAfterLens"]["im"], abs=tol["qAbs"])
        if "qyAfterLens" in exp:
            assert act.qy.real == pytest.approx(exp["qyAfterLens"]["re"], abs=tol["qAbs"])
            assert act.qy.imag == pytest.approx(exp["qyAfterLens"]["im"], abs=tol["qAbs"])


@pytest.mark.parametrize("name,fixture", _all_fixtures())
def test_parity_fixture(name: str, fixture: dict):
    _run(fixture)
