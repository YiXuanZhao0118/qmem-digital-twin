"""``POST /api/v3/objects/delete`` against a real database.

``test_objects_delete_parity.py`` pins the pure plan to the goldens. This
file pins what the endpoint adds on top, on real rows:

* the fixture scenes, inserted verbatim, give the same answer through the
  endpoint (as sets — the database hands rows back in its own order, so
  only the cases the fixtures mark ``orderIndependent`` are replayed;
  since the cascade became a fixpoint in wave 3b that is all of them),
  and the rows really go: the objects, their
  PhysicsElements, the PPGs' TimingPrograms; everything else is untouched;
* ``dryRun`` answers exactly what the real call then does, and writes and
  broadcasts nothing;
* a cascade that reaches a ``locked`` object is refused whole (409); a
  requested locked object is skipped and listed in ``refused``; an id with
  no row is "already gone" and counts as deleted;
* ONE transaction — a failure half-way leaves every row in place;
* the ``/ws/scene`` events are those of ``DELETE /api/objects/{id}``, per
  row, and ObjectBindings / collection memberships go with their object.

Runs on whatever ``DATABASE_URL`` points at (a scratch database — never the
live one); every row it creates is removed again.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, func, select

from app.db import AsyncSessionLocal
from app.main import app
from app.models import (
    CollectionMember,
    Component,
    ComponentBinding,
    ObjectBinding,
    PhysicsElement,
    SceneObject,
    TimingProgram,
)
from app.routers.collections import get_master_collection
from app.websocket import manager

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "delete"
PPG = "programmable_pulse_generator"


@pytest.fixture(autouse=True)
async def _reset_engine_pool():
    from app.db import engine

    await engine.dispose()
    yield


@pytest.fixture
def events(monkeypatch):
    """Every ``/ws/scene`` broadcast, as (type, payload)."""
    seen: list[tuple[str, dict]] = []

    async def record(event_type, payload):
        seen.append((event_type, payload))

    monkeypatch.setattr(manager, "broadcast", record)
    return seen


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _post(body: dict):
    async with _client() as c:
        return await c.post("/api/v3/objects/delete", json=body)


# ─── fixture scenes as rows ────────────────────────────────────────────────

class Seeded:
    """One fixture scene inserted verbatim (ids included); names get a tag
    so they cannot collide with rows already in the database."""

    def __init__(self, scene: dict) -> None:
        self.scene = scene
        self.tag = uuid.uuid4().hex[:8]
        self.component_id: uuid.UUID | None = None
        self.object_ids = [uuid.UUID(o["id"]) for o in scene["objects"]]
        self.program_ids = [uuid.UUID(t["id"]) for t in scene["timingPrograms"]]

    async def _purge(self, db) -> None:
        await db.execute(delete(SceneObject).where(SceneObject.id.in_(self.object_ids)))
        await db.execute(delete(TimingProgram).where(TimingProgram.id.in_(self.program_ids)))

    async def seed(self) -> None:
        async with AsyncSessionLocal() as db:
            await self._purge(db)  # a run that died half-way
            comp = Component(name=f"delete-parity-{self.tag}", kind_id=None, properties={})
            db.add(comp)
            await db.flush()
            self.component_id = comp.id
            for o in self.scene["objects"]:
                db.add(SceneObject(
                    id=uuid.UUID(o["id"]), name=f"{o['name']}-{self.tag}", component_id=comp.id,
                    locked=o["locked"], properties=o["properties"],
                ))
            await db.flush()
            for p in self.scene["physicsElements"]:
                db.add(PhysicsElement(
                    object_id=uuid.UUID(p["objectId"]), element_kind=p["elementKind"], kind_params=p["kindParams"],
                ))
            for t in self.scene["timingPrograms"]:
                db.add(TimingProgram(id=uuid.UUID(t["id"]), name=f"{t['name']}-{self.tag}", intervals=[]))
            await db.commit()

    async def cleanup(self) -> None:
        async with AsyncSessionLocal() as db:
            await self._purge(db)
            if self.component_id is not None:
                await db.execute(delete(Component).where(Component.id == self.component_id))
            await db.commit()

    async def rows(self) -> tuple[dict[str, dict], set[str], set[str]]:
        """This scene's surviving objects (id -> properties), PhysicsElement
        object ids and TimingProgram ids."""
        async with AsyncSessionLocal() as db:
            objs = (await db.scalars(select(SceneObject).where(SceneObject.id.in_(self.object_ids)))).all()
            pes = (await db.scalars(
                select(PhysicsElement.object_id).where(PhysicsElement.object_id.in_(self.object_ids))
            )).all()
            tps = (await db.scalars(select(TimingProgram.id).where(TimingProgram.id.in_(self.program_ids)))).all()
            return {str(o.id): o.properties for o in objs}, {str(i) for i in pes}, {str(i) for i in tps}


def _expected(scene: dict, case: dict) -> tuple[int, dict | None]:
    """What the endpoint must answer for a fixture case."""
    by_id = {o["id"]: o for o in scene["objects"]}
    if any(by_id[i]["locked"] for i in case["deleted"]):
        return 409, None
    requested = list(dict.fromkeys(case["request"]))
    return 200, {
        "deleted": set(case["deleted"]) | {i for i in requested if i not in by_id},
        "programs": set(case["deletedPrograms"]),
        "refused": [{"objectId": i, "reason": "locked"} for i in requested if i in by_id and by_id[i]["locked"]],
    }


def _replayed():
    """Every order-independent fixture case, grouped by scene."""
    out = []
    for file in ("pinned.json", "random.json"):
        data = json.loads((FIXTURES / file).read_text(encoding="utf-8"))
        by_scene: dict[int, list[dict]] = {}
        for case in data["cases"]:
            if case["orderIndependent"]:
                by_scene.setdefault(case["scene"], []).append(case)
        for idx, cases in by_scene.items():
            out.append(pytest.param(data["scenes"][idx], cases, id=f"{file[:-5]}-scene{idx}"))
    return out


def _check(r, scene: dict, case: dict) -> None:
    status, want = _expected(scene, case)
    assert r.status_code == status, (case["name"], r.text)
    if status == 409:
        assert r.json()["detail"].startswith("locked: ")
        return
    body = r.json()
    assert set(body) == {"deletedObjectIds", "deletedTimingProgramIds", "refused"}
    assert len(body["deletedObjectIds"]) == len(set(body["deletedObjectIds"]))
    assert set(body["deletedObjectIds"]) == want["deleted"], case["name"]
    assert set(body["deletedTimingProgramIds"]) == want["programs"], case["name"]
    assert body["refused"] == want["refused"], case["name"]


@pytest.mark.parametrize(("scene", "cases"), _replayed())
async def test_fixture_scenes_replay_through_the_endpoint(scene, cases):
    """Dry-run every case on one seeding, then run each for real on a fresh
    one and check the rows: what the web deleted is gone, the rest is
    exactly as it was (a fibre or pigtail linked to a deleted object keeps
    its link; a cable is never unlinked, only deleted)."""
    seeded = Seeded(scene)
    await seeded.seed()
    try:
        before = await seeded.rows()
        for case in cases:
            _check(await _post({"objectIds": case["request"], "dryRun": True}), scene, case)
        assert await seeded.rows() == before
        for case in cases:
            await seeded.cleanup()
            await seeded.seed()
            r = await _post({"objectIds": case["request"]})
            _check(r, scene, case)
            objs, pes, tps = await seeded.rows()
            gone = set(case["deleted"]) if r.status_code == 200 else set()
            assert set(objs) == set(before[0]) - gone
            assert {i: objs[i] for i in objs} == {i: before[0][i] for i in objs}
            assert pes == before[1] - gone
            assert tps == before[2] - (set(case["deletedPrograms"]) if r.status_code == 200 else set())
    finally:
        await seeded.cleanup()


# ─── the endpoint's own contract ───────────────────────────────────────────

class Bench:
    """host (rf_switch) with an ObjectBinding and a collection membership;
    a DDS cabled to it; a PPG (with its TimingProgram) plugged into it; a
    legacy PPG whose only rf_cable ends on it; an amplifier cabled to the
    DDS that nothing here touches."""

    def __init__(self) -> None:
        self.tag = uuid.uuid4().hex[:8]
        self.obj: dict[str, uuid.UUID] = {}
        self.program: dict[str, uuid.UUID] = {}
        self.component_id: uuid.UUID | None = None
        self.binding_id: uuid.UUID | None = None
        self.collection_id: uuid.UUID | None = None

    def link(self, key: str, anchor: str = "rf_in") -> dict:
        return {"targetObjectId": str(self.obj[key]), "targetAnchorId": anchor, "targetAnchorName": anchor}

    async def seed(self) -> None:
        master = None
        async with AsyncSessionLocal() as db:
            master = await get_master_collection(db)
            self.collection_id = master.id
        async with AsyncSessionLocal() as db:
            comp = Component(name=f"delete-bench-{self.tag}", kind_id=None, properties={})
            db.add(comp)
            await db.flush()
            self.component_id = comp.id
            binding = ComponentBinding(component_id=comp.id, target_kind="empty", role="root", properties={})
            db.add(binding)
            await db.flush()
            self.binding_id = binding.id
            for key in ("host", "dds", "amp", "ppg", "legacy", "cable", "legacyCable", "ampCable"):
                self.obj[key] = uuid.uuid4()
            for key in ("ppg", "legacy"):
                self.program[key] = uuid.uuid4()
                db.add(TimingProgram(id=self.program[key], name=f"{key}-{self.tag}", intervals=[]))
            rows = {
                "host": ("rf_switch", {}, {}),
                "dds": ("rf_source", {}, {}),
                "amp": ("rf_amplifier", {}, {}),
                "ppg": (PPG, {"ppgAttachment": {**self.link("host", "ttl_in")}},
                        {"timingProgramId": str(self.program["ppg"])}),
                "legacy": (PPG, {}, {"timingProgramId": str(self.program["legacy"])}),
                "cable": ("rf_cable", {"rfCableEndpoints": {"A": self.link("dds", "rf_out"), "B": self.link("host")}}, {}),
                "legacyCable": ("rf_cable", {"rfCableEndpoints": {
                    "A": self.link("legacy", "rf_out"), "B": self.link("host", "trigger_in")}}, {}),
                "ampCable": ("rf_cable", {"rfCableEndpoints": {"A": self.link("dds", "rf_out"), "B": self.link("amp")}}, {}),
            }
            for key, (_, props, _) in rows.items():
                db.add(SceneObject(id=self.obj[key], name=f"{key}-{self.tag}", component_id=comp.id, properties=props))
            await db.flush()
            for key, (kind, _, kp) in rows.items():
                db.add(PhysicsElement(object_id=self.obj[key], element_kind=kind, kind_params=kp))
                db.add(CollectionMember(collection_id=self.collection_id, object_id=self.obj[key]))
            db.add(ObjectBinding(object_id=self.obj["host"], component_binding_id=binding.id, local_x_mm_delta=1.0))
            await db.commit()

    async def cleanup(self) -> None:
        async with AsyncSessionLocal() as db:
            await db.execute(delete(SceneObject).where(SceneObject.id.in_(list(self.obj.values()))))
            await db.execute(delete(TimingProgram).where(TimingProgram.id.in_(list(self.program.values()))))
            await db.execute(delete(ComponentBinding).where(ComponentBinding.component_id == self.component_id))
            await db.execute(delete(Component).where(Component.id == self.component_id))
            await db.commit()

    async def lock(self, key: str) -> None:
        async with AsyncSessionLocal() as db:
            row = await db.get(SceneObject, self.obj[key])
            row.locked = True
            await db.commit()

    async def alive(self) -> set[str]:
        async with AsyncSessionLocal() as db:
            ids = (await db.scalars(select(SceneObject.id).where(SceneObject.id.in_(list(self.obj.values()))))).all()
        names = {v: k for k, v in self.obj.items()}
        return {names[i] for i in ids}

    async def counts(self) -> dict[str, int]:
        ids = list(self.obj.values())
        async with AsyncSessionLocal() as db:
            async def n(model, col, values):
                return await db.scalar(select(func.count()).select_from(model).where(col.in_(values)))
            return {
                "objects": await n(SceneObject, SceneObject.id, ids),
                "elements": await n(PhysicsElement, PhysicsElement.object_id, ids),
                "members": await n(CollectionMember, CollectionMember.object_id, ids),
                "bindings": await n(ObjectBinding, ObjectBinding.object_id, ids),
                "programs": await n(TimingProgram, TimingProgram.id, list(self.program.values())),
            }


@pytest.fixture
async def bench():
    b = Bench()
    await b.seed()
    try:
        yield b
    finally:
        await b.cleanup()


async def test_deleting_an_instrument_takes_the_whole_cascade(bench, events):
    r = await _post({"objectIds": [str(bench.obj["host"])]})
    assert r.status_code == 200, r.text
    body = r.json()
    names = {str(v): k for k, v in bench.obj.items()}
    # The web's DELETE order: the request, cables (scene order), attached
    # PPGs, then the orphaned legacy PPG.
    assert [names[i] for i in body["deletedObjectIds"][:1]] == ["host"]
    assert {names[i] for i in body["deletedObjectIds"]} == {"host", "cable", "legacyCable", "ppg", "legacy"}
    assert body["deletedObjectIds"][-1] == str(bench.obj["legacy"])
    assert set(body["deletedTimingProgramIds"]) == {str(bench.program["ppg"]), str(bench.program["legacy"])}
    assert body["refused"] == []
    assert await bench.alive() == {"dds", "amp", "ampCable"}
    assert await bench.counts() == {"objects": 3, "elements": 3, "members": 3, "bindings": 0, "programs": 0}

    # The events of DELETE /api/objects/{id}, per row, in delete order.
    expected: list[tuple[str, dict]] = []
    for oid in body["deletedObjectIds"]:
        expected.append(("object.deleted", {"id": oid, "objectId": oid}))
        expected.append(("physics_element.updated", {"objectId": oid, "deleted": True}))
        key = names[oid]
        if key in bench.program:
            expected.append(("timing_program.deleted", {"id": str(bench.program[key])}))
    assert events == expected


async def test_dry_run_answers_the_real_call_and_writes_nothing(bench, events):
    body = {"objectIds": [str(bench.obj["dds"]), str(bench.obj["legacy"])]}
    dry = await _post({**body, "dryRun": True})
    assert dry.status_code == 200
    assert events == []
    assert await bench.counts() == {"objects": 8, "elements": 8, "members": 8, "bindings": 1, "programs": 2}
    real = await _post(body)
    assert real.json() == dry.json()
    assert await bench.alive() == {"host", "amp", "ppg"}


async def test_a_cascade_reaching_a_locked_object_is_refused_whole(bench, events):
    await bench.lock("ppg")
    for dry_run in (True, False):
        r = await _post({"objectIds": [str(bench.obj["host"])], "dryRun": dry_run})
        assert r.status_code == 409
        detail = r.json()["detail"]
        assert detail.startswith("locked: ") and f"ppg-{bench.tag}" in detail and str(bench.obj["ppg"]) in detail
    assert events == []
    assert len(await bench.alive()) == 8


async def test_a_locked_requested_object_is_refused_and_the_rest_deleted(bench):
    await bench.lock("amp")
    r = await _post({"objectIds": [str(bench.obj["amp"]), str(bench.obj["legacyCable"])]})
    assert r.status_code == 200
    body = r.json()
    assert body["refused"] == [{"objectId": str(bench.obj["amp"]), "reason": "locked"}]
    # Its cable is not cascaded: the amp itself is not doomed.
    assert body["deletedObjectIds"] == [str(bench.obj["legacyCable"]), str(bench.obj["legacy"])]
    assert body["deletedTimingProgramIds"] == [str(bench.program["legacy"])]
    assert "amp" in await bench.alive() and "ampCable" in await bench.alive()


async def test_an_id_with_no_row_is_already_gone(bench, events):
    ghost = str(uuid.uuid4())
    r = await _post({"objectIds": [ghost, str(bench.obj["ampCable"]), ghost]})
    assert r.status_code == 200
    assert r.json() == {
        "deletedObjectIds": [str(bench.obj["ampCable"]), ghost],
        "deletedTimingProgramIds": [],
        "refused": [],
    }
    assert all(p.get("objectId") != ghost for _, p in events)
    only_ghost = await _post({"objectIds": [ghost]})
    assert only_ghost.json() == {"deletedObjectIds": [ghost], "deletedTimingProgramIds": [], "refused": []}


async def test_one_transaction(bench, monkeypatch):
    """A failure on the third row leaves the first two in place."""
    from app.routers import objects
    from app.services import object_delete

    real = objects.remove_scene_object
    calls = 0

    async def flaky(session, scene_object):
        nonlocal calls
        calls += 1
        if calls == 3:
            raise RuntimeError("boom")
        return await real(session, scene_object)

    monkeypatch.setattr(object_delete, "remove_scene_object", flaky)
    with pytest.raises(RuntimeError):
        await _post({"objectIds": [str(bench.obj["host"])]})
    assert calls == 3
    assert await bench.counts() == {"objects": 8, "elements": 8, "members": 8, "bindings": 1, "programs": 2}


async def test_request_validation():
    assert (await _post({"objectIds": ["not-a-uuid"]})).status_code == 422
    assert (await _post({})).status_code == 422
    r = await _post({"objectIds": []})
    assert r.status_code == 200
    assert r.json() == {"deletedObjectIds": [], "deletedTimingProgramIds": [], "refused": []}
