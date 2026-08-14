"""Backend RF resolution tests — parity with frontend rfPropagation.test.ts.

Exercises the pure ``build_rf_propagation`` / ``resolve_aom_rf_drive`` layer
with hand-built :class:`RfInputs` (no DB), mirroring the project convention of
testing the pure loader functions directly (see test_db_scene_loader_binding_tree).
"""

from __future__ import annotations

import math

import pytest

from types import SimpleNamespace

from app.optical.rf_resolve import (
    AomPort,
    RfInputs,
    RfNode,
    _primary_asset_id,
    build_rf_propagation,
    port_key,
    resolve_aom_rf_drive,
    vpp_to_power_w,
)


def _anc(aid: str, name: str | None = None) -> dict:
    d: dict = {"id": aid}
    if name is not None:
        d["name"] = name
    return d


_SRC_ANCHORS = (_anc("rf_out", "CH0"), _anc("rf_out", "CH1"),
                _anc("rf_out", "CH2"), _anc("rf_out", "CH3"))
_AMP_ANCHORS = (_anc("rf_in"), _anc("rf_out"))
_AOM_ANCHORS = (_anc("intercept_in"), _anc("intercept_out"),
                _anc("rf_in"), _anc("acoustic_axis"))
_SWITCH_ANCHORS = (_anc("rf_in"), _anc("rf_out", "RF1"),
                   _anc("rf_out", "RF2"), _anc("ttl_in", "TTL"))


def _cable(cid: str, oa: str, na: str, ob: str, nb: str) -> RfNode:
    return RfNode(cid, "rf_cable", {}, (), {
        "A": {"targetObjectId": oa, "targetAnchorName": na},
        "B": {"targetObjectId": ob, "targetAnchorName": nb},
    })


def _src(channels: list[dict] | None = None) -> RfNode:
    params = {"channels": channels} if channels is not None else {}
    return RfNode("src", "rf_source", params, _SRC_ANCHORS)


def _inputs(nodes, *, aoms=(), programs=None, powered_off=()) -> RfInputs:
    return RfInputs(
        nodes=tuple(nodes),
        programs_by_id=programs or {},
        powered_off=frozenset(powered_off),
        aoms=tuple(aoms),
    )


def test_source_seeds_every_channel_anchor_with_defaults() -> None:
    # Only CH0 explicitly configured; CH1..CH3 still seed at 80 MHz / amp 1.0.
    inp = _inputs([_src([{"anchorName": "CH0", "frequencyMhz": 110.0, "amplitudeScale": 0.5}])])
    res = build_rf_propagation(inp, scrub_time_ns=0.0)
    ch0 = res.signal_at_port[port_key("src", "CH0")]
    assert ch0.frequency_mhz == pytest.approx(110.0)
    assert ch0.vpp == pytest.approx(0.5)  # amp 0.5 * full-scale 1.0
    for ch in ("CH1", "CH2", "CH3"):
        sig = res.signal_at_port[port_key("src", ch)]
        assert sig.frequency_mhz == pytest.approx(80.0)
        assert sig.vpp == pytest.approx(1.0)


def test_full_scale_vpp_from_asset_params() -> None:
    # fullScaleVpp lives on the asset (default_params) — the authoritative
    # store. amp 1.0 * fullScale 0.5 = 0.5 Vpp, overriding the 1.0 default.
    src = RfNode("src", "rf_source",
                 {"channels": [{"anchorName": "CH0", "frequencyMhz": 80.0, "amplitudeScale": 1.0}]},
                 _SRC_ANCHORS, asset_params={"fullScaleVpp": 0.5})
    res = build_rf_propagation(_inputs([src]), scrub_time_ns=0.0)
    assert res.signal_at_port[port_key("src", "CH0")].vpp == pytest.approx(0.5)


def test_full_scale_vpp_dynamic_sources_override_wins() -> None:
    # Per-instance dynamic_sources.fullScaleVpp (tunable) overrides the asset.
    src = RfNode("src", "rf_source", {}, _SRC_ANCHORS,
                 asset_params={"fullScaleVpp": 0.5},
                 dynamic_sources={"fullScaleVpp": 2.0})
    res = build_rf_propagation(_inputs([src]), scrub_time_ns=0.0)
    # default amp 1.0 * dynamic fullScale 2.0 = 2.0 Vpp.
    assert res.signal_at_port[port_key("src", "CH0")].vpp == pytest.approx(2.0)


