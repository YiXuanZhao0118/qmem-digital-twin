"""POST /api/v3/fibers/* and /api/v3/pigtails/* against a real database.

``test_fiber_parity.py`` pins the maths and the store flows to the
TypeScript. This file pins what the endpoints add, and — the reason they
exist — that what they write is physically right when read back through the
TRACER's own loader (``load_anchor_scene_from_db``):

* a plugged fibre's synthesized coupling face sits ``FIBER_MATING_GAP_MM``
  from the port the tracer hit-tests, facing along the port's axisX (End B) or
  against it (End A) — on a receiver that is tilted AND bound through a
  rotated binding, where the web store's own port sweep (a pre-2026-06-01
  rotation convention, no binding transform) would miss the port by
  centimetres;
* a pigtail end moves the CONNECTOR (an ObjectBinding delta) and the
  re-seated port lands one mating gap from the receptacle; the housing does
  not move;
* re-snap follows a moved instrument, skips what it cannot resolve;
* one transaction (a rejected write leaves nothing behind), the usual
  ``/ws/scene`` events, 404 / 422 with the reason.

Runs against ``DATABASE_URL`` with uniquely-named scratch rows, removed on
teardown.
"""

from __future__ import annotations

import math
import uuid

import httpx
import pytest
from sqlalchemy import delete, select, update

from app.db import AsyncSessionLocal
from app.main import app
from app.models import (
    Asset3D,
    Component,
    ComponentBinding,
    ObjectBinding,
    PhysicsElement,
    SceneObject,
)
from app.optical.beam_ray import Vec3
from app.optical.db_scene_loader import load_anchor_scene_from_db
from app.optical.pose import dir_body_to_lab_t, point_body_to_lab_t

GAP = 0.01
TOL = 1e-9


@pytest.fixture(autouse=True)
async def _reset_engine_pool():
    """pytest-asyncio gives each test a fresh loop; re-bind the engine pool."""
    from app.db import engine

    await engine.dispose()
    yield


def _axes(x, y):
    z = (x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0])
    return {
        "axisXBodyLocal": {"x": x[0], "y": x[1], "z": x[2]},
        "axisYBodyLocal": {"x": y[0], "y": y[1], "z": y[2]},
        "axisZBodyLocal": {"x": z[0], "y": z[1], "z": z[2]},
    }


def _anchor(aid, pos, x=(1, 0, 0), y=(0, 1, 0), **extra):
    return {"id": aid, "positionMmBodyLocal": {"x": pos[0], "y": pos[1], "z": pos[2]}, **_axes(x, y), **extra}


# The PM FC/APC connector, as the catalog stores it after alembic 0135.
CONNECTOR_ANCHORS = [
    _anchor("fiber_root", (0, 0, 0), (0, 0, -1), (0, 1, 0)),
    _anchor("fiber_out", (0.009, -0.051, 59.333), (0, 0, 1), (0, 1, 0),
            apertureMm=2.5, connectorType="fc_apc_male"),
]
PORT_IN_POSE = (-91.2362, 0.0, 0.0, 0.0, -82.000011642, -90.00011058)
PORT_OUT_POSE = (221.2362, 0.0, 0.0, 0.0, 82.000011642, 89.99988942)


