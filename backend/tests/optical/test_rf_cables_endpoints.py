"""POST /api/v3/rf-cables/* and /api/v3/ppg/* against a real database.

``test_rf_cables_parity.py`` pins the pure plans to the TypeScript. This file
pins what the endpoints add on top, on real rows:

* the write is ONE transaction — a rejected request, or a failure half-way
  through a PPG attach, leaves nothing behind;
* the rows are the ones the web app ends up with (the cable Component and
  its auto-created PhysicsElement, ``rfCableEndpoints`` / ``rfCableNodes``,
  the PPG's TimingProgram, kindParams and ``ppgAttachment``);
* the result is physically right when re-read through the backend's own
  transform chain: a new cable's connector mating face sits ON its port, a
  plugged PPG's plug tip sits on its port, facing into it;
* locks and the ``/ws/scene`` events.

Runs on whatever ``DATABASE_URL`` points at (a scratch database — never the
live one); every row it creates is removed again.
"""

from __future__ import annotations

import math
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, func, select

from app.db import AsyncSessionLocal
from app.main import app
from app.models import (
    Asset3D,
    Component,
    ComponentBinding,
    PhysicsElement,
    SceneObject,
    TimingProgram,
)
from app.optical.beam_ray import Vec3
from app.optical.pose import V3Pose, dir_body_to_lab, point_body_to_lab
from app.websocket import manager

SMA_TIP = 25.45  # |connect_in - connect_out| of the catalog `sma male`
BNC_TIP = 43.5   # ... of `BNC Male`


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


def _anchor(aid, pos, axis, connector=None, name=None):
    a = {"id": aid, "positionMmBodyLocal": dict(zip("xyz", pos)), "axisXBodyLocal": dict(zip("xyz", axis))}
    if connector:
        a["connectorType"] = connector
    if name:
        a["name"] = name
    return a