def test_channels_from_asset_params() -> None:
    # channels live on the asset (default_params) — the authoritative store;
    # CH0 configured there, CH1..3 fall back to 80 MHz / amp 1.0.
    src = RfNode("src", "rf_source", {}, _SRC_ANCHORS,
                 asset_params={"channels": [
                     {"anchorName": "CH0", "frequencyMhz": 120.0, "amplitudeScale": 0.5}]})
    res = build_rf_propagation(_inputs([src]), scrub_time_ns=0.0)
    ch0 = res.signal_at_port[port_key("src", "CH0")]
    assert ch0.frequency_mhz == pytest.approx(120.0)
    assert ch0.vpp == pytest.approx(0.5)
    assert res.signal_at_port[port_key("src", "CH1")].frequency_mhz == pytest.approx(80.0)


def test_channels_dynamic_sources_override_asset() -> None:
    # Per-instance dynamic_sources.channels (tunable) overrides the asset.
    src = RfNode("src", "rf_source", {}, _SRC_ANCHORS,
                 asset_params={"channels": [
                     {"anchorName": "CH0", "frequencyMhz": 120.0, "amplitudeScale": 0.5}]},
                 dynamic_sources={"channels": [
                     {"anchorName": "CH0", "frequencyMhz": 200.0, "amplitudeScale": 1.0}]})
    res = build_rf_propagation(_inputs([src]), scrub_time_ns=0.0)
    ch0 = res.signal_at_port[port_key("src", "CH0")]
    assert ch0.frequency_mhz == pytest.approx(200.0)
    assert ch0.vpp == pytest.approx(1.0)


def test_direct_source_to_aom() -> None:
    src = _src([{"anchorName": "CH0", "frequencyMhz": 90.0, "amplitudeScale": 1.0}])
    aom = RfNode("aom", "aom", {}, _AOM_ANCHORS)
    cab = _cable("c", "src", "CH0", "aom", "rf_in")
    inp = _inputs([src, aom, cab], aoms=[AomPort("aom", "rf_in", False)])
    res = build_rf_propagation(inp, scrub_time_ns=0.0)
    sig = res.signal_at_port[port_key("aom", "rf_in")]
    assert sig.frequency_mhz == pytest.approx(90.0)
    drive = resolve_aom_rf_drive(inp, 0.0)
    assert drive["aom"]["aomFreqMhz"] == pytest.approx(90.0)
    assert drive["aom"]["rfDrivePowerW"] == pytest.approx(vpp_to_power_w(1.0))


def test_multihop_chain_applies_amplifier_gain() -> None:
    src = _src([{"anchorName": "CH0", "frequencyMhz": 80.0, "amplitudeScale": 0.5}])
    amp = RfNode("amp", "rf_amplifier", {"gainDb": 20.0}, _AMP_ANCHORS)  # x10 in Vpp
    aom = RfNode("aom", "aom", {}, _AOM_ANCHORS)
    nodes = [
        src, amp, aom,
        _cable("c1", "src", "CH0", "amp", "rf_in"),
        _cable("c2", "amp", "rf_out", "aom", "rf_in"),
    ]
    inp = _inputs(nodes, aoms=[AomPort("aom", "rf_in", False)])
    res = build_rf_propagation(inp, scrub_time_ns=0.0)
    sig = res.signal_at_port[port_key("aom", "rf_in")]
    assert sig.vpp == pytest.approx(5.0)  # 0.5 * 10
    assert sig.cumulative_gain_db == pytest.approx(20.0)
    assert sig.saturated is False


