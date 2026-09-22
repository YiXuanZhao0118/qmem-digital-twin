"""POST /api/v3/anchors/traced — the anchor poses the tracer's loader hands over.

Two kinds of check on one DB scene that exercises every place the loader
rewrites anchors:

* the route's output IS ``load_anchor_scene_from_db`` projected to lab mm —
  same slots, same order, same numbers;
* each rewrite, against an expectation worked out by hand (no rotations, so
  the numbers are plain sums): a pigtail port re-seated onto its connector's
  mating face, the AOM's derived ``interaction_center``, a connector fibre's
  synthesized coupling ports, a per-instance asset swap, and a sub-Component
  binding the loader does not trace.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.db import AsyncSessionLocal, get_session
from app.main import app
from app.models import (
    Asset3D,
    Component,
    ComponentBinding,
    ObjectBinding,
    PhysicsElement,
    SceneObject,
)
from app.optical.anchor_tracer import (
    V3Anchor,
    V3AnchorBindingSlot,
    V3AnchorScene,
    V3AssetAnchorSnapshot,
)
from app.optical.beam_ray import Vec3
from app.optical.db_scene_loader import load_anchor_scene_from_db
from app.optical.pose import V3Pose, dir_body_to_lab_t, point_body_to_lab_t, pose_to_transform
from app.routers import v3_anchors
from app.routers.v3_anchors import anchors_traced


@pytest.fixture(autouse=True)
async def _reset_engine_pool():
    from app.db import engine

    await engine.dispose()
    yield


Z = -7000.0  # away from anything else in the DB


def _a(aid: str, pos, x=(1, 0, 0), y=(0, 1, 0), *, name=None, ap=2.0) -> dict:
    z = (x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0])
    d = {
        "id": aid,
        "positionMmBodyLocal": {"x": pos[0], "y": pos[1], "z": pos[2]},
        "axisXBodyLocal": {"x": x[0], "y": x[1], "z": x[2]},
        "axisYBodyLocal": {"x": y[0], "y": y[1], "z": y[2]},
        "axisZBodyLocal": {"x": z[0], "y": z[1], "z": z[2]},
        "apertureMm": ap,
        "apertureShape": "circle",
    }
    if name is not None:
        d["name"] = name
    return d


@pytest.fixture
async def scene_rows():
    tag = uuid.uuid4().hex[:8]
    ids: dict[str, list] = {"ob": [], "pe": [], "objects": [], "bindings": [], "components": [], "assets": []}
    async with AsyncSessionLocal() as db:
        async def asset(key, kind, anchors, params=None):
            row = Asset3D(name=f"t-traced-{key}-{tag}", asset_type="optical", file_path="primitive://box",
                          kind_id=kind, default_params=params or {}, tunable_params=[], anchors=anchors)
            db.add(row)
            await db.flush()
            ids["assets"].append(row.id)
            return row

        async def component(key, kind="none"):
            row = Component(name=f"t-traced-{key}-{tag}", kind_id=kind)
            db.add(row)
            await db.flush()
            ids["components"].append(row.id)
            return row

        async def bind(comp, *, asset=None, sub=None, role="body", pos=(0, 0, 0), rot=(0, 0, 0), props=None):
            row = ComponentBinding(
                component_id=comp.id, target_kind="asset" if asset is not None else "subcomponent",
                asset_3d_id=asset.id if asset is not None else None,
                sub_component_id=sub.id if sub is not None else None,
                role=role, local_x_mm=pos[0], local_y_mm=pos[1], local_z_mm=pos[2],
                local_rx_deg=rot[0], local_ry_deg=rot[1], local_rz_deg=rot[2],
                properties=props or {},
            )
            db.add(row)
            await db.flush()
            ids["bindings"].append(row.id)
            return row

        async def obj(key, comp, pos, rot=(0, 0, 0), pe_kind=None, kind_params=None):
            so = SceneObject(component_id=comp.id, name=f"T_{key}_{tag}",
                             x_mm=pos[0], y_mm=pos[1], z_mm=pos[2],
                             rx_deg=rot[0], ry_deg=rot[1], rz_deg=rot[2])
            db.add(so)
            await db.flush()
            ids["objects"].append(so.id)
            if pe_kind is not None:
                pe = PhysicsElement(object_id=so.id, element_kind=pe_kind, kind_params=kind_params or {})
                db.add(pe)
                await db.flush()
                ids["pe"].append(pe.id)
            return so

        # A lens, rotated both ways, with a NAMED anchor (the generic case).
        lens = await asset("lens", "lens_biconvex", [
            _a("intercept_in", (0, 0, -2), (0, 0, -1), name="IN"),
            _a("intercept_out", (0, 0, 2), (0, 0, 1)),
        ])
        c_lens = await component("lens")
        await bind(c_lens, asset=lens, role="lens", pos=(1, 2, 3), rot=(10, -20, 30))
        o_lens = await obj("lens", c_lens, (10, 20, Z), (5, 15, -25))

        # An AOM storing only its faces: interaction_center is derived.
        aom = await asset("aom", "aom", [
            _a("intercept_in", (2, -11.2, 1), (0, -1, 0), (0, 0, 1)),
            _a("intercept_out", (2, 11.2, 1), (0, 1, 0), (0, 0, 1)),
        ])
        c_aom = await component("aom")
        await bind(c_aom, asset=aom)
        o_aom = await obj("aom", c_aom, (200, 0, Z))

        # A pigtailed device: the connector bound at intercept_in re-seats it.
        dev = await asset("dev", "eom", [
            _a("intercept_in", (-10, 0, 0), (-1, 0, 0), name="OPT IN"),
            _a("intercept_out", (10, 0, 0), (1, 0, 0)),
        ])
        conn = await asset("conn", "fiber_connector", [
            _a("fiber_root", (0, 0, 0), (1, 0, 0)),
            _a("fiber_out", (-12, 0, 0), (-1, 0, 0), ap=0.0025),
        ])
        c_dev = await component("dev")
        await bind(c_dev, asset=dev, role="modulator")
        await bind(c_dev, asset=conn, role="port_in", pos=(-20, 0, 0), props={"portAnchor": "intercept_in"})
        o_dev = await obj("dev", c_dev, (400, 0, Z))

        # A connector fibre: its coupling ports are synthesized from kindParams.
        c_fib = await component("fiber", kind="fiber")
        await bind(c_fib, asset=conn, role="end_a", props={"splineEnd": "A"})
        await bind(c_fib, asset=conn, role="end_b", props={"splineEnd": "B"})
        o_fib = await obj("fiber", c_fib, (600, 0, Z), pe_kind="fiber", kind_params={
            "endA": {"posMm": [0, 0, 0], "tensionHandleMm": [10, 0, 0]},
            "endB": {"posMm": [100, 0, 0], "tensionHandleMm": [-10, 0, 0]},
        })

        # A per-instance asset swap, and a sub-Component binding.
        mirror = await asset("mirror", "mirror", [_a("intercept_face", (0, 0, 0), (0, 0, 1))])
        swapped = await asset("swapped", "mirror", [_a("intercept_face", (0, 0, 3), (0, 0, 1), name="SWAPPED")])
        c_mir = await component("mirror")
        b_mir = await bind(c_mir, asset=mirror)
        o_swap = await obj("swap", c_mir, (800, 0, Z))
        o_plain = await obj("plain", c_mir, (900, 0, Z))
        ob = ObjectBinding(object_id=o_swap.id, component_binding_id=b_mir.id, asset_3d_id_override=swapped.id)
        db.add(ob)
        await db.flush()
        ids["ob"].append(ob.id)
        c_sub = await component("withsub")
        await bind(c_sub, asset=lens, role="lens")
        await bind(c_sub, sub=c_mir, role="nested", pos=(0, 0, 50))
        o_sub = await obj("withsub", c_sub, (1000, 0, Z))
        await db.commit()

        yield {
            "lens": str(o_lens.id), "aom": str(o_aom.id), "dev": str(o_dev.id),
            "fiber": str(o_fib.id), "swap": str(o_swap.id), "plain": str(o_plain.id),
            "withsub": str(o_sub.id),
        }

    async with AsyncSessionLocal() as db:
        await db.execute(delete(ObjectBinding).where(ObjectBinding.id.in_(ids["ob"])))
        await db.execute(delete(PhysicsElement).where(PhysicsElement.id.in_(ids["pe"])))
        await db.execute(delete(SceneObject).where(SceneObject.id.in_(ids["objects"])))
        await db.execute(delete(ComponentBinding).where(ComponentBinding.id.in_(ids["bindings"])))
        await db.execute(delete(Component).where(Component.id.in_(ids["components"])))
        await db.execute(delete(Asset3D).where(Asset3D.id.in_(ids["assets"])))
        await db.commit()


def _xyz(v) -> tuple[float, float, float]:
    return (v.x, v.y, v.z)


async def test_the_route_is_the_loader_projected_to_lab(scene_rows) -> None:
    mine = set(scene_rows.values())
    async with AsyncSessionLocal() as db:
        got = [a for a in await anchors_traced(db) if a.object_id in mine]
        scene = await load_anchor_scene_from_db(db)
    expected = []
    for slot in scene.slots:
        if slot.scene_object_id not in mine:
            continue
        t = slot.effective_transform
        for a in slot.asset.anchors:
            expected.append((
                slot.scene_object_id, slot.binding_id, a.id, a.name or a.id,
                _xyz(point_body_to_lab_t(a.position_body, t)),
                _xyz(dir_body_to_lab_t(a.axis_x_body, t)),
                _xyz(dir_body_to_lab_t(a.axis_y_body, t)),
                a.aperture_mm, a.synthesized,
            ))
    assert [(
        a.object_id, a.binding_id, a.anchor_id, a.anchor_name,
        _xyz(a.pos_lab), _xyz(a.axis_x_lab), _xyz(a.axis_y_lab), a.aperture_mm, a.synthesized,
    ) for a in got] == expected
    assert len(expected) > 10


def _by(rows, oid: str, anchor_id: str, binding_id: str | None = None):
    hits = [a for a in rows if a.object_id == oid and a.anchor_id == anchor_id
            and (binding_id is None or a.binding_id == binding_id)]
    assert len(hits) == 1, (oid, anchor_id, binding_id, hits)
    return hits[0]


def _close(v, expected) -> None:
    assert _xyz(v) == pytest.approx(expected, abs=1e-9)


async def test_each_loader_rewrite(scene_rows) -> None:
    async with AsyncSessionLocal() as db:
        rows = await anchors_traced(db)
    s = scene_rows

    # Generic: the stored name is the port identity; nothing is synthesized.
    lens_in = _by(rows, s["lens"], "intercept_in")
    assert (lens_in.anchor_name, lens_in.binding_id, lens_in.synthesized) == ("IN", "lens", False)
    assert _by(rows, s["lens"], "intercept_out").anchor_name == "intercept_out"

    # AOM: interaction_center derived at the midpoint of its faces.
    ic = _by(rows, s["aom"], "interaction_center")
    assert ic.synthesized is True
    _close(ic.pos_lab, (200 + 2, 0, Z + 1))
    _close(ic.axis_x_lab, (0, -1, 0))  # intercept_in's frame

    # Pigtail: intercept_in sits on the connector's mating face (binding at
    # x = -20, face at x = -12 on the connector), not at its stored x = -10,
    # with the connector's aperture — and it is still the device's own port.
    port = _by(rows, s["dev"], "intercept_in", "modulator")
    _close(port.pos_lab, (400 - 32, 0, Z))
    _close(port.axis_x_lab, (-1, 0, 0))
    assert port.aperture_mm == pytest.approx(0.0025)
    assert (port.anchor_name, port.synthesized) == ("OPT IN", False)
    _close(_by(rows, s["dev"], "intercept_out", "modulator").pos_lab, (400 + 10, 0, Z))

    # Connector fibre: the coupling ports are a slot of their own, the face
    # pushed |fiber_out - fiber_root| = 12 mm out along -tensionHandle.
    a_end = _by(rows, s["fiber"], "intercept_in", "fiber_body")
    b_end = _by(rows, s["fiber"], "intercept_out", "fiber_body")
    assert a_end.synthesized and b_end.synthesized
    _close(a_end.pos_lab, (600 - 12, 0, Z))
    _close(a_end.axis_x_lab, (-1, 0, 0))
    _close(b_end.pos_lab, (600 + 112, 0, Z))
    _close(b_end.axis_x_lab, (1, 0, 0))
    assert a_end.aperture_mm == pytest.approx(0.0025)

    # Per-instance asset swap: the override's anchor, for that instance only.
    swap = _by(rows, s["swap"], "intercept_face")
    assert swap.anchor_name == "SWAPPED"
    _close(swap.pos_lab, (800, 0, Z + 3))
    plain = _by(rows, s["plain"], "intercept_face")
    assert plain.anchor_name == "intercept_face"
    _close(plain.pos_lab, (900, 0, Z))

    # A sub-Component binding is not traced: only the lens's own anchors.
    assert {a.anchor_id for a in rows if a.object_id == s["withsub"]} == {"intercept_in", "intercept_out"}


def test_route_shape() -> None:
    """The HTTP surface: POST, no body, camelCase fields."""
    anchor = V3Anchor(id="intercept_in", position_body=Vec3(1, 2, 3), axis_x_body=Vec3(1, 0, 0),
                      axis_y_body=Vec3(0, 1, 0), axis_z_body=Vec3(0, 0, 1), aperture_mm=4.0,
                      name="IN")
    scene = V3AnchorScene(slots=[V3AnchorBindingSlot(
        scene_object_id="obj", binding_id="body",
        asset=V3AssetAnchorSnapshot(catalog_id="c", kind="lens_biconvex", anchors=[anchor]),
        effective_transform=pose_to_transform(V3Pose(x_mm=10.0)),
    )])

    async def _fake_loader(_session):
        return scene

    async def _no_db():
        yield object()

    original = v3_anchors.load_anchor_scene_from_db
    v3_anchors.load_anchor_scene_from_db = _fake_loader
    app.dependency_overrides[get_session] = _no_db
    try:
        res = TestClient(app).post("/api/v3/anchors/traced")
    finally:
        v3_anchors.load_anchor_scene_from_db = original
        app.dependency_overrides.pop(get_session, None)
    assert res.status_code == 200, res.text
    assert res.json() == [{
        "objectId": "obj", "anchorId": "intercept_in", "anchorName": "IN", "bindingId": "body",
        "posLab": {"x": 11.0, "y": 2.0, "z": 3.0},
        "axisXLab": {"x": 1.0, "y": 0.0, "z": 0.0},
        "axisYLab": {"x": 0.0, "y": 1.0, "z": 0.0},
        "apertureMm": 4.0, "synthesized": False,
    }]