@pytest.fixture
async def bench():
    """A receiver with a female FC bulkhead — tilted, and bound through a
    rotated binding — a free-space mirror, a patch cable whose ends are only
    kindParams, and a two-pigtail EOM."""
    tag = uuid.uuid4().hex[:8]
    ids: dict[str, uuid.UUID] = {}
    async with AsyncSessionLocal() as db:
        def asset(key, kind, anchors):
            row = Asset3D(name=f"fibtest_{key}_{tag}", asset_type="glb", file_path=f"files/{key}.glb",
                          kind_id=kind, anchors=anchors, default_params={})
            db.add(row)
            return row

        a_det = asset("det", "detector", [
            _anchor("fiber_in", (-4, 10.258, 17.584), (-1, 0, 0), (0, 1, 0),
                    name="OPTICAL IN", connectorType="fc_pc_female", apertureMm=1.25),
        ])
        a_mir = asset("mir", "mirror", [_anchor("intercept_face", (0, 0, 0), (0, 0, 1), (0, 1, 0))])
        a_conn = asset("conn", "fiber_connector", CONNECTOR_ANCHORS)
        a_eom = asset("eom", "eom", [
            _anchor("intercept_in", (0, 0, 0), (1, 0, 0), (0, 0, 1), apertureMm=0.5),
            _anchor("intercept_out", (130, 0, 0), (1, 0, 0), (0, 0, 1), apertureMm=0.5),
        ])
        await db.flush()

        def comp(key, kind):
            row = Component(name=f"fibtest_{key}_{tag}", kind_id=kind, properties={})
            db.add(row)
            return row

        c_det, c_mir, c_fib, c_eom = comp("det", "detector"), comp("mir", "mirror"), comp("fib", "fiber"), comp("eom", "eom")
        await db.flush()

        def bind(c, a, role, pose=(0, 0, 0, 0, 0, 0), props=None, order=0):
            row = ComponentBinding(
                component_id=c.id, target_kind="asset", asset_3d_id=a.id, role=role,
                local_x_mm=pose[0], local_y_mm=pose[1], local_z_mm=pose[2],
                local_rx_deg=pose[3], local_ry_deg=pose[4], local_rz_deg=pose[5],
                properties=props or {}, sort_order=order,
            )
            db.add(row)
            return row

        bind(c_det, a_det, "body", (3, -2, 5, 20, -35, 60))
        bind(c_mir, a_mir, "body")
        bind(c_fib, a_conn, "end_a")
        bind(c_fib, a_conn, "end_b", order=1)
        bind(c_eom, a_eom, "modulator")
        b_in = bind(c_eom, a_conn, "port_in", PORT_IN_POSE, {"portAnchor": "intercept_in"}, 1)
        b_out = bind(c_eom, a_conn, "port_out", PORT_OUT_POSE, {
            "portAnchor": "intercept_out",
            "fiberNodes": [
                {"posMm": [130, 0, 0], "handleOutMm": [17.6, 0, -10.2]},
                {"posMm": [196.479, 0, -3.479], "handleInMm": [-17.6, 0, -10.2]},
            ],
        }, 2)
        await db.flush()

        def obj(key, c, pose, props=None):
            row = SceneObject(
                name=f"FIBTEST_{key}_{tag}", component_id=c.id,
                x_mm=pose[0], y_mm=pose[1], z_mm=pose[2], rx_deg=pose[3], ry_deg=pose[4], rz_deg=pose[5],
                properties=props or {},
            )
            db.add(row)
            return row

        o_det = obj("det", c_det, (400, 50, 900, 135, 10, 30))
        o_mir = obj("mir", c_mir, (380, 40, 900, 0, 0, 0))
        o_fib = obj("fib", c_fib, (100, -30, 880, 5, -15, 70))
        o_eom = obj("eom", c_eom, (-300, 20, 950, 0, 0, 180))
        await db.flush()
        db.add(PhysicsElement(
            object_id=o_fib.id, element_kind="fiber",
            kind_params={
                "fiberType": "single_mode",
                "endA": {"posMm": [0, 0, 0], "tensionHandleMm": [10, 0, 0]},
                "endB": {"posMm": [300, 0, 0], "tensionHandleMm": [-10, 0, 0]},
            },
        ))
        await db.commit()
        ids.update(
            det=o_det.id, mir=o_mir.id, fib=o_fib.id, eom=o_eom.id,
            b_in=b_in.id, b_out=b_out.id,
            assets=[a_det.id, a_mir.id, a_conn.id, a_eom.id],
            comps=[c_det.id, c_mir.id, c_fib.id, c_eom.id],
        )
    yield ids
    async with AsyncSessionLocal() as db:
        await db.execute(delete(SceneObject).where(SceneObject.id.in_([ids["det"], ids["mir"], ids["fib"], ids["eom"]])))
        await db.execute(delete(Component).where(Component.id.in_(ids["comps"])))
        await db.execute(delete(Asset3D).where(Asset3D.id.in_(ids["assets"])))
        await db.commit()


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _post(path: str, body: dict) -> httpx.Response:
    async with _client() as c:
        return await c.post(path, json=body)