def test_amplifier_output_clamp_sets_saturated() -> None:
    # gain 40 dB (x100) on amp 1.0 Vpp -> 100 Vpp, clamped by outputPowerMaxDbm.
    src = _src([{"anchorName": "CH0", "frequencyMhz": 80.0, "amplitudeScale": 1.0}])
    amp = RfNode("amp", "rf_amplifier", {"gainDb": 40.0, "outputPowerMaxDbm": 30.0}, _AMP_ANCHORS)
    aom = RfNode("aom", "aom", {}, _AOM_ANCHORS)
    nodes = [
        src, amp, aom,
        _cable("c1", "src", "CH0", "amp", "rf_in"),
        _cable("c2", "amp", "rf_out", "aom", "rf_in"),
    ]
    inp = _inputs(nodes, aoms=[AomPort("aom", "rf_in", False)])
    res = build_rf_propagation(inp, scrub_time_ns=0.0)
    sig = res.signal_at_port[port_key("aom", "rf_in")]
    assert sig.saturated is True
    # 30 dBm = 1 W -> Vpp = sqrt(8*50*1) ~= 20.0
    assert sig.vpp == pytest.approx(math.sqrt(8 * 50 * 1.0))


def test_powered_off_source_emits_nothing() -> None:
    src = _src([{"anchorName": "CH0", "frequencyMhz": 80.0, "amplitudeScale": 1.0}])
    aom = RfNode("aom", "aom", {}, _AOM_ANCHORS)
    cab = _cable("c", "src", "CH0", "aom", "rf_in")
    inp = _inputs([src, aom, cab], aoms=[AomPort("aom", "rf_in", False)], powered_off=["src"])
    res = build_rf_propagation(inp, scrub_time_ns=0.0)
    assert port_key("aom", "rf_in") not in res.signal_at_port
    # The AOM is still CABLED to the (dead) source, so the RF link stays the
    # authority: 0 W -> no diffraction. Powering the source off must not hand
    # the AOM back its rated operating point.
    assert resolve_aom_rf_drive(inp, 0.0) == {"aom": {"rfDrivePowerW": 0.0}}


def test_manual_mode_aom_is_skipped() -> None:
    src = _src([{"anchorName": "CH0", "frequencyMhz": 80.0, "amplitudeScale": 1.0}])
    aom = RfNode("aom", "aom", {}, _AOM_ANCHORS)
    cab = _cable("c", "src", "CH0", "aom", "rf_in")
    inp = _inputs([src, aom, cab], aoms=[AomPort("aom", "rf_in", True)])  # manual=True
    assert resolve_aom_rf_drive(inp, 0.0) == {}


def _switch_scene(*, ttl_program_id: str | None, restState: str = "LOW"):
    """src -> switch(rf_in); switch RF1 -> aomA, RF2 -> aomB; PPG -> switch ttl_in."""
    src = _src([{"anchorName": "CH0", "frequencyMhz": 80.0, "amplitudeScale": 1.0}])
    sw = RfNode("sw", "rf_switch", {"throwCount": 2, "insertionLossDb": 1.0}, _SWITCH_ANCHORS)
    aom_a = RfNode("aomA", "aom", {}, _AOM_ANCHORS)
    aom_b = RfNode("aomB", "aom", {}, _AOM_ANCHORS)
    ppg_params: dict = {"restState": restState}
    if ttl_program_id is not None:
        ppg_params["timingProgramId"] = ttl_program_id
    ppg = RfNode("ppg", "programmable_pulse_generator", ppg_params, (_anc("rf_out"),))
    nodes = [
        src, sw, aom_a, aom_b, ppg,
        _cable("c0", "src", "CH0", "sw", "rf_in"),
        _cable("c1", "sw", "RF1", "aomA", "rf_in"),
        _cable("c2", "sw", "RF2", "aomB", "rf_in"),
        _cable("cttl", "ppg", "rf_out", "sw", "TTL"),
    ]
    aoms = [AomPort("aomA", "rf_in", False), AomPort("aomB", "rf_in", False)]
    return nodes, aoms


def test_switch_routes_to_default_throw_when_ttl_low() -> None:
    # No program covering t -> LOW -> throwCount 2, highThrow 2 -> active = 3-2 = 1 (RF1).
    nodes, aoms = _switch_scene(ttl_program_id="prog", restState="LOW")
    programs = {"prog": [{"spinCoreStartNs": 1000.0, "spinCoreEndNs": 2000.0}]}
    inp = _inputs(nodes, aoms=aoms, programs=programs)
    # Sample at t=0 (outside the HIGH interval) -> LOW -> RF1 active -> aomA driven.
    drive = resolve_aom_rf_drive(inp, 0.0)
    assert "aomA" in drive
    assert drive["aomA"].get("rfDrivePowerW", 0.0) > 0.0
    # aomB is link-capable (it gets RF2 when HIGH) but gated off at t=0 -> 0 W.
    assert drive["aomB"] == {"rfDrivePowerW": 0.0}


