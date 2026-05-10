"""V2 Phase 6: beam_splitter coating-normal + PBS axis cutover tests."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.schemas import BeamSplitterParams
from app.v2_bindings import (
    OPTICAL_SURFACE_BINDING_KIND,
    POLARIZATION_REFERENCE_BINDING_KIND,
    V2_TRACKED_BEAM_SPLITTER_KEYS,
    get_beam_splitter_coating_normal,
    legacy_beam_splitter_kind_params_from_bindings,
)


def test_beam_splitter_params_default_has_no_geometry_fields():
    inst = BeamSplitterParams()
    fields = set(inst.model_dump(by_alias=True, exclude_none=True).keys())
    for forbidden in ("coatingNormalBodyLocal", "transmissionAxisDegBeamLocal"):
        assert forbidden not in fields
    assert "splitRatioTransmitted" in fields
    assert "polarizing" in fields


def test_beam_splitter_params_silently_drops_v1_fields():
    inst = BeamSplitterParams.model_validate({
        "splitRatioTransmitted": 0.5,
        "polarizing": True,
        "coatingNormalBodyLocal": [0.7, 0.7, 0],
        "transmissionAxisDegBeamLocal": 30.0,
    })
    fields = inst.model_dump(by_alias=True, exclude_none=True)
    for forbidden in ("coatingNormalBodyLocal", "transmissionAxisDegBeamLocal"):
        assert forbidden not in fields
    assert fields["polarizing"] is True


def _bs_obj_with_normal(normal: list[float], *, polarizing: bool = False, axis: float | None = None):
    bindings: list = [{
        "id": "uuid_surface",
        "name": "Internal coating",
        "anchorId": "optical_anchor",
        "kind": OPTICAL_SURFACE_BINDING_KIND,
        "frame": "anchorLocalXY",
        "payload": {"normalBodyLocal": normal},
    }]
    if polarizing and axis is not None:
        bindings.append({
            "id": "uuid_pol",
            "name": "PBS transmission axis",
            "anchorId": "optical_anchor",
            "kind": POLARIZATION_REFERENCE_BINDING_KIND,
            "frame": "anchorLocalXY",
            "payload": {"role": "transmission", "axisDegBeamLocal": axis},
        })
    return SimpleNamespace(properties={"anchorBindings": bindings})


def test_get_beam_splitter_coating_normal_reads_first_optical_surface():
    obj = _bs_obj_with_normal([0.7071, -0.7071, 0.0])
    assert get_beam_splitter_coating_normal(obj) == [0.7071, -0.7071, 0.0]


def test_legacy_synthesiser_returns_default_normal_when_no_binding():
    obj = SimpleNamespace(properties={})
    patch = legacy_beam_splitter_kind_params_from_bindings(obj, polarizing=False)
    assert pytest.approx(patch["coatingNormalBodyLocal"][0], rel=1e-9) == 0.7071067811865475
    assert pytest.approx(patch["coatingNormalBodyLocal"][1], rel=1e-9) == 0.7071067811865475
    assert patch["coatingNormalBodyLocal"][2] == 0.0
    assert "transmissionAxisDegBeamLocal" not in patch


def test_legacy_synthesiser_omits_pbs_axis_when_not_polarizing():
    obj = _bs_obj_with_normal([0.7071, 0.7071, 0], polarizing=True, axis=45.0)
    # Caller passes polarizing=False → only coating normal, no axis.
    patch = legacy_beam_splitter_kind_params_from_bindings(obj, polarizing=False)
    assert "transmissionAxisDegBeamLocal" not in patch


def test_legacy_synthesiser_emits_pbs_axis_when_polarizing():
    obj = _bs_obj_with_normal([0.7071, 0.7071, 0], polarizing=True, axis=45.0)
    patch = legacy_beam_splitter_kind_params_from_bindings(obj, polarizing=True)
    assert patch["transmissionAxisDegBeamLocal"] == 45.0


def test_legacy_synthesiser_emits_default_axis_when_polarizing_but_no_binding():
    obj = _bs_obj_with_normal([0.7071, 0.7071, 0])  # no polarization binding
    patch = legacy_beam_splitter_kind_params_from_bindings(obj, polarizing=True)
    assert patch["transmissionAxisDegBeamLocal"] == 0.0


def test_v2_tracked_keys_match_synthesiser_outputs():
    obj = _bs_obj_with_normal([0.7071, 0.7071, 0], polarizing=True, axis=10.0)
    synthesised = legacy_beam_splitter_kind_params_from_bindings(obj, polarizing=True)
    assert set(V2_TRACKED_BEAM_SPLITTER_KEYS) == set(synthesised.keys())


def test_default_kind_params_beam_splitter_has_no_geometry():
    from app.routers.components import DEFAULT_KIND_PARAMS

    bs = DEFAULT_KIND_PARAMS["beam_splitter"]
    assert "coatingNormalBodyLocal" not in bs
    assert "transmissionAxisDegBeamLocal" not in bs
    assert "polarizing" in bs
