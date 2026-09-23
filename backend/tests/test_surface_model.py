"""Phase 0 of docs/surface-optics.md: the ``assets_3d.surface_model`` column.

Schema validation (``SurfaceModelV3``) and the PUT round-trip on
``/api/v3/assets3d/{key}``, including the lock guard. The route tests swap the
DB session for a fake and ``_fetch_asset_by_key`` for a transient row, so no
Postgres is needed.
"""

from __future__ import annotations

import copy
import uuid

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.db import get_session
from app.main import app
from app.models.hardware import Asset3D
from app.routers import v3_catalog
from app.schemas_v3 import Asset3DV3Update, SurfaceModelV3

_X = {"x": 0, "y": 0, "z": 1}
_Y = {"x": 0, "y": 1, "z": 0}


def _surface(sid, z, front, back, **extra):
    return {
        "id": sid,
        "positionMmBodyLocal": {"x": 0, "y": 0, "z": z},
        "axisXBodyLocal": _X,
        "axisYBodyLocal": _Y,
        "shape": {"type": "plane"},
        "aperture": {"shape": "circle", "radiusMm": 5.0},
        "front": front,
        "back": back,
        **extra,
    }


# A zero-order quartz HWP: face A (air | quartz), face B (quartz | air).
HWP = {
    "media": {"quartz": {"nO": 1.5384, "nE": 1.5474, "opticAxis": _Y}},
    "surfaces": [
        _surface("A", 0.0, "quartz", "air", coating={"type": "ar", "reflectance": 0.0025}),
        _surface("B", 0.09, "air", "quartz", coating={"type": "ar", "reflectance": 0.0025}),
    ],
}

# LA1509-B: R1 = 51.5 on face A, flat face B, N-BK7 as a constant index.
LENS = {
    "media": {"glass": {"n": 1.5168}},
    "surfaces": [
        _surface("A", 0.0, "glass", "air", shape={"type": "sphere", "radiusMm": 51.5}),
        _surface("B", 3.6, "air", "glass"),
    ],
}


def _model(src=HWP, **patch):
    m = copy.deepcopy(src)
    m.update(patch)
    return m


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("src", [HWP, LENS])
def test_valid_models_parse(src):
    SurfaceModelV3.model_validate(src)


def test_mirror_over_opaque_is_valid():
    SurfaceModelV3.model_validate({
        "surfaces": [_surface("M", 0.0, "air", "opaque",
                              coating={"type": "hr", "reflectance": 0.99})],
    })


def test_dump_round_trips_camel_case():
    dumped = SurfaceModelV3.model_validate(HWP).model_dump(by_alias=True, exclude_none=True)
    assert dumped["media"]["quartz"]["nO"] == 1.5384
    assert dumped["media"]["quartz"]["opticAxis"] == _Y
    assert dumped["surfaces"][0]["axisXBodyLocal"] == _X
    assert SurfaceModelV3.model_validate(dumped) == SurfaceModelV3.model_validate(HWP)


def _bad(model, match):
    with pytest.raises(ValidationError, match=match):
        SurfaceModelV3.model_validate(model)


def test_rejects_unknown_medium():
    m = _model()
    m["surfaces"][1]["back"] = "glass"
    _bad(m, "unknown medium 'glass'")


def test_rejects_unused_medium():
    m = _model()
    m["media"]["spare"] = {"n": 1.45}
    _bad(m, "media not used by any surface")


@pytest.mark.parametrize("reserved", ["air", "opaque"])
def test_rejects_declaring_a_reserved_medium(reserved):
    m = _model()
    m["media"][reserved] = {"n": 1.0}
    _bad(m, "reserved media ids")


def test_rejects_duplicate_surface_ids():
    m = _model()
    m["surfaces"][1]["id"] = "A"
    _bad(m, "duplicate surface ids")


def test_rejects_a_part_light_cannot_enter():
    _bad({
        "media": {"glass": {"n": 1.5}},
        "surfaces": [_surface("A", 0.0, "glass", "opaque")],
    }, "no surface touches air")


def test_rejects_same_medium_on_both_sides():
    m = _model()
    m["surfaces"][0]["back"] = "quartz"
    _bad(m, "front and back are the same medium")


def test_rejects_no_surfaces():
    _bad({"surfaces": []}, "at least one surface")


def test_rejects_non_orthogonal_axes():
    m = _model()
    m["surfaces"][0]["axisYBodyLocal"] = {"x": 0, "y": 0.6, "z": 0.8}
    _bad(m, "orthogonal")


def test_rejects_non_unit_axis():
    m = _model()
    m["surfaces"][0]["axisXBodyLocal"] = {"x": 0, "y": 0, "z": 2}
    _bad(m, "unit vectors")


@pytest.mark.parametrize("shape, match", [
    ({"type": "plane", "radiusMm": 10.0}, "a plane has no radiusMm"),
    ({"type": "sphere"}, "non-zero radiusMm"),
    ({"type": "sphere", "radiusMm": 0}, "non-zero radiusMm"),
    ({"type": "sphere", "radiusMm": 10.0, "conic": -1.0}, "belong to a conic"),
])
def test_shape_rules(shape, match):
    m = _model(LENS)
    m["surfaces"][0]["shape"] = shape
    _bad(m, match)


def test_conic_with_aspheric_terms_is_valid():
    m = _model(LENS)
    m["surfaces"][0]["shape"] = {
        "type": "conic", "radiusMm": 2.3244, "conic": -0.6, "asphericCoeffs": [1e-4, -2e-6],
    }
    SurfaceModelV3.model_validate(m)