def test_switch_routes_to_high_throw_inside_interval() -> None:
    nodes, aoms = _switch_scene(ttl_program_id="prog", restState="LOW")
    programs = {"prog": [{"spinCoreStartNs": 1000.0, "spinCoreEndNs": 2000.0}]}
    inp = _inputs(nodes, aoms=aoms, programs=programs)
    # Sample at t=1500 (inside HIGH) -> RF2 active -> aomB driven, aomA gated off.
    drive = resolve_aom_rf_drive(inp, 1500.0)
    assert drive["aomB"].get("rfDrivePowerW", 0.0) > 0.0
    assert drive["aomA"] == {"rfDrivePowerW": 0.0}


def test_rest_high_holds_the_line_high_outside_intervals_while_scrubbing() -> None:
    # rest_state is the level OUTSIDE the drawn blocks — not an idle-only knob.
    # At t=0 (outside the interval) a HIGH rest keeps the switch on RF2.
    nodes, aoms = _switch_scene(ttl_program_id="prog", restState="HIGH")
    programs = {"prog": [{"spinCoreStartNs": 1000.0, "spinCoreEndNs": 2000.0}]}
    inp = _inputs(nodes, aoms=aoms, programs=programs)
    drive = resolve_aom_rf_drive(inp, 0.0)
    assert drive["aomB"].get("rfDrivePowerW", 0.0) > 0.0
    assert drive["aomA"] == {"rfDrivePowerW": 0.0}


def test_rest_high_inverts_drawn_intervals_to_low_pulses() -> None:
    # Same scene, sampled INSIDE the interval: HIGH rest makes it a LOW pulse.
    nodes, aoms = _switch_scene(ttl_program_id="prog", restState="HIGH")
    programs = {"prog": [{"spinCoreStartNs": 1000.0, "spinCoreEndNs": 2000.0}]}
    inp = _inputs(nodes, aoms=aoms, programs=programs)
    drive = resolve_aom_rf_drive(inp, 1500.0)
    assert drive["aomA"].get("rfDrivePowerW", 0.0) > 0.0
    assert drive["aomB"] == {"rfDrivePowerW": 0.0}


def test_ppg_with_no_program_still_asserts_its_rest_level() -> None:
    # A PPG is plugged in but carries no TimingProgram: it owns the line at its
    # rest level (it used to fall through to the switch's manual ttlState).
    nodes, aoms = _switch_scene(ttl_program_id=None, restState="HIGH")
    inp = _inputs(nodes, aoms=aoms)
    drive = resolve_aom_rf_drive(inp, 0.0)
    assert drive["aomB"].get("rfDrivePowerW", 0.0) > 0.0
    assert drive["aomA"] == {"rfDrivePowerW": 0.0}


def test_wired_but_never_driven_aom_is_gated_off_not_left_at_rated_drive() -> None:
    # Switch parked on RF1 in every section -> aomB never sees a carrier. It is
    # still CABLED, so the RF link is the authority: 0 W, no diffraction. (It
    # used to look "unwired" and fall back to its rated operating point.)
    nodes, aoms = _switch_scene(ttl_program_id=None, restState="LOW")
    inp = _inputs(nodes, aoms=aoms)
    drive = resolve_aom_rf_drive(inp, 0.0)
    assert drive["aomA"].get("rfDrivePowerW", 0.0) > 0.0
    assert drive["aomB"] == {"rfDrivePowerW": 0.0}
    # Rest snapshot too — nothing in the schedule ever drives aomB.
    assert resolve_aom_rf_drive(inp, None)["aomB"] == {"rfDrivePowerW": 0.0}


def test_uncabled_aom_keeps_its_rated_operating_point() -> None:
    src = _src([{"anchorName": "CH0", "frequencyMhz": 80.0, "amplitudeScale": 1.0}])
    aom = RfNode("aom", "aom", {}, _AOM_ANCHORS)
    inp = _inputs([src, aom], aoms=[AomPort("aom", "rf_in", False)])
    assert resolve_aom_rf_drive(inp, 0.0) == {}


