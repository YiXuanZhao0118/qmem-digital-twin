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
    ):
        assert forbidden not in fields
    # Other AOM physics fields stay (centerFreqMhz, baseEfficiency, …)
    assert "centerFreqMhz" in fields


def test_aom_params_silently_drops_v1_direction_fields():
    inst = AOMParams.model_validate({
        "centerFreqMhz": 80.0,
        "baseEfficiency": 0.85,
        "deflectionPerMhzUrad": 200.0,
        "acousticVelocityMPerS": 4200.0,
        "modulationBandwidthMhz": 20.0,
        "rfPropagationDirectionBodyLocal": [-1, 0, 0],
        "acousticAxisBodyLocal": [-1, 0, 0],
    })
    fields = inst.model_dump(by_alias=True, exclude_none=True)
    for forbidden in ("rfPropagationDirectionBodyLocal", "acousticAxisBodyLocal"):
        assert forbidden not in fields
    assert fields["centerFreqMhz"] == 80.0


def test_aom_params_keeps_lab_frame_alias_for_bragg_tilt():
    """The pre-Phase-5 alias (`braggTiltAxisAngleDeg → braggTiltAxisDegLab`)
    must still translate, not be dropped by the new validator."""
    inst = AOMParams.model_validate({
        "centerFreqMhz": 80.0,
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
    # Other physics fields stay.
    assert "centerFreqMhz" in aom
    assert "rfDrivePowerW" in aom
