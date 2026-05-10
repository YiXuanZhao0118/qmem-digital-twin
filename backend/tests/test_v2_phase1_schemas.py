"""V2 Phase 1: round-trip tests for the new Pydantic schemas.

These run without a DB — they only check that the schemas accept
canonical V2 shapes, reject obviously wrong shapes, and round-trip
through ``model_dump(by_alias=True) → model_validate``.

Per-kind schema tightening lands in Phase 2+; this test file pins the
common building blocks (anchorBindings, opticalSources, ports,
beamState, simulationRun, revision).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from app.schemas import (
    V2AnchorBinding,
    V2BeamSource,
    V2BeamState,
    V2GaussianAxis,
    V2GaussianProfile,
    V2Jones,
    V2Linewidth,
    V2M2GaussianAxis,
    V2M2GaussianPropagation,
    V2OpticalPort,
    V2OpticalSource,
    V2Polarization,
    V2RevisionCreate,
    V2RevisionOut,
    V2SimulationRunCreate,
    V2SimulationRunOut,
    V2SpatialAxisState,
    V2SpatialEnvelope,
    V2Spectrum,
    V2TransverseMode,
)
from app.uuid7 import uuid7, uuid7_str


# ---- helpers ---------------------------------------------------------------


def _example_beam_source() -> dict:
    """Canonical V2 beam source payload (camelCase, as it would arrive
    from the frontend)."""
    return {
        "powerMw": 20.0,
        "spectrum": {
            "centerWavelengthNm": 780.241,
            "wavelengthReference": "vacuum",
            "linewidth": {"kind": "lorentzian", "fwhmHz": 100_000.0},
        },
        "polarization": {
            "basis": "beamLocalXY",
            "normalization": "unit_jones",
            "jones": {"exRe": 1.0, "exIm": 0.0, "eyRe": 0.0, "eyIm": 0.0},
        },
        "spatialEnvelope": {
            "transverseProfile": {
                "kind": "elliptical_gaussian",
                "x": {"waistRadiusUm": 500.0},
                "y": {"waistRadiusUm": 200.0},
                "hardAperture": None,
            },
            "propagation": {
                "model": "m2_gaussian",
                "x": {"waistZOffsetMm": 0.0, "mSquared": 1.2},
                "y": {"waistZOffsetMm": 0.0, "mSquared": 1.5},
            },
        },
        "transverseMode": {"family": "HG", "m": 0, "n": 0, "label": "TEM00"},
    }


def _example_beam_state() -> dict:
    return {
        "powerMw": 19.4,
        "spectrum": {
            "centerWavelengthNm": 780.241,
            "wavelengthReference": "vacuum",
            "linewidth": {"kind": "lorentzian", "fwhmHz": 100_000.0},
        },
        "polarization": {
            "basis": "beamLocalXY",
            "normalization": "unit_jones",
            "jones": {"exRe": 1.0, "exIm": 0.0, "eyRe": 0.0, "eyIm": 0.0},
        },
        "spatialX": {"qReal": 300.0, "qImag": 1006.2, "wAtZUm": 510.0},
        "spatialY": {"qReal": 300.0, "qImag": 1006.2, "wAtZUm": 510.0},
        "transverseMode": {"family": "HG", "m": 0, "n": 0, "label": "TEM00"},
    }


def _roundtrip(model_cls, payload: dict) -> dict:
    """Validate, dump back to camelCase JSON, re-validate. Should be a
    fixed point under the V2 shape we expect."""
    instance = model_cls.model_validate(payload)
    redumped = instance.model_dump(mode="json", by_alias=True)
    re_instance = model_cls.model_validate(redumped)
    assert re_instance.model_dump() == instance.model_dump()
    return redumped


# ---- uuid7 helper ----------------------------------------------------------


def test_uuid7_returns_uuid_object():
    u = uuid7()
    assert isinstance(u, uuid.UUID)
    # version nibble is 7
    assert (u.int >> 76) & 0xF == 7
    # variant is 10 (RFC 4122 / 9562)
    assert (u.int >> 62) & 0b11 == 0b10


def test_uuid7_str_is_canonical_36_chars():
    s = uuid7_str()
    assert len(s) == 36
    assert s.count("-") == 4


def test_uuid7_is_time_ordered():
    a = uuid7()
    b = uuid7()
    # The first 48 bits encode unix-ms; later UUID should sort >= earlier
    assert (b.int >> 80) >= (a.int >> 80)


# ---- anchor bindings -------------------------------------------------------


def test_anchor_binding_minimal_optical_surface():
    payload = {
        "id": uuid7_str(),
        "name": "Mirror reflective surface",
        "anchorId": uuid7_str(),
        "kind": "opticalSurface",
        "frame": "anchorLocalXY",
        "payload": {
            "normalBodyLocal": [1, 0, 0],
            "aperture": {"shape": "circle", "rMm": 12.7},
        },
    }
    redumped = _roundtrip(V2AnchorBinding, payload)
    assert redumped["kind"] == "opticalSurface"
    assert redumped["payload"]["aperture"]["rMm"] == 12.7


def test_anchor_binding_emission_reference_no_aperture_required():
    payload = {
        "id": uuid7_str(),
        "anchorId": uuid7_str(),
        "kind": "emissionReference",
        "payload": {"normalBodyLocal": [1, 0, 0]},
    }
    instance = V2AnchorBinding.model_validate(payload)
    # default frame
    assert instance.frame == "anchorLocalXY"


def test_anchor_binding_rejects_unknown_kind():
    with pytest.raises(ValidationError):
        V2AnchorBinding.model_validate(
            {
                "id": uuid7_str(),
                "anchorId": uuid7_str(),
                "kind": "componentType",  # not a binding kind
                "payload": {},
            }
        )


# ---- optical source -------------------------------------------------------


def test_optical_source_full_roundtrip():
    payload = {
        "id": uuid7_str(),
        "bindingId": uuid7_str(),
        "enabled": True,
        "beam": _example_beam_source(),
    }
    redumped = _roundtrip(V2OpticalSource, payload)
    assert redumped["beam"]["spectrum"]["centerWavelengthNm"] == 780.241
    assert redumped["beam"]["spatialEnvelope"]["propagation"]["model"] == "m2_gaussian"


def test_beam_source_linewidth_kind_delta_no_fwhm():
    src = _example_beam_source()
    src["spectrum"]["linewidth"] = {"kind": "delta"}
    instance = V2BeamSource.model_validate(src)
    assert instance.spectrum.linewidth.kind == "delta"
    assert instance.spectrum.linewidth.fwhm_hz is None


def test_beam_source_rejects_missing_polarization():
    src = _example_beam_source()
    del src["polarization"]
    with pytest.raises(ValidationError):
        V2BeamSource.model_validate(src)


# ---- optical port ---------------------------------------------------------


def test_optical_port_face_selectable_pbs():
    payload = {
        "id": uuid7_str(),
        "name": "Reflected output",
        "role": "output",
        "face": "face_3",
        "branchKind": "reflected",
        "bindingId": uuid7_str(),
    }
    instance = V2OpticalPort.model_validate(payload)
    assert instance.role == "output"
    assert instance.face == "face_3"
    assert instance.side is None


def test_optical_port_rejects_unknown_role():
    with pytest.raises(ValidationError):
        V2OpticalPort.model_validate(
            {
                "id": uuid7_str(),
                "role": "in",  # short form not allowed; must be input/output/bidirectional
                "bindingId": uuid7_str(),
            }
        )


# ---- beam state -----------------------------------------------------------


def test_beam_state_roundtrip():
    redumped = _roundtrip(V2BeamState, _example_beam_state())
    assert redumped["spatialX"]["qReal"] == 300.0


# ---- simulation run -------------------------------------------------------


def test_simulation_run_create_minimal():
    instance = V2SimulationRunCreate.model_validate({})
    assert instance.status == "completed"
    assert instance.solver_version == "optical-solver-v1"
    assert instance.settings == {}
    assert instance.warnings == []


def test_simulation_run_out_full():
    payload = {
        "id": str(uuid7()),
        "revisionId": str(uuid7()),
        "solverVersion": "optical-solver-v1",
        "status": "completed",
        "sceneHash": "abc123",
        "settings": {"maxBranches": 100, "minPowerMw": 0.001},
        "warnings": ["beam exits scene at object_42"],
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "finishedAt": datetime.now(timezone.utc).isoformat(),
    }
    instance = V2SimulationRunOut.model_validate(payload)
    assert instance.scene_hash == "abc123"
    assert len(instance.warnings) == 1


def test_simulation_run_rejects_unknown_status():
    with pytest.raises(ValidationError):
        V2SimulationRunCreate.model_validate({"status": "ok"})


# ---- revision -------------------------------------------------------------


def test_revision_create_with_scene_hash():
    payload = {
        "label": "Before AOM alignment",
        "description": "checkpoint pre-Bragg",
        "snapshot": {"objects": [], "opticalElements": [], "opticalLinks": []},
        "sceneHash": "deadbeef",
    }
    instance = V2RevisionCreate.model_validate(payload)
    assert instance.scene_hash == "deadbeef"
    assert "objects" in instance.snapshot


def test_revision_out_carries_id_and_created_at():
    payload = {
        "id": str(uuid7()),
        "label": "rev",
        "snapshot": {},
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    instance = V2RevisionOut.model_validate(payload)
    assert instance.scene_hash is None  # nullable for legacy rows


# ---- aperture variants ---------------------------------------------------


def test_aperture_circle_in_binding_payload():
    instance = V2AnchorBinding.model_validate(
        {
            "id": uuid7_str(),
            "anchorId": uuid7_str(),
            "kind": "opticalPortSurface",
            "payload": {"aperture": {"shape": "circle", "rMm": 5.0}},
        }
    )
    assert instance.payload["aperture"]["shape"] == "circle"


def test_aperture_rectangle_uses_half_lengths_convention():
    """V2 rectangle xMm/yMm are half-width/half-height. We don't enforce
    arithmetic here, just shape acceptance."""
    payload = {
        "id": uuid7_str(),
        "anchorId": uuid7_str(),
        "kind": "detectorArea",
        "payload": {"aperture": {"shape": "rectangle", "xMm": 5.0, "yMm": 3.0}},
    }
    V2AnchorBinding.model_validate(payload)


# ---- snake_case ↔ camelCase round-trip via populate_by_name --------------


def test_camel_model_accepts_snake_case_input_for_v2():
    """Pydantic's populate_by_name lets backend code construct V2 schemas
    with snake_case kwargs even though the JSON wire format is camelCase."""
    src = V2BeamSource(
        power_mw=10.0,
        spectrum=V2Spectrum(
            center_wavelength_nm=780.0,
            linewidth=V2Linewidth(kind="delta"),
        ),
        polarization=V2Polarization(
            jones=V2Jones(ex_re=1, ex_im=0, ey_re=0, ey_im=0),
        ),
        spatial_envelope=V2SpatialEnvelope(
            transverse_profile=V2GaussianProfile(
                x=V2GaussianAxis(waist_radius_um=500),
                y=V2GaussianAxis(waist_radius_um=500),
            ),
            propagation=V2M2GaussianPropagation(
                x=V2M2GaussianAxis(waist_z_offset_mm=0.0, m_squared=1.0),
                y=V2M2GaussianAxis(waist_z_offset_mm=0.0, m_squared=1.0),
            ),
        ),
    )
    dumped = src.model_dump(mode="json", by_alias=True)
    assert dumped["powerMw"] == 10.0
    assert dumped["spectrum"]["centerWavelengthNm"] == 780.0
    assert dumped["spatialEnvelope"]["propagation"]["x"]["mSquared"] == 1.0