def test_rest_snapshot_uses_ppg_reststate_when_scrub_stopped() -> None:
    # Scrub stopped (t=None): switch TTL follows the PPG restState, ignoring intervals.
    nodes, aoms = _switch_scene(ttl_program_id="prog", restState="HIGH")
    programs = {"prog": [{"spinCoreStartNs": 1000.0, "spinCoreEndNs": 2000.0}]}
    inp = _inputs(nodes, aoms=aoms, programs=programs)
    drive = resolve_aom_rf_drive(inp, None)  # rest snapshot, restState HIGH -> RF2 -> aomB
    assert drive["aomB"].get("rfDrivePowerW", 0.0) > 0.0
    assert drive["aomA"] == {"rfDrivePowerW": 0.0}


def test_ppg_attachment_supplies_ttl_edge_without_a_cable() -> None:
    """A PPG plugged straight into ttl_in (no rf_cable) still drives the switch.

    Parity with the frontend `readPpgAttachmentEdges`.
    """
    src = _src([{"anchorName": "CH0", "frequencyMhz": 80.0, "amplitudeScale": 1.0}])
    sw = RfNode("sw", "rf_switch", {"throwCount": 2, "insertionLossDb": 1.0}, _SWITCH_ANCHORS)
    ppg = RfNode(
        "ppg", "programmable_pulse_generator", {"timingProgramId": "prog"},
        (_anc("rf_out"),),
        ppg_attachment={
            "targetObjectId": "sw", "targetAnchorId": "ttl_in", "targetAnchorName": "TTL",
        },
    )
    nodes = [src, sw, ppg, _cable("c0", "src", "CH0", "sw", "rf_in")]
    programs = {"prog": [{"spinCoreStartNs": 1000.0, "spinCoreEndNs": 2000.0}]}
    # t inside the HIGH interval -> TTL HIGH -> highThrow 2 -> RF2 carries it.
    res = build_rf_propagation(_inputs(nodes, programs=programs), scrub_time_ns=1500.0)
    assert port_key("sw", "RF2") in res.signal_at_port
    assert port_key("sw", "RF1") not in res.signal_at_port
    # t outside -> LOW -> RF1.
    res_low = build_rf_propagation(_inputs(nodes, programs=programs), scrub_time_ns=0.0)
    assert port_key("sw", "RF1") in res_low.signal_at_port
    assert port_key("sw", "RF2") not in res_low.signal_at_port


def test_ppg_attachment_ignored_when_malformed() -> None:
    # A half-written attachment must not fabricate an edge.
    src = _src([{"anchorName": "CH0", "frequencyMhz": 80.0, "amplitudeScale": 1.0}])
    sw = RfNode("sw", "rf_switch", {"throwCount": 2, "insertionLossDb": 1.0}, _SWITCH_ANCHORS)
    ppg = RfNode("ppg", "programmable_pulse_generator", {"timingProgramId": "prog"},
                 (_anc("rf_out"),), ppg_attachment={"targetObjectId": "sw"})
    nodes = [src, sw, ppg, _cable("c0", "src", "CH0", "sw", "rf_in")]
    programs = {"prog": [{"spinCoreStartNs": 0.0, "spinCoreEndNs": 9999.0}]}
    # No edge -> TTL falls back to manual LOW -> RF1, even mid-"interval".
    res = build_rf_propagation(_inputs(nodes, programs=programs), scrub_time_ns=1500.0)
    assert port_key("sw", "RF1") in res.signal_at_port
    assert port_key("sw", "RF2") not in res.signal_at_port


def test_switch_ttl_state_from_asset_params_when_no_ppg() -> None:
    # No TTL cable at all: the manual ttlState decides. It lives on the ASSET
    # (default_params) -- the authoritative store -- not just kind_params.
    src = _src([{"anchorName": "CH0", "frequencyMhz": 80.0, "amplitudeScale": 1.0}])
    sw = RfNode("sw", "rf_switch", {"throwCount": 2, "insertionLossDb": 1.0},
                _SWITCH_ANCHORS, asset_params={"ttlState": "HIGH"})
    nodes = [src, sw, _cable("c0", "src", "CH0", "sw", "rf_in")]
    res = build_rf_propagation(_inputs(nodes), scrub_time_ns=0.0)
    # HIGH + default highThrow 2 -> RF2 carries the signal, RF1 stays dark.
    assert port_key("sw", "RF2") in res.signal_at_port
    assert port_key("sw", "RF1") not in res.signal_at_port


