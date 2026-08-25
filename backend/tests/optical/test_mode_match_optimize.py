"""Mode-matching optimizer (Phase 3): recovers a known optimum on a synthetic
one-lens section, honours the eta target, and reports length-lock infeasibility.
"""

import math

import pytest

from app.optical import anchor_ops  # noqa: F401
from app.optical.anchor_tracer import (
    V3Anchor, V3AnchorBindingSlot, V3AnchorScene, V3AssetAnchorSnapshot,
)
from app.optical.beam_ray import BeamRay, QMatrix, Vec3
from app.optical.mode_match_model import ModeMatchProblem, MovableLens
from app.optical.mode_match_optimize import DOFSpec, optimize
from app.optical.pose import V3Transform

WL = 852.0
F = 40.0
Z_START = 50.0
Z_CMP = -50.0
TRUE_D = 15.0  # the lens offset the target q was generated at


def _q_free(q, d):
    return q + d


def _q_lens(q, f):
    return 1.0 / (1.0 / q - 1.0 / f)


def _reverse_q3(q0, d_axial):
    q1 = _q_free(q0, Z_START - d_axial)
    q2 = _q_lens(q1, F)
    return _q_free(q2, d_axial - Z_CMP)


def _problem():
    anchor = V3Anchor(
        id="intercept_in", position_body=Vec3(0, 0, 0),
        axis_x_body=Vec3(0, 0, 1), axis_y_body=Vec3(0, 1, 0),
        axis_z_body=Vec3(1, 0, 0), aperture_mm=25.4,
    )
    snap = V3AssetAnchorSnapshot(
        catalog_id="synthetic_lens", kind="lens", anchors=[anchor],
        default_params={"focalLengthMm": F, "transmittance": 1.0},
    )
    slot = V3AnchorBindingSlot(
        scene_object_id="lens0", binding_id="b0", asset=snap,
        effective_transform=V3Transform(origin=Vec3(0, 0, 0)),
    )
    zr = math.pi * 0.3 * 0.3 / (WL * 1e-6)
    q0 = complex(0.0, zr)
    reverse = BeamRay(
        origin=Vec3(0, 0, Z_START), direction=Vec3(0, 0, -1),
        qx=q0, qy=q0, wavelength_nm=WL, power_mw=1.0,
        jones=(complex(1, 0), complex(0, 0)),
    )
    # Target is the reverse q with the lens shifted by TRUE_D ⇒ optimum at +TRUE_D.
    q3 = _reverse_q3(q0, TRUE_D)
    seed_q = QMatrix(q3, q3)
    lens = MovableLens(
        scene_object_id="lens0", name="lens0", kind="lens",
        base_transform=slot.effective_transform, base_focal_mm=F,
    )
    return ModeMatchProblem(
        scene=V3AnchorScene(slots=[slot]), lenses=[lens], reverse_ray=reverse,
        seed_q=seed_q, compare_point=Vec3(0, 0, Z_CMP), axis=Vec3(0, 0, 1),
        e2=Vec3(1, 0, 0), e3=Vec3(0, 1, 0), wavelength_nm=WL,
    )


def test_recovers_known_optimum_and_feasible():
    prob = _problem()
    assert prob.evaluate({}).eta < 0.99          # baseline is off the optimum
    r = optimize(
        prob, specs={"lens0": DOFSpec(axial=(-25.0, 25.0))},
        current_length_mm=50.0, eta_target=0.99, n_restarts=1,
    )
    assert r.feasible
    assert r.eta > 0.99
    assert r.config["lens0"].d_axial == pytest.approx(TRUE_D, abs=0.5)


def test_reports_infeasible_when_target_unreachable():
    prob = _problem()
    # Freeze all DOF: nothing to adjust, so the off-optimum baseline stands.
    r = optimize(
        prob, specs={"lens0": DOFSpec()},
        current_length_mm=50.0, eta_target=0.99,
    )
    assert not r.feasible
    assert r.best_achievable < 0.99
    assert r.reason


def test_length_locked_too_long_is_infeasible():
    prob = _problem()
    r = optimize(
        prob, specs={"lens0": DOFSpec(axial=(-25.0, 25.0))},
        current_length_mm=150.0, l_max_mm=100.0,
        endpoint_id="mirror5", endpoint_locked=True,
    )
    assert not r.feasible
    assert "locked" in r.reason.lower()
    assert r.n_evals == 0  # bailed before any trace
