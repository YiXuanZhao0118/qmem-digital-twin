"""POST /api/v3/align/* — the parts around the pure ports.

``test_align_parity.py`` pins the solvers to the TypeScript. This file pins
what the endpoints add on top: which anchor / point / order / frequency they
pick from the scene (the React call sites they stand in for), their error
statuses, that they write nothing, and — the reason any of it exists — that
the poses they propose are physically right when re-read through the
backend's own transform chain.

The routes run against an in-memory scene (``load_align_scene`` and
``load_rf_inputs`` are stubbed), so no database is touched.
"""

from __future__ import annotations

import math
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.db import get_session
from app.main import app
from app.optical.align.anchor_poses import AlignScene
from app.optical.align.mirror_coupling import Ray, intersect_mirror, reflect
from app.optical.align.service import mirror_facts_from_object
from app.optical.align.ts_compat import V
from app.optical.aom_physics import acoustic_incidence_rad
from app.optical.align.frames import rotate_lab_dir, cad_to_lab
from app.optical.kinds.aom.physics import bragg_angle_rad
from app.optical.pose import V3Pose
from app.optical.rf_resolve import AomPort, RfInputs, RfNode
from app.routers import v3_align


# ─── row builders ──────────────────────────────────────────────────────────

def _anchor(aid: str, pos, axis=None, **extra) -> dict:
    d = {"id": aid, "positionMmBodyLocal": {"x": pos[0], "y": pos[1], "z": pos[2]}}
    if axis is not None:
        d["axisXBodyLocal"] = {"x": axis[0], "y": axis[1], "z": axis[2]}
    d.update(extra)
    return d


def _asset(aid: str, kind: str, anchors: list[dict], params: dict | None = None):
    return SimpleNamespace(id=aid, kind_id=kind, anchors=anchors, default_params=params or {})


def _comp(cid: str, kind: str | None, props: dict | None = None, asset_id: str | None = None):
    return SimpleNamespace(id=cid, kind_id=kind, asset_3d_id=asset_id, properties=props or {})


def _bind(bid: str, cid: str, *, kind="asset", asset=None, sub=None, parent=None, role="",
          pos=(0.0, 0.0, 0.0), rot=(0.0, 0.0, 0.0), props=None):
    return SimpleNamespace(
        id=bid, component_id=cid, parent_binding_id=parent, target_kind=kind,
        asset_3d_id=asset, sub_component_id=sub, role=role,
        local_x_mm=pos[0], local_y_mm=pos[1], local_z_mm=pos[2],
        local_rx_deg=rot[0], local_ry_deg=rot[1], local_rz_deg=rot[2],
        properties=props or {}, sort_order=0,
    )


def _obj(oid: str, cid: str, pose=(0, 0, 0, 0, 0, 0), *, props=None, dyn=None, locked=False):
    return SimpleNamespace(
        id=oid, name=oid, component_id=cid,
        x_mm=pose[0], y_mm=pose[1], z_mm=pose[2], rx_deg=pose[3], ry_deg=pose[4], rz_deg=pose[5],
        properties=props or {}, dynamic_sources=dyn, locked=locked,
    )


def _scene(objects, components, bindings, assets) -> AlignScene:
    by_comp: dict[str, list] = {}
    for b in bindings:
        by_comp.setdefault(b.component_id, []).append(b)
    return AlignScene(
        objects={o.id: o for o in objects},
        components={c.id: c for c in components},
        bindings_by_component=by_comp,
        object_bindings={},
        assets={a.id: a for a in assets},
    )


