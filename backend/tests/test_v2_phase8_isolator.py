"""V2 Phase 8: isolator axis cutover — schema + binding tests.

Reuses the polarizer's role="transmission" polarizationReference
binding mechanism from Phase 4.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.schemas import IsolatorParams
from app.v2_bindings import (
    POLARIZATION_REFERENCE_BINDING_KIND,
    V2_TRACKED_ISOLATOR_KEYS,
    get_isolator_axis_deg_beam_local,
    legacy_isolator_kind_params_from_binding,
)


def test_isolator_params_default_drops_axis_field():
    inst = IsolatorParams()
    fields = set(inst.model_dump(by_alias=True, exclude_none=True).keys())
    for forbidden in (
        "transmissionAxisDegBeamLocal",
        "transmissionAxisDeg",
    ):
        assert forbidden not in fields
    assert "forwardLossDb" in fields
    assert "isolationDb" in fields


def test_isolator_params_silently_drops_v1_axis():
    inst = IsolatorParams.model_validate({
        "forwardLossDb": 0.5,
        "isolationDb": 40.0,
        "transmissionAxisDegBeamLocal": 30.0,
    })
    assert "transmissionAxisDegBeamLocal" not in inst.model_dump(by_alias=True, exclude_none=True)


def test_isolator_params_drops_pre_phase5_alias():
    inst = IsolatorParams.model_validate({"transmissionAxisDeg": 12.5})
    assert "transmissionAxisDeg" not in inst.model_dump(by_alias=True, exclude_none=True)


def _iso_obj(axis_deg: float):
    return SimpleNamespace(properties={"anchorBindings": [{
        "id": "uuid",
        "name": "Isolator transmission axis",
        "anchorId": "optical_anchor",
        "kind": POLARIZATION_REFERENCE_BINDING_KIND,
        "frame": "anchorLocalXY",
        "payload": {"role": "transmission", "axisDegBeamLocal": axis_deg},
    }]})


def test_get_isolator_axis_returns_payload_value():
    assert get_isolator_axis_deg_beam_local(_iso_obj(45.0)) == 45.0


def test_get_isolator_axis_returns_none_when_no_binding():
    assert get_isolator_axis_deg_beam_local(SimpleNamespace(properties={})) is None
    assert get_isolator_axis_deg_beam_local(None) is None


def test_legacy_isolator_synthesiser_round_trip():
    patch = legacy_isolator_kind_params_from_binding(_iso_obj(75.0))
    assert patch == {"transmissionAxisDegBeamLocal": 75.0}


def test_legacy_isolator_synthesiser_empty_when_no_binding():
    assert legacy_isolator_kind_params_from_binding(SimpleNamespace(properties={})) == {}


def test_v2_tracked_isolator_keys_match_synthesiser_outputs():
    synthesised = legacy_isolator_kind_params_from_binding(_iso_obj(0.0))
    assert set(V2_TRACKED_ISOLATOR_KEYS) == set(synthesised.keys())


def test_default_kind_params_isolator_has_no_axis():
    from app.routers.components import DEFAULT_KIND_PARAMS

    assert "transmissionAxisDegBeamLocal" not in DEFAULT_KIND_PARAMS["isolator"]
    assert "forwardLossDb" in DEFAULT_KIND_PARAMS["isolator"]
