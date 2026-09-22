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


@pytest.fixture
def client(monkeypatch):
    """TestClient whose DB session is a dummy and whose scene is ``_scene``.

    ``load_rf_inputs`` is patched in BOTH modules: the router's import (what
    the endpoint calls) and ``rf_resolve``'s own (what the solver path's
    ``hydrate_aom_rf_drive`` calls), so the equality test below compares the
    two real call paths over one scene.
    """
    state = {"inputs": _scene()}

    async def _fake_load(_session):
        return state["inputs"]

    async def _fake_get_session():
        yield object()

    monkeypatch.setattr(v3_rf, "load_rf_inputs", _fake_load)
    monkeypatch.setattr(rf_resolve, "load_rf_inputs", _fake_load)
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
        "ppgGateHighObjectIds", "aomDrives", "sectionStartsNs",
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
    # Wired, gated off: 0 W and no frequency key.
    assert drives["aomB"] == {"rfDrivePowerW": 0.0}
    # Unwired and manual AOMs keep their own drive: absent.
    assert "aomC" not in drives
    assert "aomM" not in drives


@pytest.mark.parametrize("t", [None, -10.0, 0.0, 500.0, 1000.0, 1500.0, 1999.999, 2000.0, 1e9])
@pytest.mark.parametrize("rest_state", ["LOW", "HIGH"])
def test_aom_drives_equal_the_solver_path(client, t, rest_state) -> None:
    """The load-bearing one: the endpoint's ``aomDrives`` IS what the solver's
    scrub path (``hydrate_aom_rf_drive``, called by
    ``load_anchor_scene_from_db``) merges onto the AOM slots at that time."""
    client.state["inputs"] = _scene(rest_state=rest_state)  # type: ignore[attr-defined]
    out = _post(client, {"scrubTimeNs": t})
    solver = asyncio.run(rf_resolve.hydrate_aom_rf_drive(object(), t))
    assert out["aomDrives"] == solver
    # ... and the pure pair agrees with the pure solver resolver too.
    inputs = client.state["inputs"]  # type: ignore[attr-defined]
    assert rf_readout_at(inputs, t).aom_drives == resolve_aom_rf_drive(inputs, t)