def _bench() -> AlignScene:
    """The U-turn of ``mirrorCoupling.test.ts``: seed down -y from the origin,
    port at x = 40 taking light along +y; mirrors roughed in by a few mm. A
    lens sits a little off the port axis between B and the port; a second,
    locked one too; an isolator, an optic with an alignSpec, a bare lens and
    an AOM are there for the other endpoints."""
    assets = [
        _asset("a-mirror", "mirror", [_anchor("intercept_face", (0, 0, 0), (0, 0, 1), apertureMm=12.7)]),
        _asset("a-port", "tapered_amplifier", [_anchor("intercept_in", (0, 0, 0), (0, -1, 0))]),
        _asset("a-lens", "lens_biconvex", [
            _anchor("intercept_in", (0, 0, -2), (0, 0, -1)),
            _anchor("intercept_out", (0, 0, 2), (0, 0, 1)),
        ]),
        _asset("a-glan", "beam_splitter", [_anchor("intercept_in", (0, 0, -5), (0, 0, -1))]),
        _asset("a-aom", "aom", [
            _anchor("intercept_in", (0, -11.2, 0), (0, -1, 0)),
            _anchor("intercept_out", (0, 11.2, 0), (0, 1, 0)),
            _anchor("rf_in", (45.5, 0, -1.2265), (1, 0, 0)),
        ], {"rfPropagationDirectionBodyLocal": [-1, 0, 0], "centerFreqMhz": 80.0,
            "acousticVelocityMps": 4200.0}),
    ]
    components = [
        _comp("c-mirror", "mirror"),
        _comp("c-port", "tapered_amplifier"),
        _comp("c-lens", "lens_biconvex"),
        _comp("c-spec", "waveplate", {"alignSpec": {"pointMm": [1, 2, 3], "directionMm": [0, 0, 5]}}),
        _comp("c-iso", None),
        _comp("c-glan", "beam_splitter"),
        _comp("c-aom", "aom"),
        _comp("c-bare", "mechanical"),
    ]
    bindings = [
        _bind("b-mirror", "c-mirror", asset="a-mirror", rot=(-90, 0, 0)),
        _bind("b-port", "c-port", asset="a-port"),
        _bind("b-lens", "c-lens", asset="a-lens"),
        _bind("b-spec", "c-spec", asset="a-lens"),
        _bind("b-iso-body", "c-iso", kind="empty", role="body"),
        _bind("b-iso-front", "c-iso", kind="subcomponent", sub="c-glan", parent="b-iso-body",
              pos=(0, 0, -13), props={"role_label": "front_pbs"}),
        _bind("b-iso-back", "c-iso", kind="subcomponent", sub="c-glan", parent="b-iso-body",
              pos=(0, 0, 13), props={"role_label": "back_pbs"}),
        _bind("b-glan", "c-glan", asset="a-glan"),
        _bind("b-aom", "c-aom", asset="a-aom"),
    ]
    objects = [
        _obj("A", "c-mirror", (1.5, -101, 0.9, -45, -90, 0)),
        _obj("B", "c-mirror", (40.4, -99.2, 0, 45, -90, 0)),
        _obj("PORT", "c-port", (40, 0, 0, 0, 0, 0)),
        _obj("LENS", "c-lens", (40.7, -50, 0.3, 90, 0, 0)),
        _obj("LOCKED_LENS", "c-lens", (39.1, -30, -0.2, 90, 0, 0), locked=True),
        _obj("SPEC", "c-spec", (5, 6, 7, 10, 20, 30)),
        _obj("ISO", "c-iso", (10, 20, 5, 0, 0, 0), props={"alignReverse": True}),
        _obj("BARE", "c-bare"),
        _obj("AOM", "c-aom", (13, 7, 62, 0, 20, 0), dyn={"aomFreqMhz": 95.0},
             props={"aomBraggFineTuneMrad": 0.0}),
    ]
    return _scene(objects, components, bindings, assets)


@pytest.fixture
def client(monkeypatch):
    state = {"scene": _bench(), "rf": RfInputs(nodes=(), programs_by_id={})}

    async def _fake_scene(_session):
        return state["scene"]

    async def _fake_rf(_session):
        return state["rf"]

    async def _fake_get_session():
        yield object()

    monkeypatch.setattr(v3_align, "load_align_scene", _fake_scene)
    monkeypatch.setattr(v3_align, "load_rf_inputs", _fake_rf)
    app.dependency_overrides[get_session] = _fake_get_session
    try:
        c = TestClient(app)
        c.state = state  # type: ignore[attr-defined]
        yield c
    finally:
        app.dependency_overrides.pop(get_session, None)


def _xyz(x, y, z) -> dict:
    return {"x": x, "y": y, "z": z}


def _moved(scene: AlignScene, oid: str, pose: dict) -> SimpleNamespace:
    o = scene.objects[oid]
    return _obj(oid, o.component_id, (pose["xMm"], pose["yMm"], pose["zMm"],
                                      pose["rxDeg"], pose["ryDeg"], pose["rzDeg"]))


# ─── mirror coupling ───────────────────────────────────────────────────────

MIRROR_BODY = {
    "mirrorAId": "A",
    "mirrorBId": "B",
    "inRay": {"origin": _xyz(0, 0, 0), "dir": _xyz(0, -1, 0)},
    "target": {"objectId": "PORT", "anchorId": "intercept_in"},
    "passThroughObjectIds": ["LENS", "LOCKED_LENS", "NOPE"],
}


