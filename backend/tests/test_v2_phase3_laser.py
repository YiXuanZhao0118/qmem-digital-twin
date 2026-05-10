"""V2 Phase 3: laser_source cutover — schema + translator tests.

Phase 3 moves all beam-defining laser parameters (wavelength, power,
spectrum, polarization, spatial envelope, transverse mode) from
``optical_elements.kind_params`` to
``objects.properties.opticalSources[].beam``.

The route layer keeps the V1 wire shape alive via translators that synthesise
legacy kindParams on read and apply legacy → V2 on write. These tests pin
the translator behaviour without going through HTTP.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.schemas import LaserSourceParams
from app.v2_bindings import (
    EMISSION_REFERENCE_BINDING_KIND,
    V2_TRACKED_LASER_KEYS,
    beam_from_legacy_laser_kind_params,
    default_laser_beam,
    get_optical_source,
    legacy_laser_kind_params_from_beam,
)


# ---- LaserSourceParams hard cutover ---------------------------------------


def test_laser_source_params_default_is_empty_after_cutover():
    """The model only has residual advanced fields; everything beam-defining
    moved to opticalSources[].beam."""
    inst = LaserSourceParams()
    fields = set(inst.model_dump(by_alias=True, exclude_none=True).keys())
    for forbidden in ("centerWavelengthNm", "nominalPowerMw", "spectrum",
                      "spatialModeX", "spatialModeY", "transverseMode", "polarization"):
        assert forbidden not in fields


def test_laser_source_params_silently_drops_v1_fields():
    """Old V1 client uploads still parse; the V2-tracked fields just don't
    survive — they're authoritative on opticalSources[].beam now."""
    inst = LaserSourceParams.model_validate({
        "centerWavelengthNm": 850,
        "nominalPowerMw": 25,
        "spectrum": {"centerThz": 350, "components": []},
        "spatialModeX": {"waistUm": 100, "waistZOffsetMm": 0, "mSquared": 1},
        "spatialModeY": {"waistUm": 100, "waistZOffsetMm": 0, "mSquared": 1},
        "transverseMode": {"kind": "TEM00"},
        "polarization": {"exRe": 1, "exIm": 0, "eyRe": 0, "eyIm": 0},
    })
    fields = inst.model_dump(by_alias=True, exclude_none=True)
    for forbidden in ("centerWavelengthNm", "nominalPowerMw", "spectrum",
                      "spatialModeX", "spatialModeY", "transverseMode", "polarization"):
        assert forbidden not in fields


def test_laser_source_params_keeps_residual_advanced_fields():
    inst = LaserSourceParams(rin_dbc_per_hz=-150.0)
    dumped = inst.model_dump(by_alias=True, exclude_none=True)
    assert dumped == {"rinDbcPerHz": -150.0}


# ---- legacy_laser_kind_params_from_beam (V2 → legacy) ---------------------


def test_v2_to_legacy_basic_round_trip():
    beam = default_laser_beam(wavelength_nm=780.241, power_mw=1.0)
    legacy = legacy_laser_kind_params_from_beam(beam)
    assert legacy["centerWavelengthNm"] == 780.241
    assert legacy["nominalPowerMw"] == 1.0
    assert legacy["polarization"]["exRe"] == 1.0
    assert legacy["transverseMode"] == {"kind": "TEM00"}
    assert legacy["spatialModeX"]["waistUm"] == 500.0
    assert legacy["spatialModeY"]["waistUm"] == 500.0


def test_v2_to_legacy_lorentzian_linewidth_translates_to_legacy_components():
    beam = default_laser_beam()
    beam["spectrum"]["linewidth"] = {"kind": "lorentzian", "fwhmHz": 100_000.0}
    legacy = legacy_laser_kind_params_from_beam(beam)
    component = legacy["spectrum"]["components"][0]
    assert component["lineshape"] == "lorentzian"
    assert pytest.approx(component["fwhmMhz"], rel=1e-9) == 0.1


def test_v2_to_legacy_voigt_linewidth_carries_both_widths():
    beam = default_laser_beam()
    beam["spectrum"]["linewidth"] = {
        "kind": "voigt",
        "gaussianFwhmHz": 200_000.0,
        "lorentzianFwhmHz": 50_000.0,
    }
    legacy = legacy_laser_kind_params_from_beam(beam)
    component = legacy["spectrum"]["components"][0]
    assert component["lineshape"] == "voigt"
    assert pytest.approx(component["voigtGaussianFwhmMhz"], rel=1e-9) == 0.2
    assert pytest.approx(component["voigtLorentzianFwhmMhz"], rel=1e-9) == 0.05


def test_v2_to_legacy_delta_linewidth_emits_zero_fwhm_component():
    beam = default_laser_beam()
    beam["spectrum"]["linewidth"] = {"kind": "delta"}
    legacy = legacy_laser_kind_params_from_beam(beam)
    assert legacy["spectrum"]["components"][0]["lineshape"] == "delta"


