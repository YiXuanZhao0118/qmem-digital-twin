"""Pose decomposition at and near the gimbal pole (ry = ±90°).

``align.frames.scene_object_euler_from_quaternion`` (the TS
``sceneObjectEulerFromQuaternion`` port) used ``ry = asin(r20)`` with a fixed
``|cos ry| > 1e-8`` cut. asin is flat at ±1, so r20 rounded 1 ulp short of 1
read as ry = 90° − 1.5e-8 rad, cleared the cut, and rx / rz came from atan2 of
entries that are rounding noise there: the orientation could be wrong by
1e-4 rad and more. ``assembly_solver.euler_from_matrix`` had the same
asin + fixed-cut construction (1e-7). Both are now conditioned (see
``docs/introduce/anchors.md``, Pose quantization).

Pinned here, independently of the TypeScript (``euler.json`` pins the parity):
the unquantized decomposition recomposes to the input to rounding; the live
MIRROR2 align lands on its beam; the relation solver's decomposition
recomposes to the storage grid.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.assembly_solver import euler_from_matrix, matrix_from_euler
from app.optical.align.frames import (
    scene_object_euler_rad_from_quaternion,
    scene_object_to_quaternion,
)
from app.optical.align.point_dir import compute_point_dir_align_pose
from app.optical.align.ts_compat import (
    DEG2RAD,
    V,
    m4_rotation_elements,
    q_from_axis_angle,
    q_from_unit_vectors,
    q_multiply,
    q_normalize,
    v3_normalize,
)
from app.optical.pose import V3Pose, _rotation_of

POLE_OFFSETS_DEG = [0.0, 1e-9, 1e-7, 1e-5, 1e-3]
SPLITS = [(0.0, 0.0), (12.5, -30.25), (-135.0, 0.0), (179.9, 45.0), (-0.4634, 88.123456789)]


def _matrix_of_q(q) -> np.ndarray:
    te = m4_rotation_elements(q_normalize(q))
    return np.array([[te[0], te[4], te[8]], [te[1], te[5], te[9]], [te[2], te[6], te[10]]])


def _matrix_rad(a: float, b: float, g: float) -> np.ndarray:
    """The documented SceneObject matrix (``pose._rotation_of``) in radians."""
    ca, sa, cb, sb, cg, sg = math.cos(a), math.sin(a), math.cos(b), math.sin(b), math.cos(g), math.sin(g)
    return np.array([
        [cb * cg, sa * sb * cg + ca * sg, -ca * sb * cg + sa * sg],
        [-cb * sg, -sa * sb * sg + ca * cg, ca * sb * sg + sa * cg],
        [sb, -sa * cb, ca * cb],
    ])


def _old_decomposition(q) -> tuple[float, float, float]:
    """The pre-2026-09-22 code, verbatim, for the before/after comparison."""
    te = m4_rotation_elements(q_normalize(q))
    r00, r10, r20, r01, r02, r21, r22 = te[0], te[1], te[2], te[4], te[8], te[6], te[10]
    beta = math.asin(max(-1.0, min(1.0, r20)))
    if abs(math.cos(beta)) > 1e-8:
        return math.atan2(-r21, r22), beta, math.atan2(-r10, r00)
    return (math.atan2(r01, -r02) if r20 > 0 else math.atan2(-r01, r02)), beta, 0.0


def _pole_quaternions():
    for sign in (1.0, -1.0):
        for off in POLE_OFFSETS_DEG:
            for rx, rz in SPLITS:
                pose = V3Pose(rx_deg=rx, ry_deg=sign * (90.0 - off), rz_deg=rz)
                yield pytest.param(scene_object_to_quaternion(pose), id=f"ry={sign * (90 - off)!r},rx={rx},rz={rz}")


@pytest.mark.parametrize("q", list(_pole_quaternions()))
def test_decomposition_recomposes_to_rounding_at_the_pole(q) -> None:
    got = _matrix_rad(*scene_object_euler_rad_from_quaternion(q))
    assert np.abs(got - _matrix_of_q(q)).max() <= 2e-15


def _mirror2_quaternion(flip: float, roll_deg: float):
    """The rotation ``compute_point_dir_align_pose`` builds for MIRROR2 (below)
    before decomposing it: +y onto the beam, then the roll about it."""
    beam = v3_normalize(V(flip * SX, flip * CY, 0.0))
    q = q_from_unit_vectors(V(0.0, 1.0, 0.0), beam)
    return q_multiply(q_from_axis_angle(beam, roll_deg * DEG2RAD), q)


def test_the_old_decomposition_did_not() -> None:
    """The before half of the comparison. On the synthetic pole set the old
    code misses the 1e-9 rad objective, while the new one recomposes the
    rotation the align solver really builds for MIRROR2 to rounding.

    How far the old code misses on the MIRROR2 rotation itself depends on
    how the platform's ``asin`` rounds a value one ulp from 1: on Windows it
    lands on the noisy branch (~1e-4 rad, the error the endpoint returned),
    on CI's Linux libm on the exact one. So that magnitude is not asserted;
    the synthetic set (many near-pole cases) misses on every platform."""
    synthetic = max(
        np.abs(_matrix_rad(*_old_decomposition(p.values[0])) - _matrix_of_q(p.values[0])).max()
        for p in _pole_quaternions()
    )
    assert synthetic > 1e-9
    q = _mirror2_quaternion(1.0, 90.0)
    assert np.abs(_matrix_rad(*scene_object_euler_rad_from_quaternion(q)) - _matrix_of_q(q)).max() <= 2e-15


def test_away_from_the_pole_nothing_changes() -> None:
    """Off the pole the old and new angles agree to the old code's own
    precision (its rx came from entries of size cos ry, so it was the less
    accurate of the two), and the new one recomposes to rounding."""
    rng = np.random.default_rng(7)
    for _ in range(500):
        pose = V3Pose(rx_deg=rng.uniform(-180, 180), ry_deg=rng.uniform(-89, 89), rz_deg=rng.uniform(-180, 180))
        q = scene_object_to_quaternion(pose)
        new = scene_object_euler_rad_from_quaternion(q)
        old = _old_decomposition(q)
        assert np.abs(np.array(new) - np.array(old)).max() <= 1e-12
        assert np.abs(_matrix_rad(*new) - _matrix_of_q(q)).max() <= 2e-15


# The live MIRROR2 (2026-09-22): alignSpec point 0 / direction +y, rolled 90
# deg onto a beam 8.1 mrad off the y axis. Before the fix the returned pose had
# ry 8.5e-7 deg short of -90 and put the align direction 2.75e-4 rad off the beam.
MIRROR2 = V3Pose(x_mm=-492.654465, y_mm=-537.195519, z_mm=910.799999, rx_deg=-135.0, ry_deg=-90.0, rz_deg=0.0)
BEAM_REF = V(-387.3906559182327, -537.2652968730044, 908.83165)
SX, CY = 0.008087770214956286, 0.999967293451616


@pytest.mark.parametrize("flip", [1.0, -1.0])
@pytest.mark.parametrize("roll", [90.0, -90.0])
@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("tilt_deg", [0.0, 1e-9, 1e-7, 1e-5, 1e-3])
def test_mirror2_align_direction_lands_on_the_beam(flip, roll, reverse, tilt_deg) -> None:
    t = math.radians(tilt_deg)
    beam = V(flip * SX * math.cos(t), flip * CY * math.cos(t), math.sin(t))
    pose = compute_point_dir_align_pose(
        point_cad_mm=V(0, 0, 0), dir_cad_mm=V(0, 1, 0), scene_object=MIRROR2,
        beam_dir=beam, beam_ref=BEAM_REF, reverse=reverse, roll_deg=roll,
    )
    d = _rotation_of(V3Pose(rx_deg=pose.rx_deg, ry_deg=pose.ry_deg, rz_deg=pose.rz_deg)).apply([0.0, 1.0, 0.0])
    want = -np.array(beam) if reverse else np.array(beam)
    # Measured through the cross product (acos loses half the digits at 0).
    assert np.linalg.norm(np.cross(d, want)) < 1e-9
    assert float(d @ want) > 0
    if tilt_deg == 0.0:
        assert abs(pose.ry_deg) == 90.0  # exactly on the pole, not 8.5e-7 deg short


@pytest.mark.parametrize("sign", [1.0, -1.0])
@pytest.mark.parametrize("off", POLE_OFFSETS_DEG)
@pytest.mark.parametrize("ry, rz", [(0.0, 0.0), (30.0, -12.5), (-150.0, 77.7)])
def test_relation_solver_decomposition_recomposes_at_the_pole(sign, off, ry, rz) -> None:
    """``assembly_solver.euler_from_matrix`` (R = Rz·Rx·Ry, pole at rx = ±90)
    recomposes to the 1e-9 deg storage grid it quantizes to."""
    m = matrix_from_euler(sign * (90.0 - off), ry, rz)
    back = matrix_from_euler(*euler_from_matrix(m))
    assert np.abs(np.array(back) - np.array(m)).max() <= 5e-11
