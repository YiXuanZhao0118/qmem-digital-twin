"""RF ports are posed through their binding chain — and that pose is the tracer's.

Until 2026-09-22 every RF port lookup (connect, resnap, align candidates, the
PPG mount; ``app/optical/rf_cables/*`` and the web copies they are pinned to)
placed a port as ``object pose ∘ anchor-in-its-own-asset-frame``: exact only
for a port on an identity root binding. Now each goes through
``ports.port_poses`` / ``find_port_pose`` (``anchor_poses.resolve_anchor_poses_lab``).

``test_rf_cables_parity.py`` pins that to the TypeScript. This file pins it to
the TRACER: on a real database with ports on a rotated + offset CHILD binding
carrying an ObjectBinding delta, on a rotated ROOT binding, behind a
per-instance asset swap, and a PPG whose own plug sits on a rotated binding,

* a port's posed lab pose equals what ``POST /api/v3/anchors/traced``
  (``db_scene_loader.load_anchor_scene_from_db`` projected through each
  slot's ``effective_transform``) reports for that anchor;
* connect, resnap and PPG attach, re-read through the tracer's loader, put
  the cable's mating face / the PPG's plug tip on that traced port.

Runs on whatever ``DATABASE_URL`` points at (a scratch database — never the
live one); every row it creates is removed again.
"""

from __future__ import annotations

import math
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select

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
from app.optical.pose import dir_body_to_lab, point_body_to_lab
from app.optical.rf_cables.geometry import pose_of
from app.optical.rf_cables.ports import find_port_pose
from app.optical.rf_cables.service import load_rf_scene
from app.routers.v3_anchors import traced_anchor_poses
from tests.optical.rf_bench_cleanup import purge_bench

SMA_TIP = 25.45
PPG_PROTRUSION = 9.0


@pytest.fixture(autouse=True)
async def _reset_engine_pool():
    from app.db import engine

    await engine.dispose()
    yield


def _a(aid, pos, x, y=(0, 1, 0), *, name=None, connector=None) -> dict:
    """A tri-axis anchor (the loader traces only assets whose anchors carry
    the full frame)."""
    z = (x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0])
    d = {
        "id": aid,
        "positionMmBodyLocal": dict(zip("xyz", pos)),
        "axisXBodyLocal": dict(zip("xyz", x)),
        "axisYBodyLocal": dict(zip("xyz", y)),
        "axisZBodyLocal": dict(zip("xyz", z)),
    }
    if name is not None:
        d["name"] = name
    if connector is not None:
        d["connectorType"] = connector
    return d