def test_v2_to_legacy_higher_order_hg_mode_translates_to_TEM_mn():
    beam = default_laser_beam()
    beam["transverseMode"] = {"family": "HG", "m": 1, "n": 0, "label": "HG10"}
    legacy = legacy_laser_kind_params_from_beam(beam)
    assert legacy["transverseMode"] == {"kind": "TEM_mn", "indicesM": 1, "indicesN": 0}


def test_v2_to_legacy_centerthz_derived_from_wavelength():
    beam = default_laser_beam(wavelength_nm=852.0)
    legacy = legacy_laser_kind_params_from_beam(beam)
    expected = 299792.458 / 852.0
    assert pytest.approx(legacy["spectrum"]["centerThz"], rel=1e-9) == expected


# ---- beam_from_legacy_laser_kind_params (legacy → V2) ---------------------


def test_legacy_to_v2_round_trip_preserves_canonical_fields():
    """Round-trip: beam → legacy → beam should preserve the editable fields."""
    original = default_laser_beam(wavelength_nm=780.241, power_mw=1.0)
    original["spectrum"]["linewidth"] = {"kind": "lorentzian", "fwhmHz": 100_000.0}
    legacy = legacy_laser_kind_params_from_beam(original)
    rebuilt = beam_from_legacy_laser_kind_params(legacy)

    assert rebuilt["powerMw"] == original["powerMw"]
    assert rebuilt["spectrum"]["centerWavelengthNm"] == original["spectrum"]["centerWavelengthNm"]
    assert rebuilt["spectrum"]["linewidth"]["kind"] == "lorentzian"
    assert pytest.approx(rebuilt["spectrum"]["linewidth"]["fwhmHz"], rel=1e-9) == 100_000.0
    assert rebuilt["polarization"]["jones"] == original["polarization"]["jones"]
    assert rebuilt["spatialEnvelope"]["transverseProfile"]["x"] == original["spatialEnvelope"]["transverseProfile"]["x"]
    assert rebuilt["spatialEnvelope"]["propagation"]["x"]["mSquared"] == 1.0


def test_legacy_to_v2_partial_kind_params_uses_defaults():
    """If only nominalPowerMw is in the patch, V2 beam picks defaults for
    everything else."""
    rebuilt = beam_from_legacy_laser_kind_params({"nominalPowerMw": 5.0})
    assert rebuilt["powerMw"] == 5.0
    assert rebuilt["spectrum"]["centerWavelengthNm"] == 780.241  # default
    assert rebuilt["polarization"]["jones"]["exRe"] == 1.0


def test_legacy_to_v2_TEM_mn_translates_to_HG_family():
    legacy = {"transverseMode": {"kind": "TEM_mn", "indicesM": 2, "indicesN": 1}}
    rebuilt = beam_from_legacy_laser_kind_params(legacy)
    tm = rebuilt["transverseMode"]
    assert tm["family"] == "HG"
    assert tm["m"] == 2
    assert tm["n"] == 1


# ---- get_optical_source helper -------------------------------------------


def test_get_optical_source_returns_first_entry():
    src = {"id": "uuid", "bindingId": "uuid_b", "enabled": True, "beam": default_laser_beam()}
    obj = SimpleNamespace(properties={"opticalSources": [src]})
    assert get_optical_source(obj) is src


def test_get_optical_source_returns_none_when_empty():
    assert get_optical_source(SimpleNamespace(properties={})) is None
    assert get_optical_source(None) is None


def test_get_optical_source_accepts_dict_object_shape():
    beam = default_laser_beam()
    src = {"id": "uuid", "bindingId": "b", "enabled": True, "beam": beam}
    found = get_optical_source({"properties": {"opticalSources": [src]}})
    assert found is src


# ---- default_laser_beam shape compatibility ------------------------------


def test_default_laser_beam_validates_against_v2_pydantic():
    """The Phase 1 V2BeamSource schema must accept the default beam shape."""
    from app.schemas import V2BeamSource

    inst = V2BeamSource.model_validate(default_laser_beam())
    assert inst.power_mw == 1.0
    assert inst.spectrum.center_wavelength_nm == 780.241
    assert inst.spatial_envelope.transverse_profile.x.waist_radius_um == 500.0


# ---- V2_TRACKED_LASER_KEYS contract -------------------------------------


def test_v2_tracked_laser_keys_match_translator_output_keys():
    """The set of keys we strip on PUT must equal the set of keys the
    forward translator produces, otherwise some user edit could end up
    surviving in DB kindParams instead of being moved to opticalSources."""
    legacy = legacy_laser_kind_params_from_beam(default_laser_beam())
    translator_output_keys = set(legacy.keys())
    assert set(V2_TRACKED_LASER_KEYS) == translator_output_keys


# ---- Constant labels stay stable -----------------------------------------


def test_emission_reference_binding_kind_stays_stable():
    """The migration backfill writes EMISSION_REFERENCE_BINDING_KIND on the
    binding row; the bootstrap default uses the same constant. Pin it so a
    rename can't silently desync the two paths."""
    assert EMISSION_REFERENCE_BINDING_KIND == "emissionReference"