def test_mirror_coupling_lands_the_seed_on_the_port_axis(client) -> None:
    """Re-read both mirrors at the proposed poses through the backend chain:
    45 deg on each, spot on each centre, out along the port's own axis."""
    res = client.post("/api/v3/align/mirror-coupling", json=MIRROR_BODY)
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["error"] is None
    assert out["touch"]["ok"] is True
    assert out["targetRay"] == {"origin": _xyz(40, 0, 0), "dir": _xyz(0, 1, 0)}
    assert out["plan"]["geometry"]["freeDof"] is True  # an exact U-turn
    assert out["plan"]["beforeTargetMissMm"] > 0.05

    scene = client.state["scene"]  # type: ignore[attr-defined]
    a = mirror_facts_from_object(scene, _moved(scene, "A", out["plan"]["moveA"]["pose"]))
    b = mirror_facts_from_object(scene, _moved(scene, "B", out["plan"]["moveB"]["pose"]))
    seed = Ray(origin=V(0, 0, 0), dir=V(0, -1, 0))
    hit_a = intersect_mirror(seed, a)
    assert hit_a.decentre_mm == pytest.approx(0, abs=1e-9)
    assert hit_a.aoi_deg == pytest.approx(45, abs=1e-9)
    mid = Ray(origin=hit_a.point_lab, dir=reflect(seed.dir, a.normal_lab))
    hit_b = intersect_mirror(mid, b)
    assert hit_b.decentre_mm == pytest.approx(0, abs=1e-9)
    assert hit_b.aoi_deg == pytest.approx(45, abs=1e-9)
    final = reflect(mid.dir, b.normal_lab)
    assert (final.x, final.y, final.z) == pytest.approx((0, 1, 0), abs=1e-12)
    # On the axis, not merely parallel to it.
    assert (hit_b.point_lab.x, hit_b.point_lab.z) == pytest.approx((40, 0), abs=1e-9)


def test_mirror_coupling_recentres_pass_through_optics(client) -> None:
    out = client.post("/api/v3/align/mirror-coupling", json=MIRROR_BODY).json()
    assert [m["objectId"] for m in out["passThroughMoves"]] == ["LENS"]
    assert out["passThroughSkipped"] == [
        {"objectId": "LOCKED_LENS", "reason": "locked"},
        {"objectId": "NOPE", "reason": "not found"},
    ]
    pose = out["passThroughMoves"][0]["pose"]
    # Translate only: rotation untouched, entry anchor now on x=40, z=0.
    assert (pose["rxDeg"], pose["ryDeg"], pose["rzDeg"]) == (90, 0, 0)
    entry = cad_to_lab(V(0, 0, -2), V3Pose(pose["xMm"], pose["yMm"], pose["zMm"], 90, 0, 0))
    assert (entry.x, entry.z) == pytest.approx((40, 0), abs=1e-9)


def test_mirror_coupling_reports_a_missing_pair_as_data(client) -> None:
    # The seed already runs along the port axis: nothing to solve, but it is
    # an answer (200 + error), not a bad request.
    body = {**MIRROR_BODY, "inRay": {"origin": _xyz(40, -200, 0), "dir": _xyz(0, 1, 0)}}
    out = client.post("/api/v3/align/mirror-coupling", json=body).json()
    assert out["plan"] is None
    assert "same line" in out["error"]
    assert out["passThroughMoves"] == []


@pytest.mark.parametrize("patch, status, needle", [
    ({"mirrorBId": "A"}, 422, "two different objects"),
    ({"mirrorBId": "LENS"}, 422, "is not a mirror"),
    ({"mirrorAId": "GHOST"}, 404, "not found"),
    ({"target": {"objectId": "A", "anchorId": "intercept_in"}}, 422, "third object"),
    ({"target": {"objectId": "PORT", "anchorId": "intercept_out"}}, 422, "not a coupling destination"),
    ({"target": {"objectId": "BARE", "anchorId": "intercept_in"}}, 422, "no `intercept_in`"),
    ({"inRay": {"origin": _xyz(0, 0, 0), "dir": _xyz(0, 0, 0)}}, 422, "non-zero"),
])
def test_mirror_coupling_rejects_bad_requests(client, patch, status, needle) -> None:
    res = client.post("/api/v3/align/mirror-coupling", json={**MIRROR_BODY, **patch})
    assert res.status_code == status, res.text
    assert needle in str(res.json()["detail"])


