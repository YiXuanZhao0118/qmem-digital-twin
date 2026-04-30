import uuid

import pytest
from pydantic import ValidationError

from app.schemas import (
    DEFAULT_PORTS,
    EMITTER_KINDS,
    KIND_PARAMS_MODELS,
    OpticalElementBase,
    OpticalElementCreate,
    OpticalLinkCreate,
    SpectrumComponent,
    TransverseMode,
)


# --- per-kind defaults / dispatch -------------------------------------------


def test_every_kind_has_param_model_and_default_ports():
    # Symmetry check: every element_kind in DEFAULT_PORTS has a typed model.
    assert set(KIND_PARAMS_MODELS.keys()) == set(DEFAULT_PORTS.keys())


def test_emitter_kinds_set_contents():
    assert EMITTER_KINDS == {"laser_source", "tapered_amplifier"}


def test_emitter_default_ports_have_no_inputs():
    for kind in EMITTER_KINDS:
        defaults = DEFAULT_PORTS[kind]
        # Source has no inputs; TA seed input is allowed.
        if kind == "laser_source":
            assert defaults["input"] == []
        assert len(defaults["output"]) == 1


def test_aom_has_three_output_ports():
    aom_defaults = DEFAULT_PORTS["aom"]
    port_ids = [p["portId"] for p in aom_defaults["output"]]
    assert port_ids == ["0th", "+1st", "-1st"]


def test_sink_kinds_have_no_outputs():
    for kind in ("detector", "camera", "spectrometer", "wavemeter", "beam_dump"):
        assert DEFAULT_PORTS[kind]["output"] == []


# --- TransverseMode --------------------------------------------------------


def test_transverse_mode_tem_mn_requires_indices():
    with pytest.raises(ValidationError):
        TransverseMode(kind="TEM_mn")
    TransverseMode(kind="TEM_mn", indices_m=0, indices_n=0)  # ok


def test_transverse_mode_lg_pl_requires_indices():
    with pytest.raises(ValidationError):
        TransverseMode(kind="LG_pl", indices_m=0, indices_n=0)
    TransverseMode(kind="LG_pl", indices_p=1, indices_l=2)  # ok


# --- SpectrumComponent -----------------------------------------------------


def test_gaussian_lineshape_requires_fwhm():
    with pytest.raises(ValidationError):
        SpectrumComponent(lineshape="gaussian")
    SpectrumComponent(lineshape="gaussian", fwhm_mhz=1.0)  # ok


def test_voigt_requires_both_components():
    with pytest.raises(ValidationError):
        SpectrumComponent(lineshape="voigt")
    with pytest.raises(ValidationError):
        SpectrumComponent(lineshape="voigt", voigt_gaussian_fwhm_mhz=0.5)
    SpectrumComponent(
        lineshape="voigt",
        voigt_gaussian_fwhm_mhz=0.5,
        voigt_lorentzian_fwhm_mhz=0.3,
    )  # ok


def test_delta_must_not_have_fwhm():
    SpectrumComponent(lineshape="delta")  # ok
    with pytest.raises(ValidationError):
        SpectrumComponent(lineshape="delta", fwhm_mhz=1.0)


# --- OpticalElement validation -----------------------------------------------


def laser_payload(**overrides):
    base = {
        "componentId": str(uuid.uuid4()),
        "elementKind": "laser_source",
        "kindParams": {
            "centerWavelengthNm": 780.241,
            "spectrum": {
                "centerThz": 384.230,
                "components": [
                    {"kind": "main", "lineshape": "lorentzian", "fwhmMhz": 0.1, "amplitude": 1.0},
                ],
            },
            "spatialModeX": {"waistUm": 250.0, "waistZOffsetMm": 0.0, "mSquared": 1.05},
            "spatialModeY": {"waistUm": 80.0, "waistZOffsetMm": 1.2, "mSquared": 1.30},
            "transverseMode": {"kind": "TEM00"},
            "polarization": {"exRe": 1.0, "exIm": 0.0, "eyRe": 0.0, "eyIm": 0.0},
            "nominalPowerMw": 50.0,
        },
    }
    base.update(overrides)
    return base


def test_laser_source_validates_full_payload():
    laser = OpticalElementCreate.model_validate(laser_payload())
    assert laser.element_kind == "laser_source"
    assert len(laser.input_ports) == 0
    assert len(laser.output_ports) == 1
    assert laser.output_ports[0].port_id == "out"


def test_default_ports_filled_when_omitted():
    mirror = OpticalElementCreate.model_validate({
        "componentId": str(uuid.uuid4()),
        "elementKind": "mirror",
        "kindParams": {"reflectivity": 0.99, "normalLocal": [1, 0, 0]},
    })
    assert [p.port_id for p in mirror.input_ports] == ["in"]
    assert [p.port_id for p in mirror.output_ports] == ["out"]


