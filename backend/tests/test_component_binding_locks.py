"""ComponentBinding writes respect the owning Component's ``locked`` flag.

A binding row is part of its Component's definition, so while the Component
is locked ``POST /api/components/{id}/bindings``, ``PUT`` and ``DELETE
/api/component-bindings/{id}`` answer the Component's own 422 (the shared
``lock_guard`` rule) and write nothing; unlocking the Component re-opens
them. So does ``DELETE /api/v3/assets3d/{key}``, which used to cut the
asset's bindings out of every Component that used it, locked or not.

The lock is per row, not transitive (as for Asset3D rows under a locked
Component): only the Component that OWNS the binding counts — not a
container that uses it as a sub-component, and not the sub-component a
binding points at.

Runs on whatever ``DATABASE_URL`` points at (a scratch database — never the
live one); every row it creates is removed again.
"""

from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select

from app.db import AsyncSessionLocal
from app.main import app
from app.models import Asset3D, Component, ComponentBinding
from app.websocket import manager


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


class Rows:
    """Two assets; Components ``a`` and ``b`` (``a`` holds ``b`` as a
    sub-component); one asset binding on each."""

    def __init__(self) -> None:
        self.tag = uuid.uuid4().hex[:8]
        self.asset: dict[str, uuid.UUID] = {}
        self.comp: dict[str, uuid.UUID] = {}
        self.binding: dict[str, uuid.UUID] = {}

    async def seed(self) -> None:
        async with AsyncSessionLocal() as db:
            for key in ("body", "spare"):
                row = Asset3D(name=f"lock-{key}-{self.tag}", asset_type="glb", file_path=f"{key}.glb", kind_id="unclassified")
                db.add(row)
                await db.flush()
                self.asset[key] = row.id
            for key in ("a", "b"):
                row = Component(name=f"lock-{key}-{self.tag}", kind_id=None)
                db.add(row)
                await db.flush()
                self.comp[key] = row.id
            for key in ("a", "b"):
                row = ComponentBinding(
                    component_id=self.comp[key], target_kind="asset", asset_3d_id=self.asset["body"], role="body",
                )
                db.add(row)
                await db.flush()
                self.binding[key] = row.id
            sub = ComponentBinding(
                component_id=self.comp["a"], target_kind="subcomponent", sub_component_id=self.comp["b"],
                role="sub", sort_order=1,
            )
            db.add(sub)
            await db.flush()
            self.binding["a_sub"] = sub.id
            await db.commit()

    async def cleanup(self) -> None:
        async with AsyncSessionLocal() as db:
            await db.execute(delete(ComponentBinding).where(ComponentBinding.component_id.in_(list(self.comp.values()))))
            await db.execute(delete(Component).where(Component.id.in_(list(self.comp.values()))))
            await db.execute(delete(Asset3D).where(Asset3D.id.in_(list(self.asset.values()))))
            await db.commit()

    async def set_locked(self, key: str, locked: bool) -> None:
        async with AsyncSessionLocal() as db:
            (await db.get(Component, self.comp[key])).locked = locked
            await db.commit()

    async def bindings_of(self, key: str) -> list[tuple]:
        async with AsyncSessionLocal() as db:
            rows = (await db.scalars(
                select(ComponentBinding).where(ComponentBinding.component_id == self.comp[key])
            )).all()
            return sorted((str(b.id), b.role, b.local_x_mm, str(b.asset_3d_id)) for b in rows)


@pytest.fixture
async def rows():
    r = Rows()
    await r.seed()
    try:
        yield r
    finally:
        await r.cleanup()


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _new_binding(rows: Rows) -> dict:
    return {"targetKind": "asset", "asset3dId": str(rows.asset["spare"]), "role": "spare"}


def _assert_locked_422(r, rows: Rows, key: str, fields: str) -> None:
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert f"lock-{key}-{rows.tag}" in detail and "is locked" in detail and fields in detail