class Lab:
    """A small RF bench: a DDS (CH0/CH1, SMA), a 1x2 switch (rf_in BNC,
    RF1 SMA, ttl_in BNC), an amplifier (SMA) — rotated like the live bench —
    an SMA-SMA and a BNC-SMA cable in the catalog, and a BNC PPG."""

    def __init__(self) -> None:
        self.tag = uuid.uuid4().hex[:8]
        self.asset_ids: list[uuid.UUID] = []
        self.component_ids: list[uuid.UUID] = []
        self.obj: dict[str, uuid.UUID] = {}
        self.comp: dict[str, uuid.UUID] = {}
        self.anchors: dict[str, list[dict]] = {}
        self.poses: dict[str, V3Pose] = {}

    async def seed(self) -> None:
        async with AsyncSessionLocal() as db:
            def asset(key, kind, anchors, params=None):
                row = Asset3D(
                    name=f"{key}-{self.tag}", asset_type="glb", file_path=f"{key}.glb",
                    kind_id=kind, anchors=anchors, default_params=params or {},
                )
                db.add(row)
                self.anchors[key] = anchors
                return row

            sma = asset("sma", "rf_cable_connector", [
                _anchor("connect_out", (-4, 0, 0), (1, 0, 0)),
                _anchor("connect_in", (-29.45, 0, 0), (-1, 0, 0)),
            ], {"family": "sma", "gender": "male"})
            bnc = asset("bnc", "rf_cable_connector", [
                _anchor("connect_out", (0, 0, -29.7), (0, 0, -1)),
                _anchor("connect_in", (0, 0, 13.8), (0, 0, 1)),
            ], {"family": "bnc", "gender": "male"})
            dds = asset("dds", "rf_source", [
                _anchor("rf_out", (-20, 5, 12), (0, 0, 1), "sma_female", "CH0"),
                _anchor("rf_out", (-6.6, 5, 12), (0, 0, 1), "sma_female", "CH1"),
            ])
            switch = asset("switch", "rf_switch", [
                _anchor("rf_in", (0, -12.5, 9), (0, -1, 0), "bnc_female"),
                _anchor("rf_out", (-9, 12.5, 9), (0, 1, 0), "sma_female", "RF1"),
                _anchor("ttl_in", (20, 0, 9), (1, 0, 0), "bnc_female"),
            ])
            amp = asset("amp", "rf_amplifier", [
                _anchor("rf_in", (-55.5, 0, 0), (-1, 0, 0), "sma_female"),
                _anchor("rf_out", (55.5, 0, 0), (1, 0, 0), "sma_female"),
            ])
            ppg = asset("ppg", "programmable_pulse_generator", [
                _anchor("rf_out", (0, 0, 4.8), (0, 0, 1), "bnc_male"),
            ], {"matingProtrusionMm": 9.0})
            await db.flush()
            self.asset_ids = [a.id for a in (sma, bnc, dds, switch, amp, ppg)]

            def component(key, kind, props=None):
                row = Component(name=f"{key}-{self.tag}", kind_id=kind, properties=props or {})
                db.add(row)
                return row

            comps = {
                "cable_sma": component("cable_sma", "rf_cable"),
                "cable_bnc_sma": component("cable_bnc_sma", "rf_cable"),
                "dds": component("dds", "rf_source"),
                "switch": component("switch", "rf_switch"),
                "amp": component("amp", "rf_amplifier"),
                "ppg": component("ppg", "programmable_pulse_generator", {"connectorType": "bnc"}),
                # Multi-root, like the EOM: the switch body plus a connector
                # asset as a second root (primaryAsset gives up on it).
                "switch_mr": component("switch_mr", "rf_switch"),
            }
            await db.flush()
            self.comp = {k: c.id for k, c in comps.items()}
            self.component_ids = list(self.comp.values())

            def bind(comp_key, asset_row, role, props=None, sort=0):
                db.add(ComponentBinding(
                    component_id=self.comp[comp_key], target_kind="asset", asset_3d_id=asset_row.id,
                    role=role, properties=props or {}, sort_order=sort,
                ))

            bind("cable_sma", sma, "end_a", {"splineEnd": "A"})
            bind("cable_sma", sma, "end_b", {"splineEnd": "B"}, 1)
            bind("cable_bnc_sma", bnc, "end_a", {"splineEnd": "A"})
            bind("cable_bnc_sma", sma, "end_b", {"splineEnd": "B"}, 1)
            bind("dds", dds, "root")
            bind("switch", switch, "root")
            bind("amp", amp, "root")
            bind("ppg", ppg, "root")
            bind("switch_mr", switch, "body")
            bind("switch_mr", sma, "spare_connector", sort=1)
            self.anchors["switch_mr"] = self.anchors["switch"]

            def place(key, comp_key, kind, pose: V3Pose):
                row = SceneObject(
                    name=f"{key.upper()}-{self.tag}", component_id=self.comp[comp_key],
                    x_mm=pose.x_mm, y_mm=pose.y_mm, z_mm=pose.z_mm,
                    rx_deg=pose.rx_deg, ry_deg=pose.ry_deg, rz_deg=pose.rz_deg,
                )
                db.add(row)
                self.poses[key] = pose
                return row, kind

            rows = [
                place("dds", "dds", "rf_source", V3Pose(-910.099, 754.744, 704.245, -90, 0, 180)),
                place("switch", "switch", "rf_switch", V3Pose(-1239.576, 761.745, 699.415, -90, 0, 180)),
                place("amp", "amp", "rf_amplifier", V3Pose(-1602.259, 767.0, 752.648, 90, -180, 0)),
                place("switch_mr", "switch_mr", "rf_switch", V3Pose(-1239.79, 761.745, 742.393, -90, 0, 180)),
            ]
            await db.flush()
            for row, kind in rows:
                db.add(PhysicsElement(object_id=row.id, element_kind=kind, kind_params={}))
            await db.commit()
            self.obj = {k: r.id for k, (r, _) in zip(("dds", "switch", "amp", "switch_mr"), rows)}

    async def cleanup(self) -> None:
        async with AsyncSessionLocal() as db:
            objs = (await db.scalars(select(SceneObject).where(SceneObject.component_id.in_(self.component_ids)))).all()
            obj_ids = [o.id for o in objs]
            if obj_ids:
                pes = (await db.scalars(select(PhysicsElement).where(PhysicsElement.object_id.in_(obj_ids)))).all()
                tps = [
                    uuid.UUID(p.kind_params["timingProgramId"]) for p in pes
                    if p.element_kind == "programmable_pulse_generator" and (p.kind_params or {}).get("timingProgramId")
                ]
                await db.execute(delete(SceneObject).where(SceneObject.id.in_(obj_ids)))
                if tps:
                    await db.execute(delete(TimingProgram).where(TimingProgram.id.in_(tps)))
            await db.execute(delete(ComponentBinding).where(ComponentBinding.component_id.in_(self.component_ids)))
            await db.execute(delete(Component).where(Component.id.in_(self.component_ids)))
            await db.execute(delete(Asset3D).where(Asset3D.id.in_(self.asset_ids)))
            await db.commit()

    def port_lab(self, key: str, anchor_name: str) -> tuple[Vec3, Vec3]:
        """Where the tracer's transform chain puts a port (root binding at
        identity, so object pose ∘ anchor)."""
        asset_key = key
        a = next(x for x in self.anchors[asset_key] if (x.get("name") or x["id"]) == anchor_name)
        p = a["positionMmBodyLocal"]
        d = a["axisXBodyLocal"]
        pose = self.poses[key]
        return (
            point_body_to_lab(Vec3(p["x"], p["y"], p["z"]), pose),
            dir_body_to_lab(Vec3(d["x"], d["y"], d["z"]), pose),
        )