async def _traced_anchor(object_id, anchor_id, kind=None):
    """(lab position, lab axisX) of an anchor exactly as the tracer's loader
    hands it over."""
    async with AsyncSessionLocal() as db:
        scene = await load_anchor_scene_from_db(db)
    for slot in scene.slots:
        if slot.scene_object_id != str(object_id) or (kind and slot.asset.kind != kind):
            continue
        for a in slot.asset.anchors:
            if a.id == anchor_id:
                return (point_body_to_lab_t(a.position_body, slot.effective_transform),
                        dir_body_to_lab_t(a.axis_x_body, slot.effective_transform))
    raise AssertionError(f"{anchor_id} of {object_id} not in the traced scene")


def _dist(a: Vec3, b: Vec3) -> float:
    return math.dist((a.x, a.y, a.z), (b.x, b.y, b.z))


async def _row(model, object_id):
    async with AsyncSessionLocal() as db:
        if model is SceneObject:
            return await db.get(SceneObject, object_id)
        return (await db.scalars(select(model).where(model.object_id == object_id))).all()


# ─── fibres ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("end", ["A", "B"])
async def test_connect_mates_the_face_on_the_port_the_tracer_hits(bench, end) -> None:
    r = await _post(f"/api/v3/fibers/{bench['fib']}/connect",
                    {"end": end, "target": {"objectId": str(bench["det"]), "anchorName": "OPTICAL IN"}})
    assert r.status_code == 200, r.text
    body = r.json()
    link = {"targetObjectId": str(bench["det"]), "targetAnchorId": "fiber_in", "targetAnchorName": "OPTICAL IN"}
    assert body["object"]["properties"]["fiberEndpoints"] == {end: link}
    node = body["object"]["properties"]["fiberNodes"][0 if end == "A" else -1]
    # The write-through: kindParams carries the same junction the nodes do.
    assert body["physicsElement"]["kindParams"]["end" + end]["posMm"] == node["posMm"]

    port, axis = await _traced_anchor(bench["det"], "fiber_in")
    face, facing = await _traced_anchor(bench["fib"], "intercept_in" if end == "A" else "intercept_out", "fiber")
    sign = 1.0 if end == "A" else -1.0  # End A sits downstream of the plane, End B upstream
    expected = Vec3(port.x + sign * GAP * axis.x, port.y + sign * GAP * axis.y, port.z + sign * GAP * axis.z)
    assert _dist(face, expected) < TOL
    # NOT anti-parallel: End B faces along the port's axisX, End A against it.
    assert facing.dot(axis) == pytest.approx(-sign, abs=1e-12)


