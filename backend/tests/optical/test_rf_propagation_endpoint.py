"""POST /api/v3/rf/propagation — the RF readout a second client consumes.

Three things are pinned:

  * the response shape (camelCase keys, port keys, sorted lists);
  * rest (``scrubTimeNs = null``) vs active scrub semantics — a PPG's
    ``restState`` holds the line outside its drawn intervals, the rest
    snapshot ignores intervals altogether;
  * ``aomDrives`` equals, key for key, what the solver's scrub path resolves
    for the same time (``rf_resolve.hydrate_aom_rf_drive``, the call
    ``load_anchor_scene_from_db`` makes), because the readout is worthless the
    moment it disagrees with the trace.

The route runs against a fake session: ``load_rf_inputs`` is stubbed with a
hand-built scene (the same switch/PPG layout ``test_rf_resolve.py`` uses), so
no database is touched.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.db import get_session
from app.main import app
from app.optical import rf_resolve
from app.optical.anchor_ops.aom import on_bragg_first_order_efficiency
from app.optical.anchor_tracer import (
    V3Anchor,
    V3AnchorBindingSlot,
    V3AnchorScene,
    V3AssetAnchorSnapshot,
)
from app.optical.beam_ray import Vec3
from app.optical.pose import V3Pose, pose_to_transform
from app.optical.rf_resolve import (
    AomPort,
    RfInputs,
    RfNode,
    port_key,
    resolve_aom_rf_drive,
    rf_readout_at,
    vpp_to_power_w,
)
from app.routers import v3_rf


def _anc(aid: str, name: str | None = None) -> dict:
    d: dict = {"id": aid}
    if name is not None:
        d["name"] = name
    return d


_SRC_ANCHORS = (_anc("rf_out", "CH0"), _anc("rf_out", "CH1"))
_AMP_ANCHORS = (_anc("rf_in"), _anc("rf_out"))
_AOM_ANCHORS = (_anc("intercept_in"), _anc("intercept_out"), _anc("rf_in"))
_SWITCH_ANCHORS = (_anc("rf_in"), _anc("rf_out", "RF1"),
                   _anc("rf_out", "RF2"), _anc("ttl_in", "TTL"))


def _cable(cid: str, oa: str, na: str, ob: str, nb: str) -> RfNode:
    return RfNode(cid, "rf_cable", {}, (), {
        "A": {"targetObjectId": oa, "targetAnchorName": na},
        "B": {"targetObjectId": ob, "targetAnchorName": nb},
    })


def _scene(rest_state: str = "LOW") -> RfInputs:
    """src CH0 -> amp -> switch; RF1 -> aomA, RF2 -> aomB; a PPG on TTL with
    one HIGH block [1000, 2000) ns. aomC is wired to nothing (keeps its rated
    drive); aomM is wired but in manual mode (skipped)."""
    src = RfNode("src", "rf_source", {}, _SRC_ANCHORS, asset_params={
        "channels": [{"anchorName": "CH0", "frequencyMhz": 80.0, "amplitudeScale": 0.5}],
    })
    amp = RfNode("amp", "rf_amplifier", {"gainDb": 20.0}, _AMP_ANCHORS)
    sw = RfNode("sw", "rf_switch", {"throwCount": 2, "insertionLossDb": 1.0}, _SWITCH_ANCHORS)
    ppg = RfNode("ppg", "programmable_pulse_generator",
                 {"restState": rest_state, "timingProgramId": "prog"}, (_anc("rf_out"),),
                 ppg_attachment={"targetObjectId": "sw", "targetAnchorId": "ttl_in",
                                 "targetAnchorName": "TTL"})
    nodes = [
        src, amp, sw, ppg,
        RfNode("aomA", "aom", {}, _AOM_ANCHORS),
        RfNode("aomB", "aom", {}, _AOM_ANCHORS),
        RfNode("aomC", "aom", {}, _AOM_ANCHORS),
        RfNode("aomM", "aom", {}, _AOM_ANCHORS),
        _cable("c0", "src", "CH0", "amp", "rf_in"),
        _cable("c1", "amp", "rf_out", "sw", "rf_in"),
        _cable("c2", "sw", "RF1", "aomA", "rf_in"),
        _cable("c3", "sw", "RF2", "aomB", "rf_in"),
        _cable("c4", "src", "CH1", "aomM", "rf_in"),
    ]
    return RfInputs(
        nodes=tuple(nodes),
        programs_by_id={"prog": [{"spinCoreStartNs": 1000.0, "spinCoreEndNs": 2000.0}]},
        aoms=(
            AomPort("aomA", "rf_in", False),
            AomPort("aomB", "rf_in", False),
            AomPort("aomC", "rf_in", False),
            AomPort("aomM", "rf_in", True),
        ),
    )


_X = (Vec3(1.0, 0.0, 0.0), Vec3(0.0, 1.0, 0.0), Vec3(0.0, 0.0, 1.0))
LASER_NM = 852.347
# The live MT80's asset params that the op reads (the rest default).
AOM_PARAMS = {"baseEfficiency": 0.85, "rfPowerMaxW": 2.0}


def _v3_anchor(aid: str, x: float = 0.0) -> V3Anchor:
    ax, ay, az = _X
    return V3Anchor(id=aid, position_body=Vec3(x, 0.0, 0.0), axis_x_body=ax,
                    axis_y_body=ay, axis_z_body=az, aperture_mm=2.0)


def _slot(oid: str, kind: str, anchors: list[V3Anchor], params: dict, dyn: dict | None) -> V3AnchorBindingSlot:
    return V3AnchorBindingSlot(
        scene_object_id=oid, binding_id="body",
        asset=V3AssetAnchorSnapshot(catalog_id=f"{kind}-{oid}", kind=kind,
                                    anchors=anchors, default_params=params),
        effective_transform=pose_to_transform(V3Pose()), dynamic_sources=dyn,
    )


def _anchor_scene(drives: dict[str, dict], laser_nm: float | None = LASER_NM) -> V3AnchorScene:
    """What ``load_anchor_scene_from_db`` would hand the tracer for ``_scene``:
    one laser, and an AOM slot per AOM object with the RF drive merged onto
    its dynamic sources (the loader's ``rf`` merge)."""
    slots = []
    if laser_nm is not None:
        slots.append(_slot("laser", "laser_source", [_v3_anchor("intercept_out")],
                           {"centerWavelengthNm": laser_nm}, None))
    for oid in ("aomA", "aomB", "aomC", "aomM"):
        slots.append(_slot(oid, "aom",
                           [_v3_anchor("intercept_in", 99.0), _v3_anchor("intercept_out", 101.0)],
                           AOM_PARAMS, drives.get(oid)))
    return V3AnchorScene(slots=slots)


@pytest.fixture
def client(monkeypatch):
    """TestClient whose DB session is a dummy and whose scene is ``_scene``.

    ``load_rf_inputs`` is patched in BOTH modules: the router's import (what
    the endpoint calls) and ``rf_resolve``'s own (what the solver path's
    ``hydrate_aom_rf_drive`` calls), so the equality test below compares the
    two real call paths over one scene. ``load_anchor_scene_from_db`` (what
    ``eta`` is computed over) is patched to build its AOM slots from that
    same ``hydrate_aom_rf_drive``, as the real loader does.
    """
    state = {"inputs": _scene(), "laser_nm": LASER_NM}

    async def _fake_load(_session):
        return state["inputs"]

    async def _fake_anchor_scene(session, scrub_time_ns=None):
        drives = await rf_resolve.hydrate_aom_rf_drive(session, scrub_time_ns)
        return _anchor_scene(drives, state["laser_nm"])

    async def _fake_get_session():
        yield object()

    monkeypatch.setattr(v3_rf, "load_rf_inputs", _fake_load)
    monkeypatch.setattr(rf_resolve, "load_rf_inputs", _fake_load)
    monkeypatch.setattr(v3_rf, "load_anchor_scene_from_db", _fake_anchor_scene)
    app.dependency_overrides[get_session] = _fake_get_session
    try:
        c = TestClient(app)
        c.state = state  # type: ignore[attr-defined]
        yield c
    finally:
        app.dependency_overrides.pop(get_session, None)


def _post(client: TestClient, body: dict | None):
    res = client.post("/api/v3/rf/propagation", json=body)
    assert res.status_code == 200, res.text
    return res.json()


def test_shape(client) -> None:
    out = _post(client, {"scrubTimeNs": 1500})
    assert set(out) == {
        "scrubTimeNs", "signalAtPort", "connectedPorts",
        "ppgGateHighObjectIds", "aomDrives", "aomEtaWavelengthNm",
        "sectionStartsNs",
    }
    assert out["scrubTimeNs"] == 1500
    sig = out["signalAtPort"][port_key("sw", "rf_in")]
    assert set(sig) == {
        "frequencyMhz", "vpp", "powerW", "sourceObjectId", "sourceAnchorName",
        "cumulativeGainDb", "passthroughObjectIds", "saturated",
    }
    # 0.5 Vpp * +20 dB = 5 Vpp at the switch input, through the amp only.
    assert sig["vpp"] == pytest.approx(5.0)
    assert sig["powerW"] == pytest.approx(vpp_to_power_w(5.0))
    assert sig["sourceObjectId"] == "src"
    assert sig["sourceAnchorName"] == "CH0"
    assert sig["cumulativeGainDb"] == pytest.approx(20.0)
    assert sig["passthroughObjectIds"] == ["amp"]
    assert sig["saturated"] is False
    assert out["connectedPorts"] == sorted(out["connectedPorts"])
    assert port_key("aomA", "rf_in") in out["connectedPorts"]
    assert port_key("aomC", "rf_in") not in out["connectedPorts"]
    assert out["sectionStartsNs"] == [0.0, 1000.0, 2000.0]


def test_empty_body_is_the_rest_snapshot(client) -> None:
    # The body is optional, like run-from-db's; no body = scrub stopped.
    res = client.post("/api/v3/rf/propagation")
    assert res.status_code == 200, res.text
    assert res.json() == _post(client, {"scrubTimeNs": None})


def test_active_scrub_follows_the_ppg_blocks(client) -> None:
    outside = _post(client, {"scrubTimeNs": 500})
    inside = _post(client, {"scrubTimeNs": 1500})
    # restState LOW: outside the block the gate is LOW -> RF1 -> aomA.
    assert outside["ppgGateHighObjectIds"] == []
    assert port_key("aomA", "rf_in") in outside["signalAtPort"]
    assert port_key("aomB", "rf_in") not in outside["signalAtPort"]
    # Inside the block: HIGH -> RF2 -> aomB.
    assert inside["ppgGateHighObjectIds"] == ["ppg"]
    assert port_key("aomB", "rf_in") in inside["signalAtPort"]
    assert port_key("aomA", "rf_in") not in inside["signalAtPort"]
    # The switch's 1 dB insertion loss is on the arriving signal.
    arriving = inside["signalAtPort"][port_key("aomB", "rf_in")]
    assert arriving["cumulativeGainDb"] == pytest.approx(19.0)
    assert arriving["passthroughObjectIds"] == ["amp", "sw"]


def test_rest_snapshot_ignores_the_blocks_and_uses_rest_state(client) -> None:
    client.state["inputs"] = _scene(rest_state="HIGH")  # type: ignore[attr-defined]
    rest = _post(client, {"scrubTimeNs": None})
    # Rest = the level outside the blocks: HIGH -> RF2 -> aomB, whatever the
    # program says.
    assert rest["ppgGateHighObjectIds"] == ["ppg"]
    assert port_key("aomB", "rf_in") in rest["signalAtPort"]
    # Active scrub INSIDE the block inverts it: a HIGH rest makes the block a
    # LOW pulse, so aomA carries.
    inside = _post(client, {"scrubTimeNs": 1500})
    assert inside["ppgGateHighObjectIds"] == []
    assert port_key("aomA", "rf_in") in inside["signalAtPort"]


def test_aom_drive_rules(client) -> None:
    out = _post(client, {"scrubTimeNs": 500})
    drives = out["aomDrives"]
    # Carrier arrives: freq + power (5 Vpp - 1 dB).
    assert drives["aomA"]["aomFreqMhz"] == pytest.approx(80.0)
    assert drives["aomA"]["rfDrivePowerW"] > 0.0
    assert set(drives["aomA"]) == {"aomFreqMhz", "rfDrivePowerW", "eta"}
    # Wired, gated off: 0 W, no frequency key — and no diffraction.
    assert drives["aomB"] == {"rfDrivePowerW": 0.0, "eta": 0.0}
    # Unwired and manual AOMs keep their own drive: absent.
    assert "aomC" not in drives
    assert "aomM" not in drives


def _without_eta(drives: dict) -> dict:
    return {k: {kk: vv for kk, vv in d.items() if kk != "eta"} for k, d in drives.items()}


@pytest.mark.parametrize("t", [None, 500.0, 1500.0])
def test_eta_is_the_ops_efficiency_for_that_drive(client, t) -> None:
    """``eta`` = the AOM op's own function over the slot the loader built
    (asset params + the merged drive), at the scene's single laser
    wavelength. Here 4.456 Vpp into the MT80 at 852.347 nm: P = 0.0496 W
    against P_peak = 1.32 W, so eta is small but not zero."""
    out = _post(client, {"scrubTimeNs": t})
    for oid, drive in out["aomDrives"].items():
        dyn = _without_eta(out["aomDrives"])[oid]
        expected = on_bragg_first_order_efficiency({**AOM_PARAMS, **dyn}, dyn, LASER_NM)
        assert drive["eta"] == expected
    driven = next(d for d in out["aomDrives"].values() if d["rfDrivePowerW"] > 0)
    assert 0.0 < driven["eta"] < 0.85
    # The wavelength matters (P_peak ~ lambda^2): at 780 nm it would differ.
    dyn = {k: v for k, v in driven.items() if k != "eta"}
    assert driven["eta"] != on_bragg_first_order_efficiency({**AOM_PARAMS, **dyn}, dyn, 780.0)


def test_eta_falls_back_to_780_nm_without_one_emitter_wavelength(client) -> None:
    client.state["laser_nm"] = None  # type: ignore[attr-defined]
    out = _post(client, {"scrubTimeNs": 500})
    dyn = _without_eta(out["aomDrives"])["aomA"]
    assert out["aomDrives"]["aomA"]["eta"] == on_bragg_first_order_efficiency(
        {**AOM_PARAMS, **dyn}, dyn, 780.0,
    )


@pytest.mark.parametrize("t", [None, 500.0, 1500.0])
def test_reports_the_wavelength_eta_was_evaluated_at(client, t) -> None:
    """``aomEtaWavelengthNm`` qualifies every ``eta`` beside it.

    A client that also shows "the drive that would peak this AOM" has to use
    the SAME lambda as the eta it sits next to, because P_peak scales as
    lambda^2 -- 780 vs 852 nm is 1.11 W vs 1.32 W on the MT80, ~2 Vpp of
    advice. It cannot derive that lambda itself: deciding which wavelength a
    scene emits means knowing that a SEEDED tapered amplifier emits nothing of
    its own, which is a tracer rule, not a scene-graph one. The web RF Link
    panel's own emitter scan is exactly what got this wrong on the live bench.
    """
    out = _post(client, {"scrubTimeNs": t})
    assert out["aomEtaWavelengthNm"] == pytest.approx(LASER_NM)
    # It really is the lambda the etas were computed at, not a constant.
    for oid, drive in out["aomDrives"].items():
        dyn = _without_eta(out["aomDrives"])[oid]
        assert drive["eta"] == on_bragg_first_order_efficiency(
            {**AOM_PARAMS, **dyn}, dyn, out["aomEtaWavelengthNm"],
        )


def test_reported_wavelength_follows_the_780_nm_fallback(client) -> None:
    client.state["laser_nm"] = None  # type: ignore[attr-defined]
    out = _post(client, {"scrubTimeNs": 500})
    assert out["aomEtaWavelengthNm"] == pytest.approx(780.0)


@pytest.mark.parametrize("t", [None, -10.0, 0.0, 500.0, 1000.0, 1500.0, 1999.999, 2000.0, 1e9])
@pytest.mark.parametrize("rest_state", ["LOW", "HIGH"])
def test_aom_drives_equal_the_solver_path(client, t, rest_state) -> None:
    """The load-bearing one: the endpoint's ``aomDrives`` IS what the solver's
    scrub path (``hydrate_aom_rf_drive``, called by
    ``load_anchor_scene_from_db``) merges onto the AOM slots at that time."""
    client.state["inputs"] = _scene(rest_state=rest_state)  # type: ignore[attr-defined]
    out = _post(client, {"scrubTimeNs": t})
    solver = asyncio.run(rf_resolve.hydrate_aom_rf_drive(object(), t))
    # Every drive key verbatim; ``eta`` is the one key the readout adds.
    assert _without_eta(out["aomDrives"]) == solver
    assert all("eta" in d for d in out["aomDrives"].values())
    # ... and the pure pair agrees with the pure solver resolver too.
    inputs = client.state["inputs"]  # type: ignore[attr-defined]
    assert rf_readout_at(inputs, t).aom_drives == resolve_aom_rf_drive(inputs, t)