@pytest.fixture
async def lab():
    bench = Lab()
    await bench.seed()
    try:
        yield bench
    finally:
        await bench.cleanup()


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _port(lab: Lab, key: str, name: str) -> dict:
    return {"objectId": str(lab.obj[key]), "anchorName": name}


def _mating_face(cable: dict, end: str, tip: float) -> tuple[list[float], list[float]]:
    """A cable end's connector mating face and outward axis, in lab mm —
    node + outward x tip, outward = -handle (identity cable rotation)."""
    nodes = cable["properties"]["rfCableNodes"]
    node = nodes[0] if end == "A" else nodes[-1]
    handle = node["handleOutMm"] if end == "A" else node["handleInMm"]
    m = math.hypot(*handle)
    outward = [-h / m for h in handle]
    origin = [cable["xMm"], cable["yMm"], cable["zMm"]]
    face = [origin[i] + node["posMm"][i] + outward[i] * tip for i in range(3)]
    return face, outward


def _assert_on_port(face, outward, port: tuple[Vec3, Vec3], tol=1e-6):
    pos, axis = port
    assert math.dist(face, [pos.x, pos.y, pos.z]) < tol, (face, pos)
    # Coax mating is anti-parallel: the plug faces INTO the receptacle.
    assert math.dist(outward, [-axis.x, -axis.y, -axis.z]) < 1e-9


async def _count(model) -> int:
    async with AsyncSessionLocal() as db:
        return await db.scalar(select(func.count()).select_from(model))


async def _next_ppg_name() -> str:
    """The name the attach will pick: ``CH<number of PPGs>``, stepped past
    any object name already taken (case-insensitively)."""
    async with AsyncSessionLocal() as db:
        n = await db.scalar(
            select(func.count()).select_from(PhysicsElement)
            .where(PhysicsElement.element_kind == "programmable_pulse_generator")
        )
        taken = {name.lower() for name in (await db.scalars(select(SceneObject.name))).all()}
    while f"ch{n}" in taken:
        n += 1
    return f"CH{n}"


# ─── connect ────────────────────────────────────────────────────────────────

