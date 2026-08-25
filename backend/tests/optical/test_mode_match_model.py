"""Mode-matching section model (Phase 2): in-memory lens re-pose + reverse
reference readout, checked against hand-computed ABCD on a synthetic scene.

No DB. One thin spherical lens on the +z axis; a reverse Gaussian launched
back through it; the comparison plane just past the lens. The forward "seed"
target is set to the baseline reverse q so a perfect baseline reads η=1, and
every re-posed configuration is checked against an independent free-space +
thin-lens computation.
"""

import math

import pytest

from app.optical import anchor_ops  # noqa: F401  (register ops)
from app.optical.anchor_tracer import (
    V3Anchor, V3AnchorBindingSlot, V3AnchorScene, V3AssetAnchorSnapshot,
)
from app.optical.beam_ray import BeamRay, QMatrix, Vec3
from app.optical.mode_match import gaussian_mode_overlap
from app.optical.mode_match_model import (
    LensConfig, ModeMatchProblem, MovableLens,
)
from app.optical.pose import V3Transform

WL = 852.0
F = 100.0
Z_START = 10.0   # reverse ray origin (mm, +z)
Z_CMP = -10.0    # comparison plane (mm), just past the lens


def _lens_slot(kind: str, f_mm: float, z0: float = 0.0) -> V3AnchorBindingSlot:
    anchor = V3Anchor(
        id="intercept_in",
        position_body=Vec3(0, 0, 0),
        axis_x_body=Vec3(0, 0, 1),     # optical axis +z
        axis_y_body=Vec3(0, 1, 0),
        axis_z_body=Vec3(1, 0, 0),
        aperture_mm=25.4,
    )
    snap = V3AssetAnchorSnapshot(
        catalog_id="synthetic_lens", kind=kind, anchors=[anchor],
        default_params={"focalLengthMm": f_mm, "transmittance": 1.0},
    )
    return V3AnchorBindingSlot(
        scene_object_id="lens0", binding_id="b0", asset=snap,
        effective_transform=V3Transform(origin=Vec3(0, 0, z0)),
    )


def _q_free(q: complex, d: float) -> complex:
    return q + d


def _q_lens(q: complex, f: float) -> complex:
    return 1.0 / (1.0 / q - 1.0 / f)


def _reverse_q3(q0: complex, f: float, d_axial: float) -> complex:
    """Analytic reverse q at the comparison plane with the lens shifted by
    ``d_axial`` along +z. Reverse ray: z=+10 → lens(z=d_axial) → z=−10."""
    q1 = _q_free(q0, Z_START - d_axial)     # travel to the (moved) lens
    q2 = _q_lens(q1, f)
    q3 = _q_free(q2, d_axial - Z_CMP)       # lens → comparison plane
    return q3


def _make_problem(kind: str = "lens") -> tuple[ModeMatchProblem, complex]:
    slot = _lens_slot(kind, F)
    # reverse Gaussian at its waist (w0=0.3mm) at z=+10, heading −z.
    zr = math.pi * 0.3 * 0.3 / (WL * 1e-6)
    q0 = complex(0.0, zr)
    reverse = BeamRay(
        origin=Vec3(0, 0, Z_START), direction=Vec3(0, 0, -1),
        qx=q0, qy=q0, wavelength_nm=WL, power_mw=1.0,
        jones=(complex(1, 0), complex(0, 0)),
    )
    seed_q = QMatrix(_reverse_q3(q0, F, 0.0), _reverse_q3(q0, F, 0.0))
    lens = MovableLens(
        scene_object_id="lens0", name="lens0", kind=kind,
        base_transform=slot.effective_transform, base_focal_mm=F,
    )
    prob = ModeMatchProblem(
        scene=V3AnchorScene(slots=[slot]),
        lenses=[lens], reverse_ray=reverse, seed_q=seed_q,
        compare_point=Vec3(0, 0, Z_CMP), axis=Vec3(0, 0, 1),
        e2=Vec3(1, 0, 0), e3=Vec3(0, 1, 0), wavelength_nm=WL,
    )
    return prob, q0


def test_baseline_is_perfect_match():
    prob, _ = _make_problem()
    r = prob.evaluate({})
    assert r.reached
    assert r.eta == pytest.approx(1.0, abs=1e-6)


@pytest.mark.parametrize("d_axial", [-5.0, -2.0, 2.0, 5.0])
def test_axial_move_matches_analytic_abcd(d_axial):
    prob, q0 = _make_problem()
    r = prob.evaluate({"lens0": LensConfig(d_axial=d_axial)})
    q3 = _reverse_q3(q0, F, d_axial)
    expected = gaussian_mode_overlap(prob.seed_q, QMatrix(q3, q3))
    assert r.reached
    assert r.eta == pytest.approx(expected, rel=1e-6, abs=1e-6)
    assert r.eta < 1.0  # moved off the perfect point


def test_focal_override_matches_analytic():
    prob, q0 = _make_problem()
    f2 = 75.0
    r = prob.evaluate({"lens0": LensConfig(focal_mm=f2)})
    q3 = _reverse_q3(q0, f2, 0.0)
    expected = gaussian_mode_overlap(prob.seed_q, QMatrix(q3, q3))
    assert r.eta == pytest.approx(expected, rel=1e-6, abs=1e-6)


def test_spherical_roll_is_invariant():
    """A spherical lens is rotationally symmetric: rolling it about the optical
    axis must not change η."""
    prob, _ = _make_problem(kind="lens")
    base = prob.evaluate({}).eta
    for roll in (17.0, 90.0, 133.0):
        assert prob.evaluate({"lens0": LensConfig(roll_deg=roll)}).eta == \
            pytest.approx(base, abs=1e-9)