@pytest.fixture
async def bench():
    tag = uuid.uuid4().hex[:8]
    ids: dict[str, list] = {"ob": [], "objects": [], "bindings": [], "components": [], "assets": []}
    out: dict[str, str] = {}
    async with AsyncSessionLocal() as db:
        async def asset(key, kind, anchors, params=None):
            row = Asset3D(name=f"t-rfchain-{key}-{tag}", asset_type="glb", file_path=f"{key}.glb",
                          kind_id=kind, default_params=params or {}, tunable_params=[], anchors=anchors)
            db.add(row)
            await db.flush()
            ids["assets"].append(row.id)
            return row

        async def component(key, kind, props=None):
            row = Component(name=f"t-rfchain-{key}-{tag}", kind_id=kind, properties=props or {})
            db.add(row)
            await db.flush()
            ids["components"].append(row.id)
            return row

        async def bind(comp, a, role, *, parent=None, pos=(0, 0, 0), rot=(0, 0, 0), props=None, sort=0):
            row = ComponentBinding(
                component_id=comp.id, target_kind="asset", asset_3d_id=a.id, role=role,
                parent_binding_id=parent.id if parent is not None else None,
                local_x_mm=pos[0], local_y_mm=pos[1], local_z_mm=pos[2],
                local_rx_deg=rot[0], local_ry_deg=rot[1], local_rz_deg=rot[2],
                properties=props or {}, sort_order=sort,
            )
            db.add(row)
            await db.flush()
            ids["bindings"].append(row.id)
            return row

        async def place(key, comp, kind, pos, rot):
            so = SceneObject(component_id=comp.id, name=f"T_RFCHAIN_{key.upper()}_{tag}",
                             x_mm=pos[0], y_mm=pos[1], z_mm=pos[2], rx_deg=rot[0], ry_deg=rot[1], rz_deg=rot[2])
            db.add(so)
            await db.flush()
            ids["objects"].append(so.id)
            db.add(PhysicsElement(object_id=so.id, element_kind=kind, kind_params={}))
            out[key] = str(so.id)
            return so

        sma = await asset("sma", "rf_cable_connector", [
            _a("connect_out", (-4, 0, 0), (1, 0, 0)),
            _a("connect_in", (-29.45, 0, 0), (-1, 0, 0)),
        ], {"family": "sma", "gender": "male"})
        dds = await asset("dds", "rf_source", [
            _a("rf_out", (-20, 5, 12), (0, 0, 1), name="CH0", connector="sma_female"),
        ])
        amp_body = await asset("ampbody", "rf_amplifier", [])
        amp = await asset("amp", "rf_amplifier", [
            _a("rf_in", (-55.5, 0, 0), (-1, 0, 0), connector="sma_female"),
            _a("rf_out", (55.5, 0, 0), (1, 0, 0), connector="sma_female"),
        ])
        amp_alt = await asset("ampalt", "rf_amplifier", [
            _a("rf_in", (-40, 10, 5), (-0.8, 0.6, 0), (0.6, 0.8, 0), connector="sma_female"),
            _a("rf_out", (40, 10, 5), (1, 0, 0), connector="sma_female"),
        ])
        switch = await asset("switch", "rf_switch", [
            _a("rf_in", (0, -12.5, 9), (0, -1, 0), (1, 0, 0), connector="bnc_female"),
            _a("ttl_in", (20, 0, 9), (1, 0, 0), connector="bnc_female"),
        ])
        ppg = await asset("ppg", "programmable_pulse_generator", [
            _a("rf_out", (0, 0, 4.8), (0, 0, 1), connector="bnc_male"),
        ], {"matingProtrusionMm": PPG_PROTRUSION})

        c_cable = await component("cable", "rf_cable")
        await bind(c_cable, sma, "end_a", props={"splineEnd": "A"})
        await bind(c_cable, sma, "end_b", props={"splineEnd": "B"}, sort=1)
        c_dds = await component("dds", "rf_source")
        await bind(c_dds, dds, "root")
        # Ports on a rotated + offset CHILD binding under a body root.
        c_amp = await component("amp", "rf_amplifier")
        b_body = await bind(c_amp, amp_body, "body")
        b_ports = await bind(c_amp, amp, "ports", parent=b_body, pos=(12, -7, 25), rot=(30, -60, 45), sort=1)
        # Ports on a rotated + offset ROOT binding.
        c_switch = await component("switch", "rf_switch")
        await bind(c_switch, switch, "root", pos=(5, -3, 8), rot=(0, 0, 90))
        # A plain amp whose one instance swaps its asset.
        c_amp_plain = await component("ampplain", "rf_amplifier")
        b_plain = await bind(c_amp_plain, amp, "root")
        # The PPG's own plug on a rotated + offset root binding.
        c_ppg = await component("ppg", "programmable_pulse_generator", {"connectorType": "bnc"})
        await bind(c_ppg, ppg, "root", pos=(1.5, -2, 3), rot=(0, 90, 30))

        await place("dds", c_dds, "rf_source", (-910.099, 754.744, -6000), (-90, 0, 180))
        o_amp = await place("amp", c_amp, "rf_amplifier", (-1300, 300, -6000), (15, -40, 120))
        await place("switch", c_switch, "rf_switch", (-1100, 650, -6000), (-90, 0, 180))
        o_swap = await place("swap", c_amp_plain, "rf_amplifier", (-1700, 200, -6000), (0, 0, 45))
        for row in (
            ObjectBinding(object_id=o_amp.id, component_binding_id=b_ports.id,
                          local_x_mm_delta=4.0, local_ry_deg_delta=-20.0, local_rz_deg_delta=7.0),
            ObjectBinding(object_id=o_swap.id, component_binding_id=b_plain.id,
                          local_x_mm_delta=2.0, local_z_mm_delta=1.0, asset_3d_id_override=amp_alt.id),
        ):
            db.add(row)
            await db.flush()
            ids["ob"].append(row.id)
        await db.commit()
    try:
        yield out
    finally:
        async with AsyncSessionLocal() as db:
            objs = (await db.scalars(select(SceneObject).where(SceneObject.component_id.in_(ids["components"])))).all()
            # The hosts, plus what connect / attach hung on them - swept by
            # LINK, since on the dev database the endpoints pick the
            # catalog's cable / PPG Components (rf_bench_cleanup).
            await purge_bench(db, [o.id for o in objs])
            await db.execute(delete(ComponentBinding).where(ComponentBinding.id.in_(ids["bindings"])))
            await db.execute(delete(Component).where(Component.id.in_(ids["components"])))
            await db.execute(delete(Asset3D).where(Asset3D.id.in_(ids["assets"])))
            await db.commit()


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _traced(object_id: str, anchor_id: str, name: str):
    """The anchor as the tracer receives it (``POST /api/v3/anchors/traced``)."""
    async with AsyncSessionLocal() as db:
        hits = [
            t for t in traced_anchor_poses(await load_anchor_scene_from_db(db))
            if t.object_id == object_id and t.anchor_id == anchor_id and t.anchor_name == name
        ]
    assert len(hits) == 1, (object_id, anchor_id, name, len(hits))
    t = hits[0]
    return (t.pos_lab.x, t.pos_lab.y, t.pos_lab.z), (t.axis_x_lab.x, t.axis_x_lab.y, t.axis_x_lab.z)


