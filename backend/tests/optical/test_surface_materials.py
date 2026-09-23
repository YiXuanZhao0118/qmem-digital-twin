"""The surface-optics material library against published indices."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.optical.surfaces.materials import ISOTROPIC, MATERIALS, UNIAXIAL
from app.schemas_v3 import MediumV3


@pytest.mark.parametrize("name, lam, n", [
    ("N-BK7", 587.56, 1.5168),          # n_d, Schott
    ("N-BK7", 632.8, 1.5151),
    ("fused_silica", 587.56, 1.4585),   # Malitson
    ("fused_silica", 1064.0, 1.4496),
])
def test_isotropic(name, lam, n):
    assert ISOTROPIC[name].n(lam) == pytest.approx(n, abs=2e-4)


# Ghosh's calcite n_e fit sits 2.7e-4 under the handbook 1.4864 at 589 nm;
# every other index here is within 1e-4.
@pytest.mark.parametrize("name, lam, n_o, n_e, tol", [
    ("crystal_quartz", 589.3, 1.5443, 1.5534, 2e-4),
    ("calcite", 589.3, 1.6584, 1.4864, 3e-4),
])
def test_uniaxial(name, lam, n_o, n_e, tol):
    o, e = UNIAXIAL[name]
    assert o.n(lam) == pytest.approx(n_o, abs=tol)
    assert e.n(lam) == pytest.approx(n_e, abs=tol)


def test_every_material_is_known_to_the_schema():
    for name in MATERIALS:
        body = {"material": name}
        if name in UNIAXIAL:
            body["opticAxis"] = {"x": 0, "y": 0, "z": 1}
        MediumV3.model_validate(body)


def test_schema_rejects_an_unknown_material():
    with pytest.raises(ValidationError, match="unknown material"):
        MediumV3.model_validate({"material": "unobtainium"})


def test_uniaxial_material_needs_an_optic_axis_and_isotropic_refuses_one():
    with pytest.raises(ValidationError, match="opticAxis"):
        MediumV3.model_validate({"material": "crystal_quartz"})
    with pytest.raises(ValidationError, match="belongs to a uniaxial"):
        MediumV3.model_validate({"material": "N-BK7", "opticAxis": {"x": 0, "y": 0, "z": 1}})