async def test_resnap_carries_a_plugged_end_with_its_instrument(bench) -> None:
    r = await _post(f"/api/v3/fibers/{bench['fib']}/connect",
                    {"end": "B", "target": {"objectId": str(bench["det"]), "anchorName": "OPTICAL IN"}})
    assert r.status_code == 200, r.text
    async with _client() as c:
        moved = await c.put(f"/api/objects/{bench['det']}", json={"xMm": 425.5, "rzDeg": 70.0})
    assert moved.status_code == 200
    r = await _post("/api/v3/fibers/resnap", {"movedObjectIds": [str(bench["det"]), str(uuid.uuid4())]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert [(d["objectId"], d["end"]) for d in body["resnapped"]] == [(str(bench["fib"]), "B")]
    assert body["updated"][0]["properties"]["fiberEndpoints"]["B"]["targetObjectId"] == str(bench["det"])
    port, axis = await _traced_anchor(bench["det"], "fiber_in")
    face, _ = await _traced_anchor(bench["fib"], "intercept_out", "fiber")
    assert _dist(face, Vec3(port.x - GAP * axis.x, port.y - GAP * axis.y, port.z - GAP * axis.z)) < TOL

    # Idempotent: nothing moved, nothing changes.
    again = (await _post("/api/v3/fibers/resnap", {"movedObjectIds": [str(bench["det"])]})).json()
    assert again["updated"][0]["properties"]["fiberNodes"] == body["updated"][0]["properties"]["fiberNodes"]


async def test_resnap_leaves_an_unresolvable_link_alone(bench) -> None:
    ghost = {"targetObjectId": str(bench["det"]), "targetAnchorId": "fiber_in", "targetAnchorName": "NOT THERE"}
    async with AsyncSessionLocal() as db:
        await db.execute(update(SceneObject).where(SceneObject.id == bench["fib"])
                         .values(properties={"fiberEndpoints": {"A": ghost}}))
        await db.commit()
    body = (await _post("/api/v3/fibers/resnap", {"movedObjectIds": [str(bench["det"])]})).json()
    assert body == {"resnapped": [], "updated": [], "physicsElements": []}
    assert (await _row(SceneObject, bench["fib"])).properties == {"fiberEndpoints": {"A": ghost}}


async def test_disconnect_unplugs_without_moving_the_cable(bench) -> None:
    await _post(f"/api/v3/fibers/{bench['fib']}/connect",
                {"end": "A", "target": {"objectId": str(bench["det"]), "anchorName": "OPTICAL IN"}})
    before = (await _row(SceneObject, bench["fib"])).properties["fiberNodes"]
    r = await _post(f"/api/v3/fibers/{bench['fib']}/disconnect", {"end": "A"})
    assert r.status_code == 200 and r.json()["changed"] is True
    props = r.json()["object"]["properties"]
    assert props["fiberEndpoints"] == {} and props["fiberNodes"] == before
    again = await _post(f"/api/v3/fibers/{bench['fib']}/disconnect", {"end": "A"})
    assert again.json()["changed"] is False


async def test_a_beam_placement_clears_the_link_and_lands_on_the_line(bench) -> None:
    await _post(f"/api/v3/fibers/{bench['fib']}/connect",
                {"end": "A", "target": {"objectId": str(bench["det"]), "anchorName": "OPTICAL IN"}})
    a, b = (0.0, -100.0, 880.0), (400.0, 100.0, 880.0)
    r = await _post(f"/api/v3/fibers/{bench['fib']}/apply", {
        "end": "A", "target": {"beam": {"beamId": "trace:test", "aMm": a, "bMm": b}},
    })
    assert r.status_code == 200, r.text
    assert "A" not in r.json()["object"]["properties"]["fiberEndpoints"]
    face, facing = await _traced_anchor(bench["fib"], "intercept_in", "fiber")
    d = Vec3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalized()
    rel = Vec3(face.x - a[0], face.y - a[1], face.z - a[2])
    off_line = rel - d * rel.dot(d)
    assert off_line.length() < 1e-9
    assert facing.dot(d) == pytest.approx(-1.0, abs=1e-12)  # End A looks back up the beam
    # … and ON the picked point: the node is backed out by the bound
    # connector's own tip (59.33 mm here), the length the loader puts the
    # traced face at — not the 36.28 mm FC constant.
    picked = Vec3(*r.json()["candidate"]["projectedPortLab"])
    assert _dist(face, picked) < TOL


async def test_candidates_list_ports_and_write_nothing(bench) -> None:
    before = (await _row(SceneObject, bench["fib"])).properties
    r = await _post(f"/api/v3/fibers/{bench['fib']}/candidates", {"end": "B", "toleranceMm": None})
    assert r.status_code == 200, r.text
    ports = [c for c in r.json()["candidates"] if c.get("port")]
    assert {"targetObjectId": str(bench["det"]), "targetAnchorId": "fiber_in",
            "targetAnchorName": "OPTICAL IN"} in [c["port"] for c in ports]
    # A free-space face is not a port; a male ferrule is not a port.
    assert str(bench["mir"]) not in [c["port"]["targetObjectId"] for c in ports]
    assert (await _row(SceneObject, bench["fib"])).properties == before


@pytest.mark.parametrize(
    ("body", "status", "needle"),
    [
        ({"end": "B", "target": {"objectId": "MIR", "anchorName": "intercept_face"}}, 422, "has no fibre port"),
        ({"end": "B", "target": {"objectId": "FIB", "anchorName": "x"}}, 422, "its own port"),
        ({"end": "B", "target": {"objectId": "DET", "anchorName": "OPTICAL IN"}, "toleranceMm": 0.001}, 422, "beyond toleranceMm"),
        ({"end": "B", "target": {"objectId": str(uuid.uuid4()), "anchorName": "x"}}, 404, "not found"),
    ],
)
async def test_connect_refuses_with_the_reason(bench, body, status, needle) -> None:
    t = body["target"]
    t["objectId"] = {"MIR": str(bench["mir"]), "FIB": str(bench["fib"]), "DET": str(bench["det"])}.get(t["objectId"], t["objectId"])
    r = await _post(f"/api/v3/fibers/{bench['fib']}/connect", body)
    assert r.status_code == status and needle in r.json()["detail"], r.text


async def test_other_refusals(bench) -> None:
    assert (await _post(f"/api/v3/fibers/{uuid.uuid4()}/connect",
                        {"end": "A", "target": {"objectId": str(bench["det"]), "anchorName": "OPTICAL IN"}})).status_code == 404
    r = await _post(f"/api/v3/fibers/{bench['det']}/candidates", {"end": "A"})
    assert r.status_code == 422 and "no fibre spline" in r.json()["detail"]
    r = await _post(f"/api/v3/fibers/{bench['fib']}/apply", {"end": "A", "target": {"beam": {"beamId": "z", "aMm": [1, 1, 1], "bMm": [1, 1, 1]}}})
    assert r.status_code == 422 and "no alignment" in r.json()["detail"]
    r = await _post(f"/api/v3/fibers/{bench['fib']}/apply", {
        "end": "A", "target": {"objectId": str(bench["det"]), "anchorName": "OPTICAL IN", "beam": {"beamId": "z", "aMm": [0, 0, 0], "bMm": [1, 0, 0]}},
    })
    assert r.status_code == 422
    r = await _post(f"/api/v3/fibers/{bench['fib']}/connect", {"end": "C", "target": {"objectId": str(bench["det"]), "anchorName": "x"}})
    assert r.status_code == 422


async def test_a_rejected_write_leaves_nothing_behind(bench) -> None:
    """One transaction: the fibre PE's kindParams fail FiberParams, so the
    object's link / nodes must not have been committed either."""
    async with AsyncSessionLocal() as db:
        await db.execute(update(PhysicsElement).where(PhysicsElement.object_id == bench["fib"]).values(kind_params={
            "endA": {"posMm": [0, 0, 0], "tensionHandleMm": [10, 0, 0], "numericalAperture": 5},
            "endB": {"posMm": [300, 0, 0], "tensionHandleMm": [-10, 0, 0]},
        }))
        await db.commit()
    r = await _post(f"/api/v3/fibers/{bench['fib']}/connect",
                    {"end": "B", "target": {"objectId": str(bench["det"]), "anchorName": "OPTICAL IN"}})
    assert r.status_code == 422, r.text
    assert (await _row(SceneObject, bench["fib"])).properties == {}


async def test_writes_broadcast_the_usual_scene_events(bench, monkeypatch) -> None:
    from app.optical.fibers import persist

    events: list[str] = []

    async def capture(event_type, payload):
        events.append(event_type)

    monkeypatch.setattr(persist.manager, "broadcast", capture)
    await _post(f"/api/v3/fibers/{bench['fib']}/connect",
                {"end": "B", "target": {"objectId": str(bench["det"]), "anchorName": "OPTICAL IN"}})
    assert events == ["object.updated", "physics_element.updated"]
    events.clear()
    await _post(f"/api/v3/pigtails/{bench['eom']}/apply",
                {"end": "B", "target": {"objectId": str(bench["det"]), "anchorName": "OPTICAL IN"}})
    assert events == ["object.updated", "object_binding.created"]


# ─── pigtails ──────────────────────────────────────────────────────────────

async def test_pigtail_apply_moves_the_connector_not_the_housing(bench) -> None:
    before = await _row(SceneObject, bench["eom"])
    pose_before = (before.x_mm, before.y_mm, before.z_mm, before.rx_deg, before.ry_deg, before.rz_deg)
    r = await _post(f"/api/v3/pigtails/{bench['eom']}/apply",
                    {"end": "B", "target": {"objectId": str(bench["det"]), "anchorName": "OPTICAL IN"}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["objectBinding"]["componentBindingId"] == str(bench["b_out"])
    props = body["object"]["properties"]
    assert props["pigtailEndpoints"] == {"intercept_out": {
        "targetObjectId": str(bench["det"]), "targetAnchorId": "fiber_in", "targetAnchorName": "OPTICAL IN"}}
    # The jacket's last node followed the connector (the binding carried one).
    assert str(bench["b_out"]) in props["bindingFiberNodes"]
    after = await _row(SceneObject, bench["eom"])
    assert (after.x_mm, after.y_mm, after.z_mm, after.rx_deg, after.ry_deg, after.rz_deg) == pose_before

    # The loader re-seats intercept_out onto the moved connector: one mating
    # gap UPSTREAM of the receptacle (End B feeds it).
    port, axis = await _traced_anchor(bench["det"], "fiber_in")
    face, _ = await _traced_anchor(bench["eom"], "intercept_out", "eom")
    assert _dist(face, Vec3(port.x - GAP * axis.x, port.y - GAP * axis.y, port.z - GAP * axis.z)) < TOL

    r = await _post(f"/api/v3/pigtails/{bench['eom']}/candidates", {"end": "B"})
    assert r.status_code == 200
    assert r.json()["candidates"][0]["distMm"] == pytest.approx(GAP, abs=1e-9)


async def test_pigtail_resnap_and_disconnect(bench) -> None:
    await _post(f"/api/v3/pigtails/{bench['eom']}/apply",
                {"end": "A", "target": {"objectId": str(bench["det"]), "anchorName": "OPTICAL IN"}})
    async with _client() as c:
        await c.put(f"/api/objects/{bench['det']}", json={"yMm": 12.0, "rxDeg": 90.0})
    r = await _post("/api/v3/pigtails/resnap", {"movedObjectIds": [str(bench["det"])]})
    assert r.status_code == 200, r.text
    assert [(d["objectId"], d["portAnchor"]) for d in r.json()["resnapped"]] == [(str(bench["eom"]), "intercept_in")]
    port, axis = await _traced_anchor(bench["det"], "fiber_in")
    face, _ = await _traced_anchor(bench["eom"], "intercept_in", "eom")
    # End A sits one gap DOWNSTREAM (light leaves the receptacle, enters us).
    assert _dist(face, Vec3(port.x + GAP * axis.x, port.y + GAP * axis.y, port.z + GAP * axis.z)) < TOL

    r = await _post(f"/api/v3/pigtails/{bench['eom']}/disconnect", {"end": "A"})
    assert r.status_code == 200 and r.json()["changed"] is True
    assert r.json()["object"]["properties"]["pigtailEndpoints"] == {}
    assert (await _post(f"/api/v3/pigtails/{bench['eom']}/disconnect", {"end": "A"})).json()["changed"] is False
    obs = await _row(ObjectBinding, bench["eom"])
    assert {str(o.component_binding_id) for o in obs} == {str(bench["b_in"])}


async def test_pigtail_refusals(bench) -> None:
    r = await _post(f"/api/v3/pigtails/{bench['fib']}/candidates", {"end": "A"})
    assert r.status_code == 422 and "no pigtail connector" in r.json()["detail"]
    r = await _post(f"/api/v3/pigtails/{bench['eom']}/apply",
                    {"end": "A", "target": {"objectId": str(bench["mir"]), "anchorName": "intercept_face"}})
    assert r.status_code == 422 and "has no fibre port" in r.json()["detail"]
    r = await _post(f"/api/v3/pigtails/{uuid.uuid4()}/disconnect", {"end": "A"})
    assert r.status_code == 404