def _mating_face(cable: dict, end: str) -> tuple[list[float], list[float]]:
    nodes = cable["properties"]["rfCableNodes"]
    node = nodes[0] if end == "A" else nodes[-1]
    handle = node["handleOutMm"] if end == "A" else node["handleInMm"]
    m = math.hypot(*handle)
    outward = [-h / m for h in handle]
    origin = [cable["xMm"], cable["yMm"], cable["zMm"]]
    return [origin[i] + node["posMm"][i] + outward[i] * SMA_TIP for i in range(3)], outward


def _on(face, outward, traced) -> None:
    pos, axis = traced
    assert math.dist(face, pos) < 1e-6, (face, pos)
    assert math.dist(outward, [-a for a in axis]) < 1e-9


PORTS = [
    ("amp", "rf_in", "rf_in"),      # rotated child binding + ObjectBinding delta
    ("amp", "rf_out", "rf_out"),
    ("switch", "ttl_in", "ttl_in"),  # rotated root binding
    ("swap", "rf_in", "rf_in"),     # per-instance asset swap (+ delta)
    ("dds", "rf_out", "CH0"),       # identity root binding (the live shape)
]


async def test_a_posed_port_is_the_traced_anchor(bench):
    async with AsyncSessionLocal() as db:
        scene = await load_rf_scene(db)
    for key, anchor_id, name in PORTS:
        obj = scene.object_by_id[bench[key]]
        placed = find_port_pose(scene, obj, anchor_id, name)
        assert placed is not None, key
        pose = pose_of(obj)
        p = point_body_to_lab(Vec3(*placed.pos_cad), pose)
        d = dir_body_to_lab(Vec3(*placed.dir_cad), pose)
        tpos, taxis = await _traced(bench[key], anchor_id, name)
        assert math.dist((p.x, p.y, p.z), tpos) < 1e-9, (key, anchor_id)
        assert math.dist((d.x, d.y, d.z), taxis) < 1e-12, (key, anchor_id)
        if key in ("amp", "switch"):
            # ... and the old reading (the anchor as stored, under the object
            # pose) was nowhere near it, so this proves something.
            raw = placed.anchor["positionMmBodyLocal"]
            old = point_body_to_lab(Vec3(raw["x"], raw["y"], raw["z"]), pose)
            assert math.dist((old.x, old.y, old.z), tpos) > 5.0, (key, anchor_id)
        if key == "swap":
            # The swapped asset's port, as the tracer — not the catalog's.
            assert placed.anchor["positionMmBodyLocal"] == {"x": -40, "y": 10, "z": 5}


async def test_connect_and_resnap_land_on_the_traced_ports(bench):
    async with _client() as c:
        r = await c.post("/api/v3/rf-cables/connect", json={
            "a": {"objectId": bench["dds"], "anchorName": "CH0"},
            "b": {"objectId": bench["amp"], "anchorName": "rf_in"},
        })
        assert r.status_code == 200, r.text
        cable = r.json()["object"]
        _on(*_mating_face(cable, "A"), await _traced(bench["dds"], "rf_out", "CH0"))
        _on(*_mating_face(cable, "B"), await _traced(bench["amp"], "rf_in", "rf_in"))

        # Move and turn the instrument; the resnap follows the TRACED port.
        async with AsyncSessionLocal() as db:
            so = await db.get(SceneObject, uuid.UUID(bench["amp"]))
            so.x_mm += 37.5
            so.rz_deg = 95.0
            await db.commit()
        r = await c.post("/api/v3/rf-cables/resnap", json={"movedObjectIds": [bench["amp"]]})
        assert r.status_code == 200, r.text
        (updated,) = r.json()["updated"]
        _on(*_mating_face(updated, "B"), await _traced(bench["amp"], "rf_in", "rf_in"))

        # A per-instance swap: the cable mates the SWAPPED asset's port.
        r = await c.post("/api/v3/rf-cables/connect", json={
            "a": {"objectId": bench["amp"], "anchorName": "rf_out"},
            "b": {"objectId": bench["swap"], "anchorName": "rf_in"},
        })
        assert r.status_code == 200, r.text
        _on(*_mating_face(r.json()["object"], "B"), await _traced(bench["swap"], "rf_in", "rf_in"))


async def test_ppg_plug_tip_lands_on_the_traced_gate(bench):
    async with _client() as c:
        r = await c.post("/api/v3/ppg/attach", json={"target": {"objectId": bench["switch"], "anchorName": "ttl_in"}})
    assert r.status_code == 200, r.text
    ppg = r.json()["object"]
    # The PPG's own rf_out as the tracer places it — through the PPG's
    # rotated root binding, under the stored (mounted) pose.
    plug, facing = await _traced(ppg["id"], "rf_out", "rf_out")
    port, axis = await _traced(bench["switch"], "ttl_in", "ttl_in")
    tip = [plug[i] + facing[i] * PPG_PROTRUSION for i in range(3)]
    # 1e-5: the stored pose is on the 1 nm / 1e-9 deg grid.
    assert math.dist(tip, port) < 1e-5
    assert math.dist(facing, [-a for a in axis]) < 1e-8
