"""V2 Phase 7: AOM RF / acoustic direction cutover tests."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.schemas import AOMParams
from app.v2_bindings import (
    RF_DIRECTION_BINDING_KIND,
    V2_TRACKED_AOM_KEYS,
    get_aom_rf_direction_body_local,
    legacy_aom_kind_params_from_binding,
)


def test_aom_params_default_drops_direction_fields():
    inst = AOMParams()
    fields = set(inst.model_dump(by_alias=True, exclude_none=True).keys())
    for forbidden in (
        "rfPropagationDirectionBodyLocal",
        "acousticAxisBodyLocal",
        "rfPropagationDirectionLocal",
        "acousticAxisLocal",
        # Phase B: AOM RF drive moved to upstream link resolution.
        "centerFreqMhz",
        "rfDrivePowerW",
    ):
        assert forbidden not in fields
    # Other AOM physics fields stay (baseEfficiency, …)
    assert "baseEfficiency" in fields


def test_aom_params_silently_drops_v1_direction_fields():
    inst = AOMParams.model_validate({
        # Phase B: centerFreqMhz / rfDrivePowerW now legacy — validator
        # should silently drop them like the V1 direction aliases.
        "centerFreqMhz": 80.0,
        "rfDrivePowerW": 1.0,
        "baseEfficiency": 0.85,
        "deflectionPerMhzUrad": 200.0,
        "acousticVelocityMPerS": 4200.0,
        "modulationBandwidthMhz": 20.0,
        "rfPropagationDirectionBodyLocal": [-1, 0, 0],
        "acousticAxisBodyLocal": [-1, 0, 0],
    })
    fields = inst.model_dump(by_alias=True, exclude_none=True)
    for forbidden in (
        "rfPropagationDirectionBodyLocal",
        "acousticAxisBodyLocal",
        "centerFreqMhz",
        "rfDrivePowerW",
    ):
        assert forbidden not in fields
    assert fields["baseEfficiency"] == 0.85


def test_aom_params_keeps_lab_frame_alias_for_bragg_tilt():
    """The pre-Phase-5 alias (`braggTiltAxisAngleDeg → braggTiltAxisDegLab`)
    must still translate, not be dropped by the new validator."""
    inst = AOMParams.model_validate({
        "baseEfficiency": 0.85,
        "deflectionPerMhzUrad": 200.0,
        "acousticVelocityMPerS": 4200.0,
        "modulationBandwidthMhz": 20.0,
        "braggTiltAxisAngleDeg": 45.0,
    })
    assert inst.bragg_tilt_axis_deg_lab == 45.0


def _aom_obj(direction: list[float]):
    return SimpleNamespace(properties={"anchorBindings": [{
        "id": "uuid",
        "name": "RF / acoustic propagation",
        "anchorId": "optical_anchor",
        "kind": RF_DIRECTION_BINDING_KIND,
        "frame": "anchorLocalXY",
        "payload": {"directionBodyLocal": direction},
    }]})


def test_get_aom_rf_direction_returns_payload_value():
    assert get_aom_rf_direction_body_local(_aom_obj([-1.0, 0.0, 0.0])) == [-1.0, 0.0, 0.0]


def test_get_aom_rf_direction_returns_none_when_no_binding():
    assert get_aom_rf_direction_body_local(SimpleNamespace(properties={})) is None
    assert get_aom_rf_direction_body_local(None) is None


def test_legacy_synthesiser_emits_both_aliases_for_back_compat():
    """The legacy fields rfPropagationDirectionBodyLocal AND
    acousticAxisBodyLocal aliased the same vector in V1 — keep both
    populated in the synthesised payload so any legacy reader works."""
    patch = legacy_aom_kind_params_from_binding(_aom_obj([-1.0, 0.0, 0.0]))
    assert patch == {
        "rfPropagationDirectionBodyLocal": [-1.0, 0.0, 0.0],
        "acousticAxisBodyLocal": [-1.0, 0.0, 0.0],
    }


def test_legacy_synthesiser_uses_default_when_no_binding():
    """Default = MT80 convention [-1, 0, 0] (body -X is transducer → absorber)."""
    patch = legacy_aom_kind_params_from_binding(SimpleNamespace(properties={}))
    assert patch["rfPropagationDirectionBodyLocal"] == [-1.0, 0.0, 0.0]


def test_v2_tracked_keys_match_synthesiser_outputs():
    synthesised = legacy_aom_kind_params_from_binding(_aom_obj([0.0, 1.0, 0.0]))
    assert set(V2_TRACKED_AOM_KEYS) == set(synthesised.keys())


def test_default_kind_params_aom_has_no_direction_fields():
    from app.routers.components import DEFAULT_KIND_PARAMS

    aom = DEFAULT_KIND_PARAMS["aom"]
    assert "rfPropagationDirectionBodyLocal" not in aom
    assert "acousticAxisBodyLocal" not in aom
    # Phase B: RF drive resolved from upstream — default kindParams must
    # not seed centerFreqMhz / rfDrivePowerW.
    assert "centerFreqMhz" not in aom
    assert "rfDrivePowerW" not in aom
    # Other physics fields stay.
    assert "baseEfficiency" in aom


# ---------------------------------------------------------------------------
# Phase B: hydrate_aom_rf_drive — resolves AOM RF drive from upstream
# rf_source channel via the AOM's rf_in rfCableEndpoints link.
# ---------------------------------------------------------------------------

import uuid as _uuid


def _make_pe(object_id, kind, kind_params):
    return SimpleNamespace(object_id=object_id, element_kind=kind, kind_params=kind_params)


def _make_obj(obj_id, properties=None):
    return SimpleNamespace(id=obj_id, properties=properties or {})


def test_hydrate_aom_rf_drive_injects_freq_and_power_from_upstream():
    from app.solvers.optics_seq import hydrate_aom_rf_drive

    aom_id = _uuid.uuid4()
    src_id = _uuid.uuid4()
    cable_id = _uuid.uuid4()
    pes = [
        _make_pe(aom_id, "aom", {"baseEfficiency": 0.85}),
        _make_pe(src_id, "rf_source", {
            "channels": [
                {"channelIndex": 0, "anchorName": "CH0", "frequencyMhz": 120.0, "amplitudeScale": 0.5},
            ],
        }),
        _make_pe(cable_id, "rf_cable", {"lengthMm": 150.0}),
    ]
    objects_by_id = {
        aom_id: _make_obj(aom_id),
        src_id: _make_obj(src_id),
        cable_id: _make_obj(cable_id, {
            "rfCableEndpoints": {
                "A": {"targetObjectId": str(src_id), "targetAnchorName": "CH0", "targetAnchorId": "rf_out"},
                "B": {"targetObjectId": str(aom_id), "targetAnchorName": "rf_in", "targetAnchorId": "rf_in"},
            },
        }),
    }

    hydrate_aom_rf_drive(pes, objects_by_id)

    aom_pe = next(p for p in pes if p.element_kind == "aom")
    assert aom_pe.kind_params["centerFreqMhz"] == 120.0
    # Vpp = 0.5 × 1.0 V_full_scale = 0.5 V; P = 0.5² / (8 × 50) = 0.000625 W
    assert abs(aom_pe.kind_params["rfDrivePowerW"] - (0.5 * 0.5) / (8 * 50)) < 1e-9


def test_hydrate_aom_rf_drive_skips_orphan_aom():
    """AOM with no rf_cable link gets no injection — apply_aom then
    falls back to its default freq + baseEfficiency path."""
    from app.solvers.optics_seq import hydrate_aom_rf_drive

    aom_id = _uuid.uuid4()
    pes = [_make_pe(aom_id, "aom", {"baseEfficiency": 0.85})]
    objects_by_id = {aom_id: _make_obj(aom_id)}

    hydrate_aom_rf_drive(pes, objects_by_id)

    assert "centerFreqMhz" not in pes[0].kind_params
    assert "rfDrivePowerW" not in pes[0].kind_params


def test_hydrate_aom_rf_drive_clamps_to_rf_power_max():
    """If kindParams.rfPowerMaxW is set, the injected rfDrivePowerW is
    clamped down to that value (datasheet safety cap)."""
    from app.solvers.optics_seq import hydrate_aom_rf_drive

    aom_id = _uuid.uuid4()
    src_id = _uuid.uuid4()
    cable_id = _uuid.uuid4()
    pes = [
        # rfPowerMaxW = 0.0001 W — caps the resolved 0.0025 W
        _make_pe(aom_id, "aom", {"baseEfficiency": 0.85, "rfPowerMaxW": 0.0001}),
        _make_pe(src_id, "rf_source", {
            "channels": [
                {"channelIndex": 0, "anchorName": "CH0", "frequencyMhz": 80.0, "amplitudeScale": 1.0},
            ],
        }),
        _make_pe(cable_id, "rf_cable", {}),
    ]
    objects_by_id = {
        aom_id: _make_obj(aom_id),
        src_id: _make_obj(src_id),
        cable_id: _make_obj(cable_id, {
            "rfCableEndpoints": {
                "A": {"targetObjectId": str(src_id), "targetAnchorName": "CH0", "targetAnchorId": "rf_out"},
                "B": {"targetObjectId": str(aom_id), "targetAnchorName": "rf_in", "targetAnchorId": "rf_in"},
            },
        }),
    }

    hydrate_aom_rf_drive(pes, objects_by_id)

    aom_pe = next(p for p in pes if p.element_kind == "aom")
    assert aom_pe.kind_params["rfDrivePowerW"] == 0.0001
