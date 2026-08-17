"""Pose quantization contract — see app/pose_quantize.py.

The regression this guards: a quaternion/matrix round-trip used to persist
``ry_deg = -8.995967132789893e-15`` for a pose that is exactly axis-aligned.
"""

import math

import pytest

from app.assembly_solver import euler_from_matrix, matrix_from_euler
from app.pose_quantize import quantize_deg, quantize_mm
from app.schemas import ComponentBindingUpdate, SceneObjectUpdate


def test_double_dust_snaps_to_exact_zero():
    assert quantize_deg(-8.995967132789893e-15) == 0.0
    assert quantize_mm(2.3e-13) == 0.0
    # ...and the zero is a positive zero, so JSON never carries "-0.0".
    assert not math.copysign(1.0, quantize_deg(-1e-15)) < 0


def test_round_trip_dust_on_a_real_value_snaps_back():
    assert quantize_deg(45.000000000000007) == 45.0
    assert quantize_mm(12.000000000000002) == 12.0


def test_grid_is_finer_than_the_objectives_budget():
    # O-2 is 0.1 µrad = 5.73e-6 deg; O-1 is 1 µm = 1e-3 mm. A value one
    # decade below either budget must survive quantization intact.
    assert quantize_deg(5.7e-7) == 5.7e-7
    assert quantize_mm(1e-4) == 1e-4


def test_non_finite_passes_through():
    assert math.isnan(quantize_deg(float("nan")))
    assert quantize_mm(float("inf")) == float("inf")


@pytest.mark.parametrize("rx,ry,rz", [(0, 0, 0), (0, 90, 0), (-45, 60, -30)])
def test_euler_from_matrix_is_quantized(rx, ry, rz):
    decoded = euler_from_matrix(matrix_from_euler(rx, ry, rz))
    assert decoded == pytest.approx((rx, ry, rz), abs=1e-9)
    # Exactness, not just closeness: no e-15 residue survives.
    for value in decoded:
        assert value == round(value, 9)


def test_scene_object_update_schema_quantizes():
    patch = SceneObjectUpdate.model_validate(
        {"ryDeg": -8.995967132789893e-15, "xMm": 12.000000000000002}
    )
    assert patch.ry_deg == 0.0
    assert patch.x_mm == 12.0


def test_component_binding_update_schema_quantizes():
    patch = ComponentBindingUpdate.model_validate({"localRyDeg": -8.995967132789893e-15})
    assert patch.local_ry_deg == 0.0
    # None stays None — "field not present" must not become 0.
    assert ComponentBindingUpdate.model_validate({}).local_ry_deg is None