async def test_connect_creates_one_mated_cable(lab, events):
    async with _client() as c:
        r = await c.post("/api/v3/rf-cables/connect", json={"a": _port(lab, "dds", "CH0"), "b": _port(lab, "amp", "rf_in")})
    assert r.status_code == 200, r.text
    cable = r.json()["object"]
    assert cable["componentId"] == str(lab.comp["cable_sma"])
    assert cable["name"].startswith("RF_CABLE")
    assert (cable["rxDeg"], cable["ryDeg"], cable["rzDeg"]) == (0, 0, 0)
    eps = cable["properties"]["rfCableEndpoints"]
    assert eps["A"] == {"targetObjectId": str(lab.obj["dds"]), "targetAnchorId": "rf_out", "targetAnchorName": "CH0"}
    assert eps["B"] == {"targetObjectId": str(lab.obj["amp"]), "targetAnchorId": "rf_in", "targetAnchorName": "rf_in"}
    # Both connector mating faces sit ON their ports (rotated instruments).
    _assert_on_port(*_mating_face(cable, "A", SMA_TIP), lab.port_lab("dds", "CH0"))
    _assert_on_port(*_mating_face(cable, "B", SMA_TIP), lab.port_lab("amp", "rf_in"))

    async with AsyncSessionLocal() as db:
        pe = await db.scalar(select(PhysicsElement).where(PhysicsElement.object_id == uuid.UUID(cable["id"])))
    assert pe is not None and pe.element_kind == "rf_cable"
    kinds = [t for t, _ in events]
    assert kinds[:2] == ["object.updated", "collection_member.updated"]
    assert "physics_element.updated" in kinds


async def test_connect_cross_family_takes_the_swapped_adapter_cable(lab):
    async with _client() as c:
        r = await c.post("/api/v3/rf-cables/connect", json={
            # request order is irrelevant: the OUT port is the source
            "a": _port(lab, "switch", "rf_in"), "b": _port(lab, "dds", "CH1"),
        })
    assert r.status_code == 200, r.text
    cable = r.json()["object"]
    assert cable["componentId"] == str(lab.comp["cable_bnc_sma"])
    eps = cable["properties"]["rfCableEndpoints"]
    # The catalog row is BNC at A: A goes on the BNC switch input.
    assert eps["A"]["targetObjectId"] == str(lab.obj["switch"])
    assert eps["B"]["targetAnchorName"] == "CH1"
    _assert_on_port(*_mating_face(cable, "A", BNC_TIP), lab.port_lab("switch", "rf_in"))
    _assert_on_port(*_mating_face(cable, "B", SMA_TIP), lab.port_lab("dds", "CH1"))


@pytest.mark.parametrize(("a", "b", "status", "code"), [
    (("dds", "CH0"), ("dds", "CH1"), 422, "same_object"),
    (("dds", "CH0"), ("amp", "rf_out"), 422, "role_mismatch"),
    (("dds", "CH0"), ("switch", "ttl_in"), 422, "domain_mismatch"),
    (("dds", "CH7"), ("amp", "rf_in"), 422, "port_not_found"),
])
async def test_connect_rejections_write_nothing(lab, a, b, status, code):
    before = await _count(SceneObject)
    async with _client() as c:
        r = await c.post("/api/v3/rf-cables/connect", json={"a": _port(lab, *a), "b": _port(lab, *b)})
    assert r.status_code == status
    assert r.json()["detail"].startswith(f"{code}: ")
    assert await _count(SceneObject) == before


async def test_connect_refuses_a_busy_port_and_unknown_objects(lab):
    async with _client() as c:
        first = await c.post("/api/v3/rf-cables/connect", json={"a": _port(lab, "dds", "CH0"), "b": _port(lab, "amp", "rf_in")})
        assert first.status_code == 200
        busy = await c.post("/api/v3/rf-cables/connect", json={"a": _port(lab, "dds", "CH0"), "b": _port(lab, "switch", "rf_in")})
        gone = await c.post("/api/v3/rf-cables/connect", json={
            "a": {"objectId": str(uuid.uuid4()), "anchorName": "CH0"}, "b": _port(lab, "amp", "rf_in"),
        })
    assert busy.status_code == 409 and busy.json()["detail"].startswith("port_busy: ")
    assert gone.status_code == 404 and gone.json()["detail"].startswith("object_not_found: ")


# ─── resnap / align / disconnect ───────────────────────────────────────────

async def _move(object_id: uuid.UUID, lab: Lab, key: str, dx: float) -> None:
    async with AsyncSessionLocal() as db:
        so = await db.get(SceneObject, object_id)
        so.x_mm += dx
        await db.commit()
    p = lab.poses[key]
    lab.poses[key] = V3Pose(p.x_mm + dx, p.y_mm, p.z_mm, p.rx_deg, p.ry_deg, p.rz_deg)