# ─── isolator / point + direction ──────────────────────────────────────────

BEAM = {"dir": _xyz(1, 0.2, 0), "ref": _xyz(50, 10, 3)}


def _on_beam(p: V) -> float:
    n = math.hypot(1, 0.2, 0)
    d = V(1 / n, 0.2 / n, 0)
    w = V(p.x - 50, p.y - 10, p.z - 3)
    t = w.x * d.x + w.y * d.y + w.z * d.z
    return math.hypot(w.x - d.x * t, w.y - d.y * t, w.z - d.z * t)


def _pose_of(out: dict) -> V3Pose:
    p = out["pose"]
    return V3Pose(p["xMm"], p["yMm"], p["zMm"], p["rxDeg"], p["ryDeg"], p["rzDeg"])


def test_isolator_uses_the_polariser_centres_and_the_stored_reverse(client) -> None:
    out = client.post("/api/v3/align/isolator", json={"objectId": "ISO", "beam": BEAM}).json()
    assert out["alignSource"] == "polariserCentres"
    assert out["pointCadMm"] == _xyz(0, 0, -13)
    assert out["dirCadMm"] == _xyz(0, 0, 26)
    assert out["reverse"] is True  # properties.alignReverse
    pose = _pose_of(out)
    front, back = cad_to_lab(V(0, 0, -13), pose), cad_to_lab(V(0, 0, 13), pose)
    assert _on_beam(front) == pytest.approx(0, abs=1e-9)
    assert _on_beam(back) == pytest.approx(0, abs=1e-9)
    # Reverse: the bore runs against the beam.
    bore = V(back.x - front.x, back.y - front.y, back.z - front.z)
    assert bore.x < 0

    fwd = client.post("/api/v3/align/isolator",
                      json={"objectId": "ISO", "beam": BEAM, "reverse": False}).json()
    assert fwd["reverse"] is False


def test_align_spec_wins_then_the_primary_anchor(client) -> None:
    spec = client.post("/api/v3/align/isolator", json={"objectId": "SPEC", "beam": BEAM}).json()
    assert spec["alignSource"] == "alignSpec"
    assert spec["pointCadMm"] == _xyz(1, 2, 3)
    assert _on_beam(cad_to_lab(V(1, 2, 3), _pose_of(spec))) == pytest.approx(0, abs=1e-9)

    lens = client.post("/api/v3/align/isolator",
                       json={"objectId": "LENS", "beam": BEAM, "rollDeg": 30}).json()
    assert lens["alignSource"] == "primaryAnchor"
    assert lens["pointCadMm"] == _xyz(0, 0, -2)
    assert lens["dirCadMm"] == _xyz(0, 0, 1)  # -axisX of intercept_in
    assert lens["rollDeg"] == 30


def test_isolator_without_any_align_reference_is_422(client) -> None:
    res = client.post("/api/v3/align/isolator", json={"objectId": "BARE", "beam": BEAM})
    assert res.status_code == 422
    assert "No align point/direction" in res.json()["detail"]


# ─── AOM Bragg ─────────────────────────────────────────────────────────────

AOM_BEAM = {"dir": _xyz(1, 0, 0), "ref": _xyz(0, 0, 50), "wavelengthNm": 780}


def _incidence(out: dict) -> float:
    pose = _pose_of(out)
    d1 = rotate_lab_dir(V(0, 1, 0), pose)
    d2 = rotate_lab_dir(V(-1, 0, 0), pose)
    return acoustic_incidence_rad((1.0, 0.0, 0.0), tuple(d2), tuple(d1))


def test_aom_bragg_matches_the_selected_order(client) -> None:
    for order in (1, -1):
        out = client.post("/api/v3/align/aom-bragg",
                          json={"objectId": "AOM", "beam": AOM_BEAM, "order": order}).json()
        assert out["error"] is None
        theta_b = bragg_angle_rad(780, out["freqMhz"], 4200)
        assert out["thetaBRad"] == pytest.approx(theta_b, abs=1e-15)
        # The incidence the tracer's AOM op measures is the matched one.
        assert _incidence(out) == pytest.approx(-order * theta_b, abs=1e-9)
        assert out["readoutAfter"]["matchedOrder"] == order
        sel = next(o for o in out["readoutAfter"]["orders"] if o["order"] == order)
        assert sel["phaseMatch"] == pytest.approx(1, abs=1e-9)


