"""End-to-end IO-3 isolator test through the /api/v3/solver/run REST
endpoint. Uses FastAPI TestClient so the full HTTP path is exercised
including Pydantic deserialization, op dispatch, and JSON serialization
of the result.

Pre-condition: the v3 ops (polarizer, faraday, etc.) must be registered
— eager-imported by `app.optical.kinds.__init__`.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


# ---------------------------------------------------------------------------
# Scene construction (mirrors frontend ray-tracer-v3-isolator.test.ts)
# ---------------------------------------------------------------------------

POLARIZER_ASSET = {
    "catalogId": "iso_polarizer",
    "kind": "polarizer",
    "faces": [
        {"id": "A1", "positionMmBodyLocal": {"x": 0, "y": 0, "z": -1},
         "normalBodyLocal": {"x": 0, "y": 0, "z": -1},
         "apertureMm": 6, "apertureShape": "rectangle"},
        {"id": "B1", "positionMmBodyLocal": {"x": 0, "y": 0, "z": 1},
         "normalBodyLocal": {"x": 0, "y": 0, "z": 1},
         "apertureMm": 6, "apertureShape": "rectangle"},
        {"id": "A2", "positionMmBodyLocal": {"x": 0, "y": 0, "z": 1},
         "normalBodyLocal": {"x": 0, "y": 0, "z": 1},
         "apertureMm": 6, "apertureShape": "rectangle"},
        {"id": "B2", "positionMmBodyLocal": {"x": 0, "y": 0, "z": -1},
         "normalBodyLocal": {"x": 0, "y": 0, "z": -1},
         "apertureMm": 6, "apertureShape": "rectangle"},
    ],
    "transitions": [
        {"in": "A1", "out": "B1", "op": "jones_polarizer"},
        {"in": "A2", "out": "B2", "op": "jones_polarizer"},
    ],
    "defaultParams": {"transmissionAxisDegBeamLocal": 0},
}


FARADAY_ASSET = {
    "catalogId": "iso_faraday",
    "kind": "faraday_rotator",
    "faces": [
        {"id": "A1", "positionMmBodyLocal": {"x": 0, "y": 0, "z": -1},
         "normalBodyLocal": {"x": 0, "y": 0, "z": -1},
         "apertureMm": 4, "apertureShape": "circle"},
        {"id": "B1", "positionMmBodyLocal": {"x": 0, "y": 0, "z": 1},
         "normalBodyLocal": {"x": 0, "y": 0, "z": 1},
         "apertureMm": 4, "apertureShape": "circle"},
        {"id": "A2", "positionMmBodyLocal": {"x": 0, "y": 0, "z": 1},
         "normalBodyLocal": {"x": 0, "y": 0, "z": 1},
         "apertureMm": 4, "apertureShape": "circle"},
        {"id": "B2", "positionMmBodyLocal": {"x": 0, "y": 0, "z": -1},
         "normalBodyLocal": {"x": 0, "y": 0, "z": -1},
         "apertureMm": 4, "apertureShape": "circle"},
    ],
    "transitions": [
        {"in": "A1", "out": "B1", "op": "faraday_rotate"},
        {"in": "A2", "out": "B2", "op": "faraday_rotate"},
    ],
    "defaultParams": {"rotationDeg": 45, "lengthMm": 2, "refractiveIndex": 1.95},
}


ISOLATOR_COMPONENT = {
    "catalogId": "iso_3_stage",
    "bindings": [
        {"bindingId": "input_pol", "asset": POLARIZER_ASSET,
         "localPose": {"xMm": 0, "yMm": 0, "zMm": -5,
                       "rxDeg": 0, "ryDeg": 0, "rzDeg": 0}},
        {"bindingId": "faraday", "asset": FARADAY_ASSET,
         "localPose": {"xMm": 0, "yMm": 0, "zMm": 0,
                       "rxDeg": 0, "ryDeg": 0, "rzDeg": 0}},
        {"bindingId": "output_pol", "asset": POLARIZER_ASSET,
         # +45° roll about the optical Z axis (raw-XYZ binding rotation)
         # aligns the output polarizer with the 45° Faraday rotation.
         "localPose": {"xMm": 0, "yMm": 0, "zMm": 5,
                       "rxDeg": 0, "ryDeg": 0, "rzDeg": 45}},
    ],
}


def build_scene_request(initial_rays: list[dict]) -> dict:
    return {
        "scene": {
            "objects": [
                {
                    "id": "iso1",
                    "pose": {"xMm": 0, "yMm": 0, "zMm": 0,
                             "rxDeg": 0, "ryDeg": 0, "rzDeg": 0},
                    "component": ISOLATOR_COMPONENT,
                },
            ],
        },
        "initialRays": initial_rays,
        "options": {"maxSteps": 20},
    }


LASER_SOURCE_ASSET = {
    "catalogId": "laser_780",
    "kind": "laser_source",
    "faces": [
        {"id": "out", "positionMmBodyLocal": {"x": 0, "y": 0, "z": 0},
         "normalBodyLocal": {"x": 0, "y": 0, "z": 1},
         "apertureMm": 1, "apertureShape": "circle"},
    ],
    "transitions": [
        {"in": "out", "out": "out", "op": "emit_laser_source"},
    ],
    "defaultParams": {"centerWavelengthNm": 850, "nominalPowerMw": 1.0},
}


# ---------------------------------------------------------------------------
# Forward ray passes
# ---------------------------------------------------------------------------

def test_io3_forward_passes_at_full_power(client: TestClient):
    payload = build_scene_request([
        {
            "origin": {"x": 0, "y": 0, "z": -20},
            "direction": {"x": 0, "y": 0, "z": 1},
            "wavelengthNm": 850,
            "waistRadiusMm": 0.5,
            "powerMw": 1.0,
            "jones": [{"re": 1, "im": 0}, {"re": 0, "im": 0}],
        },
    ])
    resp = client.post("/api/v3/solver/run", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    # at least 3 segments (input_pol, faraday, output_pol)
    assert len(body["segments"]) >= 3
    final_powers = [r["powerMw"] for r in body["finalRays"]]
    assert max(final_powers) == pytest.approx(1.0, abs=1e-6)


# ---------------------------------------------------------------------------
# Reverse ray is blocked
# ---------------------------------------------------------------------------

def test_io3_reverse_is_blocked(client: TestClient):
    payload = build_scene_request([
        {
            "origin": {"x": 0, "y": 0, "z": 20},
            "direction": {"x": 0, "y": 0, "z": -1},
            "wavelengthNm": 850,
            "waistRadiusMm": 0.5,
            "powerMw": 1.0,
            "jones": [{"re": 1, "im": 0}, {"re": 0, "im": 0}],
        },
    ])
    resp = client.post("/api/v3/solver/run", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    final_powers = [r["powerMw"] for r in body["finalRays"]]
    # The blocked ray ends up in final_rays with power < 1e-6
    assert min(final_powers) < 1e-6


# ---------------------------------------------------------------------------
# Both rays in one request — verify batch behaviour
# ---------------------------------------------------------------------------

def test_io3_forward_and_reverse_in_single_request(client: TestClient):
    payload = build_scene_request([
        {
            "origin": {"x": 0, "y": 0, "z": -20},
            "direction": {"x": 0, "y": 0, "z": 1},
            "wavelengthNm": 850,
            "waistRadiusMm": 0.5,
            "powerMw": 1.0,
            "jones": [{"re": 1, "im": 0}, {"re": 0, "im": 0}],
        },
        {
            "origin": {"x": 0, "y": 0, "z": 20},
            "direction": {"x": 0, "y": 0, "z": -1},
            "wavelengthNm": 850,
            "waistRadiusMm": 0.5,
            "powerMw": 1.0,
            "jones": [{"re": 1, "im": 0}, {"re": 0, "im": 0}],
        },
    ])
    resp = client.post("/api/v3/solver/run", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    powers = [r["powerMw"] for r in body["finalRays"]]
    assert max(powers) == pytest.approx(1.0, abs=1e-6)  # forward
    assert min(powers) < 1e-6                            # reverse blocked


def test_solver_run_can_use_scene_laser_source_without_initial_rays(client: TestClient):
    payload = {
        "scene": {
            "objects": [
                {
                    "id": "laser1",
                    "pose": {"xMm": 0, "yMm": 0, "zMm": -20,
                             "rxDeg": 0, "ryDeg": 0, "rzDeg": 0},
                    "asset": LASER_SOURCE_ASSET,
                },
                {
                    "id": "iso1",
                    "pose": {"xMm": 0, "yMm": 0, "zMm": 0,
                             "rxDeg": 0, "ryDeg": 0, "rzDeg": 0},
                    "component": ISOLATOR_COMPONENT,
                },
            ],
        },
        "options": {"maxSteps": 20},
    }
    resp = client.post("/api/v3/solver/run", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["segments"]) >= 3
    assert max(r["powerMw"] for r in body["finalRays"]) == pytest.approx(1.0, abs=1e-6)


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------

def test_invalid_payload_returns_400(client: TestClient):
    bad = {"initialRays": []}  # missing scene
    resp = client.post("/api/v3/solver/run", json=bad)
    assert resp.status_code in (400, 422)
