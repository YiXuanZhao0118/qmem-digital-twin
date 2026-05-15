"""Backend RF propagation tests — mirror of
``frontend/src/utils/__tests__/rfPropagation.test.ts`` so both sides of the
twin agree on the multi-hop Vpp transform.

Topology under test:

    AD9959.CH0 ──cable A──► ZHL-1-2W.rf_in │ rf_out ──cable B──► AOM.rf_in

Pinned invariants:
  I1. The signal at AD9959.CH0 carries the raw source state.
  I2. The signal at ZHL-1-2W.rf_in equals the source (lossless cable).
  I3. The signal at ZHL-1-2W.rf_out has Vpp = source_vpp · 10^(gainDb/20).
  I4. The signal at AOM.rf_in equals the amplifier output.
  I5. When outputPowerMaxDbm caps the output, `saturated` flips to true and
      Vpp clamps at the dBm-derived ceiling.
  I6. A direct source → AOM chain (no amp) still works (regression).
  I7. `hydrate_aom_rf_drive` injects `centerFreqMhz` + `rfDrivePowerW` on
      the AOM PhysicsElement, matching the propagation result.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from app.solvers.optics_seq import hydrate_aom_rf_drive
from app.solvers.rf_propagation import (
    AD9959_VPP_FULL_SCALE,
    build_rf_propagation,
    dbm_to_w,
    power_w_to_vpp,
)


# ---------------------------------------------------------------------------
# Fakes — minimal stand-ins for SceneObject / PhysicsElement / Component /
# Asset3D. Real models are SQLAlchemy ORM rows; for unit tests we don't need
# the DB layer, just the attribute shape ``rf_propagation`` reads.
# ---------------------------------------------------------------------------


@dataclass
class FakeObj:
    id: str
    component_id: str
    properties: dict


@dataclass
class FakePe:
    object_id: str
    element_kind: str
    kind_params: dict


@dataclass
class FakeComp:
    id: str
    asset_3d_id: str


@dataclass
class FakeAsset:
    id: str
    anchors: list[dict] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------


def _make_ad9959(obj_id: str, freq_mhz: float, amp_scale: float):
    obj = FakeObj(id=obj_id, component_id=f"comp-{obj_id}", properties={})
    pe = FakePe(
        object_id=obj_id,
        element_kind="rf_source",
        kind_params={
            "channels": [
                {
                    "channelIndex": 0,
                    "anchorName": "CH0",
                    "frequencyMhz": freq_mhz,
                    "amplitudeScale": amp_scale,
                }
            ]
        },
    )
    comp = FakeComp(id=f"comp-{obj_id}", asset_3d_id=f"asset-{obj_id}")
    asset = FakeAsset(id=f"asset-{obj_id}", anchors=[{"id": "rf_out", "name": "CH0"}])
    return obj, pe, comp, asset


def _make_amp(obj_id: str, gain_db: float, max_dbm: float | None = None):
    obj = FakeObj(id=obj_id, component_id=f"comp-{obj_id}", properties={})
    kp: dict[str, Any] = {"gainDb": gain_db}
    if max_dbm is not None:
        kp["outputPowerMaxDbm"] = max_dbm
    pe = FakePe(object_id=obj_id, element_kind="rf_amplifier", kind_params=kp)
    comp = FakeComp(id=f"comp-{obj_id}", asset_3d_id=f"asset-{obj_id}")
    asset = FakeAsset(
        id=f"asset-{obj_id}",
        anchors=[
            {"id": "rf_in", "name": "rf_in"},
            {"id": "rf_out", "name": "rf_out"},
        ],
    )
    return obj, pe, comp, asset


def _make_aom(obj_id: str):
    obj = FakeObj(id=obj_id, component_id=f"comp-{obj_id}", properties={})
    pe = FakePe(object_id=obj_id, element_kind="aom", kind_params={})
    comp = FakeComp(id=f"comp-{obj_id}", asset_3d_id=f"asset-{obj_id}")
    asset = FakeAsset(id=f"asset-{obj_id}", anchors=[{"id": "rf_in", "name": "rf_in"}])
    return obj, pe, comp, asset


def _make_cable(cable_id: str, a: tuple[str, str], b: tuple[str, str]):
    obj = FakeObj(
        id=cable_id,
        component_id=f"comp-{cable_id}",
        properties={
            "rfCableEndpoints": {
                "A": {
                    "targetObjectId": a[0],
                    "targetAnchorId": "rf_out",
                    "targetAnchorName": a[1],
                },
                "B": {
                    "targetObjectId": b[0],
                    "targetAnchorId": "rf_in",
                    "targetAnchorName": b[1],
                },
            }
        },
    )
    pe = FakePe(object_id=cable_id, element_kind="rf_cable", kind_params={"lengthMm": 100})
    comp = FakeComp(id=f"comp-{cable_id}", asset_3d_id=f"asset-{cable_id}")
    asset = FakeAsset(id=f"asset-{cable_id}", anchors=[])
    return obj, pe, comp, asset


def _scene(*parts):
    """Flatten a list of (obj, pe, comp, asset) tuples into the maps that
    build_rf_propagation / hydrate_aom_rf_drive want."""
    objects_by_id = {}
    elements = []
    components_by_id = {}
    assets_by_id = {}
    for obj, pe, comp, asset in parts:
        objects_by_id[obj.id] = obj
        elements.append(pe)
        components_by_id[comp.id] = comp
        assets_by_id[asset.id] = asset
    return {
        "objects_by_id": objects_by_id,
        "elements": elements,
        "components_by_id": components_by_id,
        "assets_by_id": assets_by_id,
    }


# ---------------------------------------------------------------------------
# Tests — propagation
# ---------------------------------------------------------------------------


def test_propagates_source_amp_aom_chain():
    """I1–I4 — full chain reaches the AOM with amplifier gain applied."""
    src = _make_ad9959("src1", 80.0, 0.5)
    amp = _make_amp("amp1", 20.0)
    aom = _make_aom("aom1")
    cable_a = _make_cable("ca", ("src1", "CH0"), ("amp1", "rf_in"))
    cable_b = _make_cable("cb", ("amp1", "rf_out"), ("aom1", "rf_in"))
    scene = _scene(src, amp, aom, cable_a, cable_b)
    result = build_rf_propagation(**scene)

    src_vpp = 0.5 * AD9959_VPP_FULL_SCALE
    # I1
    s_src = result.signal_at_port[("src1", "CH0")]
    assert s_src.frequency_mhz == 80.0
    assert s_src.vpp == pytest.approx(src_vpp)
    assert s_src.cumulative_gain_db == 0.0
    # I2
    s_amp_in = result.signal_at_port[("amp1", "rf_in")]
    assert s_amp_in.vpp == pytest.approx(src_vpp)
    # I3
    s_amp_out = result.signal_at_port[("amp1", "rf_out")]
    assert s_amp_out.vpp == pytest.approx(src_vpp * 10.0, rel=1e-5)
    assert s_amp_out.cumulative_gain_db == pytest.approx(20.0)
    assert s_amp_out.saturated is False
    # I4
    s_aom = result.signal_at_port[("aom1", "rf_in")]
    assert s_aom.vpp == pytest.approx(src_vpp * 10.0, rel=1e-5)
    assert s_aom.frequency_mhz == 80.0
    assert s_aom.passthrough_object_ids == ("amp1",)
    assert s_aom.source_object_id == "src1"


def test_clamps_at_output_power_max():
    """I5 — outputPowerMaxDbm caps Vpp and flags saturated."""
    src = _make_ad9959("src1", 80.0, 1.0)
    amp = _make_amp("amp1", 30.0, 30.0)  # +30 dB gain, max +30 dBm = 1 W
    aom = _make_aom("aom1")
    cable_a = _make_cable("ca", ("src1", "CH0"), ("amp1", "rf_in"))
    cable_b = _make_cable("cb", ("amp1", "rf_out"), ("aom1", "rf_in"))
    scene = _scene(src, amp, aom, cable_a, cable_b)
    result = build_rf_propagation(**scene)

    expected_cap_vpp = power_w_to_vpp(dbm_to_w(30.0))
    s_aom = result.signal_at_port[("aom1", "rf_in")]
    assert s_aom.vpp == pytest.approx(expected_cap_vpp, rel=1e-5)
    assert s_aom.saturated is True


def test_synthesises_default_channels_when_channels_null():
    """The dds_ad9959_pcb auto-create path leaves channels at null; the
    walker must fall back to one default seed per rf_out asset anchor so
    the downstream AOM still receives a signal at first solve."""
    src = _make_ad9959("src1", 80.0, 0.5)
    src[1].kind_params = {}  # strip the channels[] the builder seeded
    aom = _make_aom("aom1")
    cable = _make_cable("c", ("src1", "CH0"), ("aom1", "rf_in"))
    scene = _scene(src, aom, cable)
    result = build_rf_propagation(**scene)
    s_aom = result.signal_at_port[("aom1", "rf_in")]
    assert s_aom.frequency_mhz == 80.0
    assert s_aom.vpp == pytest.approx(AD9959_VPP_FULL_SCALE)
    assert s_aom.source_anchor_name == "CH0"


def test_direct_source_to_aom_no_amp():
    """I6 — regression: pre-Phase-1 direct chain still works."""
    src = _make_ad9959("src1", 80.0, 0.7)
    aom = _make_aom("aom1")
    cable = _make_cable("c", ("src1", "CH0"), ("aom1", "rf_in"))
    scene = _scene(src, aom, cable)
    result = build_rf_propagation(**scene)

    s_aom = result.signal_at_port[("aom1", "rf_in")]
    assert s_aom.vpp == pytest.approx(0.7 * AD9959_VPP_FULL_SCALE)
    assert s_aom.cumulative_gain_db == 0.0
    assert s_aom.passthrough_object_ids == ()


# ---------------------------------------------------------------------------
# Tests — hydrate_aom_rf_drive integration
# ---------------------------------------------------------------------------


def test_hydrate_aom_rf_drive_injects_post_amp_state():
    """I7 — the AOM PhysicsElement ends up with centerFreqMhz + a drive
    power that reflects the post-amplifier Vpp²/(8·Z)."""
    src = _make_ad9959("src1", 80.0, 0.5)  # 0.5 Vpp at source
    amp = _make_amp("amp1", 20.0)  # ×10 → 5 Vpp post-amp
    aom = _make_aom("aom1")
    cable_a = _make_cable("ca", ("src1", "CH0"), ("amp1", "rf_in"))
    cable_b = _make_cable("cb", ("amp1", "rf_out"), ("aom1", "rf_in"))
    scene = _scene(src, amp, aom, cable_a, cable_b)

    hydrate_aom_rf_drive(
        scene["elements"],
        scene["objects_by_id"],
        scene["components_by_id"],
        scene["assets_by_id"],
    )

    aom_pe = next(e for e in scene["elements"] if e.object_id == "aom1")
    assert aom_pe.kind_params["centerFreqMhz"] == 80.0
    # 5 Vpp into 50 Ω = 25 / 400 W = 0.0625 W
    assert aom_pe.kind_params["rfDrivePowerW"] == pytest.approx(0.0625, rel=1e-5)


def test_hydrate_aom_rf_drive_respects_rf_power_max():
    """rfPowerMaxW on the AOM still clamps the resolved drive."""
    src = _make_ad9959("src1", 80.0, 1.0)
    amp = _make_amp("amp1", 30.0)  # ×31.6
    aom = _make_aom("aom1")
    aom[1].kind_params = {"rfPowerMaxW": 0.5}  # AOM safety cap at 0.5 W
    cable_a = _make_cable("ca", ("src1", "CH0"), ("amp1", "rf_in"))
    cable_b = _make_cable("cb", ("amp1", "rf_out"), ("aom1", "rf_in"))
    scene = _scene(src, amp, aom, cable_a, cable_b)

    hydrate_aom_rf_drive(
        scene["elements"],
        scene["objects_by_id"],
        scene["components_by_id"],
        scene["assets_by_id"],
    )

    aom_pe = next(e for e in scene["elements"] if e.object_id == "aom1")
    assert aom_pe.kind_params["rfDrivePowerW"] == pytest.approx(0.5)