def test_custom_ports_preserved():
    aom = OpticalElementCreate.model_validate({
        "componentId": str(uuid.uuid4()),
        "elementKind": "aom",
        "kindParams": {
            "centerFreqMhz": 80.0,
            "baseEfficiency": 0.85,
            "deflectionPerMhzUrad": 200.0,
            "acousticVelocityMPerS": 4200.0,
            "modulationBandwidthMhz": 20.0,
        },
        "inputPorts": [{"portId": "in", "role": "input", "label": "In"}],
        "outputPorts": [
            {"portId": "0th", "role": "output", "label": "0th"},
            {"portId": "+1st", "role": "output", "label": "+1st"},
        ],
    })
    assert [p.port_id for p in aom.output_ports] == ["0th", "+1st"]


def test_aom_default_ports_have_three_output_orders():
    aom = OpticalElementCreate.model_validate({
        "componentId": str(uuid.uuid4()),
        "elementKind": "aom",
        "kindParams": {
            "centerFreqMhz": 80.0,
            "baseEfficiency": 0.85,
            "deflectionPerMhzUrad": 200.0,
            "acousticVelocityMPerS": 4200.0,
            "modulationBandwidthMhz": 20.0,
        },
    })
    assert [p.port_id for p in aom.output_ports] == ["0th", "+1st", "-1st"]


def test_unknown_element_kind_rejected():
    with pytest.raises(ValidationError):
        OpticalElementCreate.model_validate({
            "componentId": str(uuid.uuid4()),
            "elementKind": "not_a_real_kind",
            "kindParams": {},
        })


def test_invalid_kind_params_rejected():
    # MirrorParams.reflectivity must be in [0, 1]
    with pytest.raises(ValidationError):
        OpticalElementCreate.model_validate({
            "componentId": str(uuid.uuid4()),
            "elementKind": "mirror",
            "kindParams": {"reflectivity": 1.5, "normalLocal": [1, 0, 0]},
        })


def test_wavelength_range_invariants():
    # high <= low rejected
    with pytest.raises(ValidationError):
        OpticalElementCreate.model_validate(
            laser_payload(wavelengthRangeNm=[800.0, 700.0]),
        )
    # low <= 0 rejected
    with pytest.raises(ValidationError):
        OpticalElementCreate.model_validate(
            laser_payload(wavelengthRangeNm=[0.0, 1100.0]),
        )


def test_lens_cylindrical_axis_constrained():
    OpticalElementCreate.model_validate({
        "componentId": str(uuid.uuid4()),
        "elementKind": "lens_cylindrical",
        "kindParams": {"focalMm": 100.0, "cylindricalAxis": "x", "transmission": 0.99},
    })
    with pytest.raises(ValidationError):
        OpticalElementCreate.model_validate({
            "componentId": str(uuid.uuid4()),
            "elementKind": "lens_cylindrical",
            "kindParams": {"focalMm": 100.0, "cylindricalAxis": "z", "transmission": 0.99},
        })


def test_nonlinear_crystal_process_required():
    with pytest.raises(ValidationError):
        OpticalElementCreate.model_validate({
            "componentId": str(uuid.uuid4()),
            "elementKind": "nonlinear_crystal",
            "kindParams": {"chi2PmPerV": 4.5, "lengthMm": 10.0},  # missing process
        })
    OpticalElementCreate.model_validate({
        "componentId": str(uuid.uuid4()),
        "elementKind": "nonlinear_crystal",
        "kindParams": {"process": "SHG", "chi2PmPerV": 4.5, "lengthMm": 10.0},
    })


# --- OpticalLink ------------------------------------------------------------


def test_optical_link_basic_validation():
    link = OpticalLinkCreate.model_validate({
        "fromComponentId": str(uuid.uuid4()),
        "fromPort": "out",
        "toComponentId": str(uuid.uuid4()),
        "toPort": "in",
        "freeSpaceMm": 150.0,
    })
    assert link.free_space_mm == 150.0


def test_optical_link_negative_distance_rejected():
    with pytest.raises(ValidationError):
        OpticalLinkCreate.model_validate({
            "fromComponentId": str(uuid.uuid4()),
            "fromPort": "out",
            "toComponentId": str(uuid.uuid4()),
            "toPort": "in",
            "freeSpaceMm": -1.0,
        })


# --- TaperedAmplifier specifics ---------------------------------------------


def test_tapered_amplifier_full():
    ta = OpticalElementCreate.model_validate({
        "componentId": str(uuid.uuid4()),
        "elementKind": "tapered_amplifier",
        "kindParams": {
            "smallSignalGainDb": 30.0,
            "saturationPowerMw": 500.0,
            "maxInputPowerMw": 30.0,
            "ase": {"powerMw": 5.0, "bandwidthNm": 1.0, "centerOffsetNm": 0.0},
            "outputSpatialModeX": {"waistUm": 500.0, "waistZOffsetMm": 0.0, "mSquared": 1.5},
            "outputSpatialModeY": {"waistUm": 50.0, "waistZOffsetMm": 0.0, "mSquared": 8.0},
            "outputTransverseMode": {"kind": "TEM00"},
        },
    })
    assert ta.element_kind == "tapered_amplifier"
    assert [p.port_id for p in ta.input_ports] == ["seed"]
    assert [p.port_id for p in ta.output_ports] == ["out"]