async def test_writes_on_a_locked_component_are_refused(rows, events):
    await rows.set_locked("b", True)
    before = await rows.bindings_of("b")
    async with _client() as c:
        created = await c.post(f"/api/components/{rows.comp['b']}/bindings", json=_new_binding(rows))
        updated = await c.put(f"/api/component-bindings/{rows.binding['b']}", json={"localXMm": 5})
        deleted = await c.delete(f"/api/component-bindings/{rows.binding['b']}")
    _assert_locked_422(created, rows, "b", "['bindings']")
    _assert_locked_422(updated, rows, "b", "['bindings.local_x_mm']")
    _assert_locked_422(deleted, rows, "b", "['bindings']")
    assert await rows.bindings_of("b") == before
    assert events == []


async def test_the_same_writes_on_an_unlocked_component_go_through(rows, events):
    async with _client() as c:
        created = await c.post(f"/api/components/{rows.comp['b']}/bindings", json=_new_binding(rows))
        updated = await c.put(f"/api/component-bindings/{rows.binding['b']}", json={"localXMm": 5})
        deleted = await c.delete(f"/api/component-bindings/{created.json()['id']}")
    assert (created.status_code, updated.status_code, deleted.status_code) == (201, 200, 204)
    assert updated.json()["localXMm"] == 5
    assert [e for e, _ in events] == [
        "component_binding.created", "component_binding.updated", "component_binding.deleted",
    ]


async def test_unlocking_the_component_reopens_them(rows):
    await rows.set_locked("b", True)
    async with _client() as c:
        assert (await c.put(f"/api/component-bindings/{rows.binding['b']}", json={"localXMm": 5})).status_code == 422
        # Unlocking is a Component-level action — a pure unlock is the one
        # write the lock allows.
        assert (await c.put(f"/api/components/{rows.comp['b']}", json={"locked": False})).status_code == 200
        r = await c.put(f"/api/component-bindings/{rows.binding['b']}", json={"localXMm": 5})
    assert r.status_code == 200 and r.json()["localXMm"] == 5


async def test_an_empty_put_is_a_no_op_even_when_locked(rows):
    """As on ``PUT /api/components/{id}``: the guard refuses changed fields,
    and an empty body changes none."""
    await rows.set_locked("b", True)
    async with _client() as c:
        r = await c.put(f"/api/component-bindings/{rows.binding['b']}", json={})
    assert r.status_code == 200


async def test_only_the_owning_component_counts(rows):
    # Container locked: the sub-component's own bindings stay editable.
    await rows.set_locked("a", True)
    async with _client() as c:
        assert (await c.put(f"/api/component-bindings/{rows.binding['b']}", json={"localXMm": 1})).status_code == 200
        assert (await c.put(f"/api/component-bindings/{rows.binding['a_sub']}", json={"localXMm": 1})).status_code == 422
    # Sub-component locked: the container may re-pose / drop its binding to it.
    await rows.set_locked("a", False)
    await rows.set_locked("b", True)
    async with _client() as c:
        assert (await c.put(f"/api/component-bindings/{rows.binding['a_sub']}", json={"localXMm": 2})).status_code == 200
        assert (await c.delete(f"/api/component-bindings/{rows.binding['a_sub']}")).status_code == 204
        r = await c.post(
            f"/api/components/{rows.comp['a']}/bindings",
            json={"targetKind": "subcomponent", "subComponentId": str(rows.comp["b"]), "role": "sub"},
        )
    assert r.status_code == 201, r.text


async def test_deleting_an_asset_does_not_cut_it_out_of_a_locked_component(rows):
    await rows.set_locked("b", True)
    async with _client() as c:
        r = await c.delete(f"/api/v3/assets3d/{rows.asset['body']}")
        _assert_locked_422(r, rows, "b", "['bindings']")
        async with AsyncSessionLocal() as db:
            assert await db.get(Asset3D, rows.asset["body"]) is not None
        assert len(await rows.bindings_of("a")) == 2 and len(await rows.bindings_of("b")) == 1
        await rows.set_locked("b", False)
        assert (await c.delete(f"/api/v3/assets3d/{rows.asset['body']}")).status_code == 204
    assert len(await rows.bindings_of("a")) == 1 and await rows.bindings_of("b") == []