@pytest.mark.parametrize("aperture, match", [
    ({"shape": "circle"}, "radiusMm > 0"),
    ({"shape": "rectangle", "widthMm": 10.0}, "widthMm and heightMm"),
])
def test_aperture_rules(aperture, match):
    m = _model()
    m["surfaces"][0]["aperture"] = aperture
    _bad(m, match)


@pytest.mark.parametrize("coating, match", [
    ({"type": "ar"}, "needs a reflectance"),
    ({"type": "uncoated", "reflectance": 0.1}, "takes no reflectance"),
    ({"type": "hr", "reflectance": 1.5}, "less than or equal to 1"),
    ({"type": "ar", "reflectance": 0.01, "extinctionRatioPpDb": 30}, "polarizing coating"),
])
def test_coating_rules(coating, match):
    m = _model()
    m["surfaces"][0]["coating"] = coating
    _bad(m, match)


@pytest.mark.parametrize("medium, match", [
    ({}, "exactly one of"),
    ({"n": 1.5, "material": "N-BK7"}, "exactly one of"),
    ({"nO": 1.54}, "both nO and nE"),
    ({"nO": 1.54, "nE": 1.55}, "non-zero opticAxis"),
    ({"n": 1.5, "opticAxis": _Y}, "belongs to a uniaxial"),
    ({"n": -1.5}, "greater than 0"),
    ({"n": 1.95, "faradayRotationDegPerMm": 2.5}, "go together"),
    ({"n": 1.95, "magneticAxis": _X}, "go together"),
    ({"n": 1.95, "faradayRotationDegPerMm": 2.5, "magneticAxis": {"x": 0, "y": 0, "z": 0}}, "non-zero"),
    ({"nO": 1.54, "nE": 1.55, "opticAxis": _Y, "faradayRotationDegPerMm": 2.5, "magneticAxis": _X},
     "isotropic medium only"),
])
def test_medium_rules(medium, match):
    m = _model()
    m["media"]["quartz"] = medium
    _bad(m, match)


# ---------------------------------------------------------------------------
# PUT /api/v3/assets3d/{key}
# ---------------------------------------------------------------------------

class _FakeSession:
    async def commit(self) -> None:
        pass

    async def refresh(self, obj) -> None:
        pass


def _row(locked=False):
    return Asset3D(
        id=uuid.uuid4(), catalog_id="test_hwp", name="test hwp", asset_type="glb",
        file_path="files/glb/test_hwp.glb", unit="mm", scale_factor=1.0,
        kind_id="waveplate", anchors=[], tunable_params=[], properties={},
        locked=locked,
    )


@pytest.fixture
def put(monkeypatch):
    holder = {}

    async def _fake_get_session():
        yield _FakeSession()

    async def _fake_fetch(session, key):
        return holder["row"]

    monkeypatch.setattr(v3_catalog, "_fetch_asset_by_key", _fake_fetch)
    app.dependency_overrides[get_session] = _fake_get_session
    client = TestClient(app)

    def _put(row, body):
        holder["row"] = row
        return client.put(f"/api/v3/assets3d/{row.catalog_id}", json=body)

    try:
        yield _put
    finally:
        app.dependency_overrides.pop(get_session, None)


def test_put_stores_and_returns_the_model(put):
    row = _row()
    r = put(row, {"surfaceModel": HWP})
    assert r.status_code == 200, r.text
    assert row.surface_model["media"]["quartz"]["nE"] == 1.5474
    assert row.surface_model["surfaces"][1]["coating"] == {"type": "ar", "reflectance": 0.0025}
    assert r.json()["surfaceModel"] == row.surface_model


def test_put_null_clears_and_omission_keeps(put):
    row = _row()
    row.surface_model = SurfaceModelV3.model_validate(LENS).model_dump(by_alias=True, exclude_none=True)
    kept = copy.deepcopy(row.surface_model)
    assert put(row, {"name": "renamed"}).status_code == 200
    assert row.surface_model == kept
    assert put(row, {"surfaceModel": None}).status_code == 200
    assert row.surface_model is None


def test_put_rejects_an_invalid_model(put):
    row = _row()
    bad = _model()
    bad["surfaces"][1]["back"] = "glass"
    r = put(row, {"surfaceModel": bad})
    assert r.status_code == 422
    assert row.surface_model is None


def test_locked_asset_rejects_a_surface_model(put):
    row = _row(locked=True)
    r = put(row, {"surfaceModel": HWP})
    assert r.status_code == 422
    assert "surface_model" in r.json()["detail"]
    assert row.surface_model is None


def test_update_schema_leaves_the_field_unset_when_absent():
    assert "surface_model" not in Asset3DV3Update.model_validate({"name": "x"}).model_fields_set


@pytest.mark.parametrize("kind", ["tapered_amplifier", "laser_source", "eom", "fiber"])
def test_op_only_kind_refuses_a_surface_model(put, kind):
    row = _row()
    row.kind_id = kind
    r = put(row, {"surfaceModel": HWP})
    assert r.status_code == 422
    assert "keeps its anchor op" in r.json()["detail"]
    assert row.surface_model is None
    assert put(row, {"surfaceModel": None}).status_code == 200   # clearing is always fine



def test_a_faraday_medium_is_valid():
    SurfaceModelV3.model_validate(_model(media={"quartz": {
        "n": 1.95, "faradayRotationDegPerMm": 2.5, "magneticAxis": _X}}))