def test_aom_frequency_resolution_order(client) -> None:
    body = {"objectId": "AOM", "beam": AOM_BEAM}
    # No RF link: the per-instance aomFreqMhz (95) wins over the asset's 80.
    out = client.post("/api/v3/align/aom-bragg", json=body).json()
    assert (out["freqMhz"], out["freqSource"]) == (95.0, "dynamicSources")
    # The RF link, when a carrier arrives, wins over both...
    src = RfNode("SRC", "rf_source", {}, ({"id": "rf_out", "name": "CH0"},), asset_params={
        "channels": [{"anchorName": "CH0", "frequencyMhz": 110.0, "amplitudeScale": 1.0}],
    })
    cable = RfNode("CAB", "rf_cable", {}, (), {
        "A": {"targetObjectId": "SRC", "targetAnchorName": "CH0"},
        "B": {"targetObjectId": "AOM", "targetAnchorName": "rf_in"},
    })
    aom = RfNode("AOM", "aom", {}, ({"id": "rf_in"},))
    client.state["rf"] = RfInputs(  # type: ignore[attr-defined]
        nodes=(src, cable, aom), programs_by_id={}, aoms=(AomPort("AOM", "rf_in", False),),
    )
    out = client.post("/api/v3/align/aom-bragg", json=body).json()
    assert (out["freqMhz"], out["freqSource"]) == (110.0, "rfLink")
    # ... unless the AOM is in manual mode ...
    client.state["rf"] = RfInputs(  # type: ignore[attr-defined]
        nodes=(src, cable, aom), programs_by_id={}, aoms=(AomPort("AOM", "rf_in", True),),
    )
    assert client.post("/api/v3/align/aom-bragg", json=body).json()["freqSource"] == "dynamicSources"
    # ... and an explicit request value wins over everything.
    out = client.post("/api/v3/align/aom-bragg", json={**body, "freqMhz": 70.0}).json()
    assert (out["freqMhz"], out["freqSource"]) == (70.0, "request")


def test_aom_order_zero_and_the_nudge(client) -> None:
    # Put the cell on Bragg first (the nudge walks the stage from there).
    aligned = client.post("/api/v3/align/aom-bragg",
                          json={"objectId": "AOM", "beam": AOM_BEAM, "order": 1}).json()
    p = aligned["pose"]
    scene = client.state["scene"]  # type: ignore[attr-defined]
    aom = scene.objects["AOM"]
    aom.x_mm, aom.y_mm, aom.z_mm = p["xMm"], p["yMm"], p["zMm"]
    aom.rx_deg, aom.ry_deg, aom.rz_deg = p["rxDeg"], p["ryDeg"], p["rzDeg"]

    out = client.post("/api/v3/align/aom-bragg",
                      json={"objectId": "AOM", "beam": AOM_BEAM, "order": 0, "nudgeMrad": 1.5}).json()
    assert out["pose"] is None
    assert "Order 0" in out["error"]
    assert out["readout"]["thetaInRad"] == pytest.approx(_incidence(aligned), abs=1e-12)
    # The stage turns about D3: the incidence moves by exactly the nudge ...
    assert _incidence({"pose": out["nudgePose"]}) == pytest.approx(_incidence(aligned) - 1.5e-3, abs=1e-9)
    # ... and the pivot (the interaction centre) stays put.
    p0 = cad_to_lab(V(0, 0, 0), _pose_of(aligned))
    p1 = cad_to_lab(V(0, 0, 0), _pose_of({"pose": out["nudgePose"]}))
    assert (p1.x, p1.y, p1.z) == pytest.approx((p0.x, p0.y, p0.z), abs=1e-9)


def test_aom_rejects_a_non_aom(client) -> None:
    res = client.post("/api/v3/align/aom-bragg", json={"objectId": "LENS", "beam": AOM_BEAM})
    assert res.status_code == 422
    assert "is not an AOM" in res.json()["detail"]


def test_align_endpoints_write_nothing(client) -> None:
    """Compute-only: the scene the routes read is untouched afterwards."""
    scene = client.state["scene"]  # type: ignore[attr-defined]
    before = {oid: vars(o).copy() for oid, o in scene.objects.items()}
    client.post("/api/v3/align/mirror-coupling", json=MIRROR_BODY)
    client.post("/api/v3/align/isolator", json={"objectId": "ISO", "beam": BEAM})
    client.post("/api/v3/align/aom-bragg", json={"objectId": "AOM", "beam": AOM_BEAM, "nudgeMrad": 1})
    assert {oid: vars(o) for oid, o in scene.objects.items()} == before