async def test_resnap_follows_a_moved_instrument_then_is_a_no_op(lab, events):
    async with _client() as c:
        cable = (await c.post("/api/v3/rf-cables/connect", json={
            "a": _port(lab, "dds", "CH0"), "b": _port(lab, "amp", "rf_in"),
        })).json()["object"]
        await _move(lab.obj["amp"], lab, "amp", -49.971)
        events.clear()
        r = await c.post("/api/v3/rf-cables/resnap", json={"movedObjectIds": [str(lab.obj["amp"])]})
        again = await c.post("/api/v3/rf-cables/resnap", json={"movedObjectIds": [str(lab.obj["amp"])]})
    assert r.status_code == 200, r.text
    (updated,) = r.json()["updated"]
    assert updated["id"] == cable["id"]
    _assert_on_port(*_mating_face(updated, "B", SMA_TIP), lab.port_lab("amp", "rf_in"))
    # End A was not linked to anything that moved: untouched.
    assert updated["properties"]["rfCableNodes"][0] == cable["properties"]["rfCableNodes"][0]
    assert [t for t, _ in events] == ["object.updated"]
    assert again.json() == {"updated": []}


@pytest.mark.parametrize(("loose_end", "key", "name"), [
    ("B", "amp", "rf_in"),   # amp at rx 90 / ry -180
    ("A", "dds", "CH0"),     # dds at rx -90 / rz 180 — rotated about x, like the live bench
])
async def test_align_candidates_then_align_links_a_loose_end(lab, loose_end, key, name):
    kept = "A" if loose_end == "B" else "B"
    async with _client() as c:
        cable = (await c.post("/api/v3/rf-cables/connect", json={
            "a": _port(lab, "dds", "CH0"), "b": _port(lab, "amp", "rf_in"),
        })).json()["object"]
        # Loosen one end: drop its link, leave the node where it was.
        props = dict(cable["properties"])
        props["rfCableEndpoints"] = {kept: props["rfCableEndpoints"][kept]}
        await c.put(f"/api/objects/{cable['id']}", json={"properties": props})
        r = await c.post(f"/api/v3/rf-cables/{cable['id']}/align-candidates", json={"end": loose_end})
        assert r.status_code == 200, r.text
        cands = r.json()["candidates"]
        assert cands and cands[0]["targetObjectId"] == str(lab.obj[key])
        assert cands[0]["targetAnchorName"] == name
        # Measured with the end's bound connector (the SMA's 25.45 mm, as
        # connect mated it): the loosened end is still ON its port. Until
        # 2026-09-22 the procedural 15.5 mm read it as 9.95 mm off.
        assert cands[0]["distMm"] < 1e-6
        a = await c.post(f"/api/v3/rf-cables/{cable['id']}/align", json={
            "end": loose_end, "target": {"objectId": str(lab.obj[key]), "anchorName": name},
        })
        miss = await c.post(f"/api/v3/rf-cables/{cable['id']}/align", json={
            "end": loose_end, "target": _port(lab, "switch", "RF1"),
        })
    assert a.status_code == 200, a.text
    aligned = a.json()["object"]
    assert aligned["properties"]["rfCableEndpoints"][loose_end]["targetAnchorName"] == name
    # The port is where the tracer puts it, whatever the instrument's rotation.
    _assert_on_port(*_mating_face(aligned, loose_end, SMA_TIP), lab.port_lab(key, name))
    assert miss.status_code == 422 and miss.json()["detail"].startswith("target_not_in_range: ")


