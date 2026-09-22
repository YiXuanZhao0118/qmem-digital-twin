"""``PUT /api/components/{id}`` persists ``exposedFaces``.

``ComponentUpdate`` had no ``exposed_faces`` field, so a PUT carrying
``exposedFaces`` answered 200 and dropped it — pydantic ignores keys a model
does not declare. It now takes the field with the same type as create
(``ComponentBase.exposed_faces``): sent = written (``null`` clears it),
omitted = untouched, and a locked Component refuses it like any other edit.

Runs on whatever ``DATABASE_URL`` points at (a scratch database — never the
live one); every row it creates is removed again.
"""

from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete

from app.db import AsyncSessionLocal
from app.main import app
from app.models import Component
from app.websocket import manager

FACES = [
    {"componentFaceId": "optical_in", "assetBindingId": "glan_in", "assetFaceId": "intercept_in"},
    {"componentFaceId": "optical_out", "assetBindingId": "glan_out", "assetFaceId": "intercept_out"},
]


@pytest.fixture(autouse=True)
async def _reset_engine_pool():
    from app.db import engine

    await engine.dispose()
    yield


@pytest.fixture
def events(monkeypatch):
    seen: list[tuple[str, dict]] = []

    async def record(event_type, payload):
        seen.append((event_type, payload))

    monkeypatch.setattr(manager, "broadcast", record)
    return seen


@pytest.fixture
async def component_id():
    cid = uuid.uuid4()
    async with AsyncSessionLocal() as db:
        db.add(Component(id=cid, name=f"test_exposed_faces_{cid.hex[:8]}", kind_id=None))
        await db.commit()
    yield cid
    async with AsyncSessionLocal() as db:
        await db.execute(delete(Component).where(Component.id == cid))
        await db.commit()


async def _put(cid: uuid.UUID, body: dict):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        return await c.put(f"/api/components/{cid}", json=body)


async def _stored(cid: uuid.UUID):
    async with AsyncSessionLocal() as db:
        return (await db.get(Component, cid)).exposed_faces


async def test_put_round_trips_exposed_faces(component_id, events):
    r = await _put(component_id, {"exposedFaces": FACES})
    assert r.status_code == 200, r.text
    assert r.json()["exposedFaces"] == FACES
    assert await _stored(component_id) == FACES
    assert events == [("component.updated", r.json())]


async def test_omitting_it_leaves_it_untouched(component_id):
    await _put(component_id, {"exposedFaces": FACES})
    r = await _put(component_id, {"notes": "re-measured"})
    assert r.status_code == 200
    assert r.json()["exposedFaces"] == FACES
    assert await _stored(component_id) == FACES


async def test_null_clears_it(component_id):
    await _put(component_id, {"exposedFaces": FACES})
    r = await _put(component_id, {"exposedFaces": None})
    assert r.status_code == 200
    assert r.json()["exposedFaces"] is None
    assert await _stored(component_id) is None


async def test_validated_like_create(component_id):
    r = await _put(component_id, {"exposedFaces": {"optical_in": "x"}})
    assert r.status_code == 422
    assert await _stored(component_id) is None


async def test_a_locked_component_refuses_it(component_id):
    assert (await _put(component_id, {"locked": True})).status_code == 200
    r = await _put(component_id, {"exposedFaces": FACES})
    assert r.status_code == 422
    assert "exposed_faces" in r.json()["detail"]
    assert await _stored(component_id) is None
