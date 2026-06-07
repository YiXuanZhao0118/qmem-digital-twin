"""Route-level tests for the upload format policy (Asset-layer M1 §A-4).

DXF (a 2D drawing) and SLDPRT (proprietary binary) are rejected at the v3
upload route with format-specific 400s; viewer-ready GLB and STEP pass the
format guard. These exercise the HTTP route's validation + row assembly
only, so ``get_session`` is overridden with an in-memory fake and the
FreeCAD converter is stubbed — the test needs neither Postgres nor FreeCAD.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import get_session
from app.main import app
from app.routers import v3_catalog
from app.services.asset_converter import CadConversionResult


class _FakeSession:
    """Just enough of ``AsyncSession`` for the upload route; never touches a
    database. ``add`` stamps the server-default ``id`` so the response model
    (which requires it) serializes without a real flush."""

    def add(self, obj) -> None:
        if getattr(obj, "id", None) is None:
            obj.id = uuid.uuid4()

    async def commit(self) -> None:
        pass

    async def rollback(self) -> None:
        pass

    async def refresh(self, obj) -> None:
        if getattr(obj, "id", None) is None:
            obj.id = uuid.uuid4()


@pytest.fixture
def client(tmp_path, monkeypatch):
    async def _fake_get_session():
        yield _FakeSession()

    # Keep uploads off the real asset tree and FreeCAD out of the loop.
    monkeypatch.setattr(settings, "asset_root", tmp_path)
    monkeypatch.setattr(
        v3_catalog,
        "convert_cad_source_to_stl",
        lambda *a, **k: CadConversionResult(
            ok=False,
            source_relative_path="",
            viewer_relative_path=None,
            viewer_asset_type=None,
            message="stubbed: no FreeCAD in tests",
        ),
    )
    app.dependency_overrides[get_session] = _fake_get_session
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_session, None)


def _upload(client: TestClient, filename: str, content: bytes = b"geometry"):
    return client.post(
        "/api/v3/assets3d/upload",
        files={"file": (filename, content, "application/octet-stream")},
        data={"catalog_id": "test_fmt_policy", "name": "test fmt policy"},
    )


@pytest.mark.parametrize(
    "filename, needle",
    [("part.dxf", "DXF is a 2D drawing"), ("part.sldprt", "SLDPRT")],
)
def test_unrenderable_cad_rejected(client, filename, needle):
    res = _upload(client, filename)
    assert res.status_code == 400
    assert needle in res.json()["detail"]


def test_glb_passes_format_guard(client):
    res = _upload(client, "part.glb")
    assert res.status_code == 201
    assert res.json()["assetType"] == "glb"


def test_step_passes_format_guard(client):
    # STEP is allowed through (not blocked like dxf/sldprt). With the FreeCAD
    # converter stubbed it is stored as the raw CAD source rather than a
    # viewer-ready type — the point is only that the format guard lets it pass.
    res = _upload(client, "part.step")
    assert res.status_code == 201
    assert res.json()["assetType"] == "step"


def test_unsupported_extension_uses_generic_message(client):
    res = _upload(client, "part.png")
    assert res.status_code == 400
    assert res.json()["detail"] == "Upload a GLB, GLTF, OBJ, STL, STEP, or STP file."