async def test_disconnect_removes_the_cable_and_is_a_no_op_on_an_unlinked_end(lab, events):
    async with _client() as c:
        cable = (await c.post("/api/v3/rf-cables/connect", json={
            "a": _port(lab, "dds", "CH0"), "b": _port(lab, "amp", "rf_in"),
        })).json()["object"]
        props = dict(cable["properties"])
        props["rfCableEndpoints"] = {"A": props["rfCableEndpoints"]["A"]}
        await c.put(f"/api/objects/{cable['id']}", json={"properties": props})
        noop = await c.post(f"/api/v3/rf-cables/{cable['id']}/disconnect", json={"end": "B"})
        events.clear()
        r = await c.post(f"/api/v3/rf-cables/{cable['id']}/disconnect", json={"end": "A"})
        not_cable = await c.post(f"/api/v3/rf-cables/{lab.obj['amp']}/disconnect", json={"end": "A"})
    assert noop.status_code == 200
    assert noop.json()["object"]["id"] == cable["id"] and noop.json()["deletedObjectIds"] == []
    assert r.json() == {"object": None, "deletedObjectIds": [cable["id"]], "deletedTimingProgramIds": []}
    assert [t for t, _ in events] == ["object.deleted", "physics_element.updated"]
    async with AsyncSessionLocal() as db:
        assert await db.get(SceneObject, uuid.UUID(cable["id"])) is None
    assert not_cable.status_code == 422 and not_cable.json()["detail"].startswith("not_an_rf_cable: ")


async def test_disconnect_refuses_a_locked_cable(lab):
    async with _client() as c:
        cable = (await c.post("/api/v3/rf-cables/connect", json={
            "a": _port(lab, "dds", "CH0"), "b": _port(lab, "amp", "rf_in"),
        })).json()["object"]
        await c.put(f"/api/objects/{cable['id']}", json={"locked": True})
        r = await c.post(f"/api/v3/rf-cables/{cable['id']}/disconnect", json={"end": "A"})
    assert r.status_code == 409 and r.json()["detail"].startswith("locked: ")
    async with AsyncSessionLocal() as db:
        assert await db.get(SceneObject, uuid.UUID(cable["id"])) is not None


# ─── PPG ────────────────────────────────────────────────────────────────────

def _ppg_rf_out_lab(ppg: dict) -> tuple[list[float], list[float]]:
    pose = V3Pose(ppg["xMm"], ppg["yMm"], ppg["zMm"], ppg["rxDeg"], ppg["ryDeg"], ppg["rzDeg"])
    p = point_body_to_lab(Vec3(0, 0, 4.8), pose)
    d = dir_body_to_lab(Vec3(0, 0, 1), pose)
    return [p.x, p.y, p.z], [d.x, d.y, d.z]


@pytest.mark.parametrize("key", ["switch", "switch_mr"])
async def test_ppg_attach_plugs_a_new_ppg_into_the_gate_input(lab, events, key):
    """``switch_mr`` is multi-root: its PPG mounts too (fixed 2026-09-22)."""
    name = await _next_ppg_name()
    async with _client() as c:
        r = await c.post("/api/v3/ppg/attach", json={"target": _port(lab, key, "ttl_in")})
    assert r.status_code == 200, r.text
    body = r.json()
    ppg, program = body["object"], body["timingProgram"]
    assert ppg["componentId"] == str(lab.comp["ppg"])
    assert ppg["name"] == program["name"] == name
    assert program["intervals"] == []
    assert ppg["properties"] == {"ppgAttachment": {
        "targetObjectId": str(lab.obj[key]), "targetAnchorId": "ttl_in", "targetAnchorName": "ttl_in",
    }}
    async with AsyncSessionLocal() as db:
        pe = await db.scalar(select(PhysicsElement).where(PhysicsElement.object_id == uuid.UUID(ppg["id"])))
    assert pe.element_kind == "programmable_pulse_generator"
    # What the web's {connectorType, timingProgramId, outputDomain,
    # highVoltageV} becomes through the same schema the physics-elements
    # route runs (ProgrammablePulseGeneratorParams keeps the program and a
    # default restState; the binding check stamps outputDomain) — the live
    # rows read the same.
    assert pe.kind_params == {"timingProgramId": program["id"], "restState": "LOW", "outputDomain": "rfout"}

    # Mounted: the plug TIP (rf_out + 9 mm protrusion along it) on the port,
    # the plug facing into it. 1e-6: the stored pose is on the 1 nm grid.
    rf_out, facing = _ppg_rf_out_lab(ppg)
    port, axis = lab.port_lab(key, "ttl_in")
    tip = [rf_out[i] + facing[i] * 9.0 for i in range(3)]
    assert math.dist(tip, [port.x, port.y, port.z]) < 1e-5
    assert math.dist(facing, [-axis.x, -axis.y, -axis.z]) < 1e-8

    kinds = [t for t, _ in events]
    assert kinds[0] == "timing_program.updated"
    assert {"object.updated", "collection_member.updated", "physics_element.updated"} <= set(kinds)