def test_switch_ttl_state_dynamic_sources_override_asset() -> None:
    # Per-instance dynamic_sources.ttlState (the plugin marks it tunable)
    # overrides the asset default.
    src = _src([{"anchorName": "CH0", "frequencyMhz": 80.0, "amplitudeScale": 1.0}])
    sw = RfNode("sw", "rf_switch", {"throwCount": 2, "insertionLossDb": 1.0},
                _SWITCH_ANCHORS, asset_params={"ttlState": "HIGH"},
                dynamic_sources={"ttlState": "LOW"})
    nodes = [src, sw, _cable("c0", "src", "CH0", "sw", "rf_in")]
    res = build_rf_propagation(_inputs(nodes), scrub_time_ns=0.0)
    assert port_key("sw", "RF1") in res.signal_at_port
    assert port_key("sw", "RF2") not in res.signal_at_port


def test_switch_active_high_throw_from_asset_params() -> None:
    # ttlActiveHighThrow authored on the asset flips which throw LOW selects.
    src = _src([{"anchorName": "CH0", "frequencyMhz": 80.0, "amplitudeScale": 1.0}])
    sw = RfNode("sw", "rf_switch", {"throwCount": 2, "insertionLossDb": 1.0},
                _SWITCH_ANCHORS, asset_params={"ttlActiveHighThrow": 1})
    nodes = [src, sw, _cable("c0", "src", "CH0", "sw", "rf_in")]
    res = build_rf_propagation(_inputs(nodes), scrub_time_ns=0.0)
    # LOW + highThrow 1 -> active = 3 - 1 = RF2.
    assert port_key("sw", "RF2") in res.signal_at_port
    assert port_key("sw", "RF1") not in res.signal_at_port


def test_amplifier_gain_from_dynamic_sources() -> None:
    # rf_amplifier reads gainDb through the same chain.
    src = _src([{"anchorName": "CH0", "frequencyMhz": 80.0, "amplitudeScale": 1.0}])
    amp = RfNode("amp", "rf_amplifier", {"gainDb": 0.0}, _AMP_ANCHORS,
                 dynamic_sources={"gainDb": 20.0})
    nodes = [src, amp, _cable("c0", "src", "CH0", "amp", "rf_in")]
    res = build_rf_propagation(_inputs(nodes), scrub_time_ns=0.0)
    out = res.signal_at_port[port_key("amp", "rf_out")]
    assert out.vpp == pytest.approx(10.0)  # 1.0 Vpp * 10^(20/20)


# --- _primary_asset_id: parity with frontend componentBindings.primaryAsset ---

def _comp(asset_3d_id=None):
    return SimpleNamespace(id="comp", asset_3d_id=asset_3d_id)


def _binding(*, parent=None, target_kind="asset", asset_3d_id="A"):
    return SimpleNamespace(
        parent_binding_id=parent, target_kind=target_kind, asset_3d_id=asset_3d_id,
    )


def test_primary_asset_single_root_asset_binding_wins() -> None:
    # Binding-backed scene: Component.asset_3d_id is None, asset hangs on the
    # single root binding. This is the case the legacy reader missed.
    assert _primary_asset_id(_comp(None), [_binding(asset_3d_id="A")]) == "A"


def test_primary_asset_falls_back_to_legacy_field() -> None:
    # No bindings (pre-binding scene) -> legacy Component.asset_3d_id.
    assert _primary_asset_id(_comp("L"), []) == "L"


def test_primary_asset_none_for_composite_multi_root() -> None:
    # Composite Component (>1 root) and no legacy field -> not a single-asset
    # device, so the RF graph seeds nothing.
    roots = [_binding(asset_3d_id="A"), _binding(asset_3d_id="B")]
    assert _primary_asset_id(_comp(None), roots) is None


def test_primary_asset_ignores_non_root_and_non_asset_bindings() -> None:
    # A child asset binding (e.g. a connector) is NOT the primary; the single
    # root must itself be target_kind="asset".
    bindings = [
        _binding(parent="root", asset_3d_id="child"),
        _binding(target_kind="subcomponent", asset_3d_id=None),
    ]
    assert _primary_asset_id(_comp("L"), bindings) == "L"
