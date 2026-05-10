"""V2 Phase 4: waveplate + polarizer axis cutover — schema + binding tests.

Phase 4 moves the waveplate fast-axis angle and the polarizer transmission-
axis angle from kindParams to a per-instance ``polarizationReference``
binding (role="fast" / role="transmission") on the SceneObject.

The binding payload still carries a scalar ``axisDegBeamLocal`` for now —
promoting it to a body-local vector + having the solver project to the
beam frame is a later phase. The structural boundary moves now; the
numeric model can refine later.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.schemas import PolarizerParams, WaveplateParams
from app.v2_bindings import (
    POLARIZATION_REFERENCE_BINDING_KIND,
    V2_TRACKED_POLARIZER_KEYS,
    V2_TRACKED_WAVEPLATE_KEYS,
    get_polarizer_axis_deg_beam_local,
    get_waveplate_axis_deg_beam_local,
    legacy_polarizer_kind_params_from_binding,
    legacy_waveplate_kind_params_from_binding,
)


# ---- WaveplateParams hard cutover ----------------------------------------


def test_waveplate_params_default_has_no_axis_field():
    inst = WaveplateParams()
    fields = set(inst.model_dump(by_alias=True, exclude_none=True).keys())
    assert "fastAxisDegBeamLocal" not in fields
    assert "fastAxisDeg" not in fields
    assert "retardanceLambda" in fields
    assert "transmission" in fields


def test_waveplate_params_silently_drops_axis_field():
    inst = WaveplateParams.model_validate({
        "retardanceLambda": 0.5,
        "fastAxisDegBeamLocal": 45.0,
        "transmission": 0.99,
    })
    fields = inst.model_dump(by_alias=True, exclude_none=True)
    assert "fastAxisDegBeamLocal" not in fields
    assert "fastAxisDeg" not in fields


def test_waveplate_params_drops_pre_phase5_alias_too():
    inst = WaveplateParams.model_validate({"retardanceLambda": 0.25, "fastAxisDeg": 12.5})
    assert "fastAxisDeg" not in inst.model_dump(by_alias=True, exclude_none=True)


# ---- PolarizerParams hard cutover ----------------------------------------


def test_polarizer_params_default_has_no_axis_field():
    inst = PolarizerParams()
    fields = set(inst.model_dump(by_alias=True, exclude_none=True).keys())
    assert "transmissionAxisDegBeamLocal" not in fields
    assert "transmissionAxisDeg" not in fields
    assert "extinctionRatioDb" in fields
    assert "transmission" in fields


def test_polarizer_params_silently_drops_axis_field():
    inst = PolarizerParams.model_validate({
        "transmissionAxisDegBeamLocal": 30.0,
        "extinctionRatioDb": 30.0,
        "transmission": 0.95,
    })
    assert "transmissionAxisDegBeamLocal" not in inst.model_dump(by_alias=True, exclude_none=True)


# ---- waveplate axis getter / synthesiser ---------------------------------


def _wp_obj(axis_deg: float) -> SimpleNamespace:
    return SimpleNamespace(properties={"anchorBindings": [{
        "id": "uuid",
        "name": "Fast axis",
        "anchorId": "optical_anchor",
        "kind": POLARIZATION_REFERENCE_BINDING_KIND,
        "frame": "anchorLocalXY",
        "payload": {"role": "fast", "axisDegBeamLocal": axis_deg},
    }]})


def test_get_waveplate_axis_returns_payload_value():
    assert get_waveplate_axis_deg_beam_local(_wp_obj(45.0)) == 45.0


def test_get_waveplate_axis_returns_none_when_no_binding():
    assert get_waveplate_axis_deg_beam_local(SimpleNamespace(properties={})) is None
    assert get_waveplate_axis_deg_beam_local(None) is None


def test_get_waveplate_axis_ignores_polarizer_role_binding():
    """Role discrimination: a polarizer binding on the same object must
    not be mistaken for a waveplate binding."""
    obj = SimpleNamespace(properties={"anchorBindings": [{
        "id": "uuid",
        "kind": POLARIZATION_REFERENCE_BINDING_KIND,
        "payload": {"role": "transmission", "axisDegBeamLocal": 30.0},
    }]})
    assert get_waveplate_axis_deg_beam_local(obj) is None


def test_legacy_waveplate_kind_params_synthesiser_round_trip():
    obj = _wp_obj(75.0)
    patch = legacy_waveplate_kind_params_from_binding(obj)
    assert patch == {"fastAxisDegBeamLocal": 75.0}


def test_legacy_waveplate_synthesiser_empty_when_no_binding():
    assert legacy_waveplate_kind_params_from_binding(SimpleNamespace(properties={})) == {}


# ---- polarizer axis getter / synthesiser ---------------------------------


def _pol_obj(axis_deg: float) -> SimpleNamespace:
    return SimpleNamespace(properties={"anchorBindings": [{
        "id": "uuid",
        "name": "Transmission axis",
        "anchorId": "optical_anchor",
        "kind": POLARIZATION_REFERENCE_BINDING_KIND,
        "frame": "anchorLocalXY",
        "payload": {"role": "transmission", "axisDegBeamLocal": axis_deg},
    }]})


def test_get_polarizer_axis_returns_payload_value():
    assert get_polarizer_axis_deg_beam_local(_pol_obj(15.5)) == 15.5


def test_legacy_polarizer_kind_params_synthesiser_round_trip():
    patch = legacy_polarizer_kind_params_from_binding(_pol_obj(0.0))
    assert patch == {"transmissionAxisDegBeamLocal": 0.0}


def test_legacy_polarizer_synthesiser_ignores_waveplate_role():
    obj = SimpleNamespace(properties={"anchorBindings": [{
        "id": "uuid",
        "kind": POLARIZATION_REFERENCE_BINDING_KIND,
        "payload": {"role": "fast", "axisDegBeamLocal": 45.0},
    }]})
    assert legacy_polarizer_kind_params_from_binding(obj) == {}


# ---- V2_TRACKED constants --------------------------------------------------


def test_v2_tracked_waveplate_keys_match_synthesiser_output():
    """The PUT translator strips fields in V2_TRACKED_WAVEPLATE_KEYS; if the
    synthesiser produces something outside that set, the user could lose
    edits."""
    synthesised = legacy_waveplate_kind_params_from_binding(_wp_obj(0.0))
    assert set(V2_TRACKED_WAVEPLATE_KEYS) == set(synthesised.keys())


def test_v2_tracked_polarizer_keys_match_synthesiser_output():
    synthesised = legacy_polarizer_kind_params_from_binding(_pol_obj(0.0))
    assert set(V2_TRACKED_POLARIZER_KEYS) == set(synthesised.keys())


# ---- DEFAULT_KIND_PARAMS no longer carries axis fields -------------------


def test_default_kind_params_waveplate_has_no_axis():
    from app.routers.components import DEFAULT_KIND_PARAMS

    assert "fastAxisDegBeamLocal" not in DEFAULT_KIND_PARAMS["waveplate"]
    assert "retardanceLambda" in DEFAULT_KIND_PARAMS["waveplate"]


def test_default_kind_params_polarizer_has_no_axis():
    from app.routers.components import DEFAULT_KIND_PARAMS

    assert "transmissionAxisDegBeamLocal" not in DEFAULT_KIND_PARAMS["polarizer"]
    assert "extinctionRatioDb" in DEFAULT_KIND_PARAMS["polarizer"]