async def test_ppg_attach_steps_past_a_taken_name(lab):
    """The web named a PPG ``CH<number of PPGs>`` and 409'd when an object
    already had that name (e.g. CH0 deleted out of {CH0, CH1} → "CH1"
    again). Both clients now take the next free ``CH<n>``."""
    name = await _next_ppg_name()
    n = int(name[2:])
    async with _client() as c:
        # Take that name, in lower case: names are unique case-insensitively.
        await c.put(f"/api/objects/{lab.obj['amp']}", json={"name": name.lower()})
        r = await c.post("/api/v3/ppg/attach", json={"target": _port(lab, "switch", "ttl_in")})
    assert r.status_code == 200, r.text
    assert r.json()["object"]["name"] == r.json()["timingProgram"]["name"] == f"CH{n + 1}"


async def test_ppg_attach_rolls_back_whole_when_a_step_fails(lab, monkeypatch):
    """The program and the object are flushed before the PhysicsElement is
    written; a failure there must leave neither behind (the rollback the web
    does by hand in createPpgAtPort is the transaction's)."""
    from fastapi import HTTPException

    from app.optical.rf_cables import service

    async def fail(*_args, **_kwargs):
        raise HTTPException(status_code=400, detail="PPG timingProgramId does not exist")

    monkeypatch.setattr(service, "_write_ppg_element", fail)
    programs = await _count(TimingProgram)
    objects = await _count(SceneObject)
    async with _client() as c:
        r = await c.post("/api/v3/ppg/attach", json={"target": _port(lab, "switch", "ttl_in")})
    assert r.status_code == 400
    assert await _count(TimingProgram) == programs
    assert await _count(SceneObject) == objects


async def test_ppg_attach_rules(lab):
    async with _client() as c:
        first = await c.post("/api/v3/ppg/attach", json={"target": _port(lab, "switch", "ttl_in")})
        busy = await c.post("/api/v3/ppg/attach", json={"target": _port(lab, "switch", "ttl_in")})
        not_gate = await c.post("/api/v3/ppg/attach", json={"target": _port(lab, "amp", "rf_in")})
    assert first.status_code == 200
    assert busy.status_code == 409 and busy.json()["detail"].startswith("port_busy: ")
    assert not_gate.status_code == 422 and not_gate.json()["detail"].startswith("not_a_gate_input: ")


async def test_ppg_resnap_and_detach(lab, events):
    async with _client() as c:
        ppg = (await c.post("/api/v3/ppg/attach", json={"target": _port(lab, "switch", "ttl_in")})).json()
        ppg_id, program_id = ppg["object"]["id"], ppg["timingProgram"]["id"]
        await _move(lab.obj["switch"], lab, "switch", 30.0)
        r = await c.post("/api/v3/rf-cables/resnap", json={"movedObjectIds": [str(lab.obj["switch"])]})
        (moved,) = r.json()["updated"]
        assert moved["id"] == ppg_id
        assert abs(moved["xMm"] - (ppg["object"]["xMm"] + 30.0)) < 1e-6
        not_ppg = await c.post(f"/api/v3/ppg/{lab.obj['amp']}/detach")
        events.clear()
        d = await c.post(f"/api/v3/ppg/{ppg_id}/detach")
    assert not_ppg.status_code == 422 and not_ppg.json()["detail"].startswith("not_a_ppg: ")
    assert d.status_code == 200
    assert d.json() == {"deletedObjectIds": [ppg_id], "deletedTimingProgramIds": [program_id]}
    assert [t for t, _ in events] == ["object.deleted", "physics_element.updated", "timing_program.deleted"]
    async with AsyncSessionLocal() as db:
        assert await db.get(TimingProgram, uuid.UUID(program_id)) is None
