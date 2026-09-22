"""Mode-matching section model (Phase 2): in-memory lens re-pose + reverse
reference readout, checked against hand-computed ABCD on a synthetic scene.

No DB. One thin spherical lens on the +z axis; a reverse Gaussian launched
back through it; the comparison plane just past the lens. The forward "seed"
target is set to the TIME REVERSE of the baseline reverse q (same widths,
opposite curvatures) so a perfect baseline reads η=1, and
every re-posed configuration is checked against an independent free-space +
thin-lens computation.
"""

import math

import pytest

from app.optical import anchor_ops  # noqa: F401  (register ops)
from app.optical.anchor_tracer import (
    V3Anchor, V3AnchorBindingSlot, V3AnchorScene, V3AssetAnchorSnapshot,
    trace_ray_anchor_scene,
)
from app.optical.beam_ray import BeamRay, QMatrix, Vec3
from app.optical.mode_match import gaussian_mode_overlap, time_reversed_target
from app.optical.mode_match_model import (
    LensConfig, ModeMatchProblem, MovableLens, optical_centre_lab,
)
from app.optical.pose import V3Transform, point_body_to_lab_t

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
    seed_q = time_reversed_target(
        QMatrix(_reverse_q3(q0, F, 0.0), _reverse_q3(q0, F, 0.0))
    )
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
    expected = gaussian_mode_overlap(prob.seed_q, time_reversed_target(QMatrix(q3, q3)))
    assert r.reached
    assert r.eta == pytest.approx(expected, rel=1e-6, abs=1e-6)
    assert r.eta < 1.0  # moved off the perfect point


def test_focal_override_matches_analytic():
    prob, q0 = _make_problem()
    f2 = 75.0
    r = prob.evaluate({"lens0": LensConfig(focal_mm=f2)})
    q3 = _reverse_q3(q0, f2, 0.0)
    expected = gaussian_mode_overlap(prob.seed_q, time_reversed_target(QMatrix(q3, q3)))
    assert r.eta == pytest.approx(expected, rel=1e-6, abs=1e-6)


def test_spherical_roll_is_invariant():
    """A spherical lens is rotationally symmetric: rolling it about the optical
    axis must not change η."""
    prob, _ = _make_problem(kind="lens")
    base = prob.evaluate({}).eta
    for roll in (17.0, 90.0, 133.0):
        assert prob.evaluate({"lens0": LensConfig(roll_deg=roll)}).eta == \
            pytest.approx(base, abs=1e-9)


def test_seed_equal_to_reverse_beam_is_not_a_match():
    """The reverse reference is curved at the comparison plane (it is 10 mm
    past a lens, far from its waist). A seed IDENTICAL to it — same widths AND
    same curvature sign — is not mode-matched: the seed has to be its time
    reverse. Guards the 2026-09-02 fix (the model used to compare the two
    beams directly)."""
    prob, q0 = _make_problem()
    q3 = _reverse_q3(q0, F, 0.0)
    assert abs(q3.real) > 1.0                        # curved, so conjugation matters
    same = ModeMatchProblem(
        scene=prob.scene, lenses=prob.lenses, reverse_ray=prob.reverse_ray,
        seed_q=QMatrix(q3, q3), compare_point=prob.compare_point, axis=prob.axis,
        e2=prob.e2, e3=prob.e3, wavelength_nm=WL,
    )
    assert same.evaluate({}).eta < 0.99
    assert prob.evaluate({}).eta == pytest.approx(1.0, abs=1e-6)


# ── the roll pivot (2026-09-22) ─────────────────────────────────────────────

def _off_origin_problem(pivot_from_anchor: bool) -> ModeMatchProblem:
    """The same thin lens, but its asset origin sits 8 mm off the optical
    axis (the anchor is at body y=+8, the slot origin at lab y=-8, so the
    anchor — where the tracer hits — is still on the beam)."""
    anchor = V3Anchor(
        id="intercept_in", position_body=Vec3(0, 8, 0), axis_x_body=Vec3(0, 0, 1),
        axis_y_body=Vec3(0, 1, 0), axis_z_body=Vec3(1, 0, 0), aperture_mm=25.4,
    )
    slot = V3AnchorBindingSlot(
        scene_object_id="lens0", binding_id="b0",
        asset=V3AssetAnchorSnapshot(
            catalog_id="off_origin_lens", kind="lens", anchors=[anchor],
            default_params={"focalLengthMm": F, "transmittance": 1.0},
        ),
        effective_transform=V3Transform(origin=Vec3(0, -8, 0)),
    )
    base, _ = _make_problem()
    lens = MovableLens(
        scene_object_id="lens0", name="lens0", kind="lens",
        base_transform=slot.effective_transform, base_focal_mm=F,
        pivot=optical_centre_lab([slot]) if pivot_from_anchor else None,
    )
    return ModeMatchProblem(
        scene=V3AnchorScene(slots=[slot]), lenses=[lens],
        reverse_ray=base.reverse_ray, seed_q=base.seed_q,
        compare_point=base.compare_point, axis=base.axis, e2=base.e2, e3=base.e3,
        wavelength_nm=WL,
    )


def test_optical_centre_is_the_hit_anchor_not_the_asset_origin():
    prob = _off_origin_problem(pivot_from_anchor=True)
    c = prob.lenses[0].pivot
    assert (c.x, c.y, c.z) == pytest.approx((0.0, 0.0, 0.0), abs=1e-12)


def _anchor_and_exit_dir(prob: ModeMatchProblem, config: dict):
    """Where the lens's hit anchor sits after ``config``, and which way the
    reverse beam leaves the lens."""
    scene = prob._build_scene(config)
    slot = next(s for s in scene.slots if s.scene_object_id == "lens0")
    a = point_body_to_lab_t(slot.asset.anchors[0].position_body, slot.effective_transform)
    trace = trace_ray_anchor_scene(prob.reverse_ray, scene, prob.trace_options)
    # The leg that starts at the lens (z = 0) — the one the lens op emitted.
    out = next(s for s in trace.lab_segments if abs(s.start.z) < 1e-6)
    d = Vec3(out.end.x - out.start.x, out.end.y - out.start.y, out.end.z - out.start.z).normalized()
    return a, d


def test_roll_turns_about_the_optical_centre():
    """A roll must be a pure roll: the anchor the tracer hits stays on the
    beam, the beam is not steered, and a spherical lens stays matched.

    Turning about the asset origin instead (the model before 2026-09-22)
    carries the lens 11.3 mm sideways — a decenter nobody asked for — and the
    reverse beam leaves the lens steered by ~decenter/f. The overlap eta does
    NOT see that (a thin lens's decenter tilts the chief ray, it does not
    change q; mode-matching.md: a pointing error the objective does not
    penalize), so the optimizer would have reported a fine eta while the twin
    drew a deflected beam after Apply."""
    prob = _off_origin_problem(pivot_from_anchor=True)
    assert prob.evaluate({}).eta == pytest.approx(1.0, abs=1e-6)
    for roll in (17.0, 90.0, 133.0):
        cfg = {"lens0": LensConfig(roll_deg=roll)}
        assert prob.evaluate(cfg).eta == pytest.approx(1.0, abs=1e-6)
        a, d = _anchor_and_exit_dir(prob, cfg)
        assert (a.x, a.y, a.z) == pytest.approx((0.0, 0.0, 0.0), abs=1e-9)
        assert (d.x, d.y, d.z) == pytest.approx((0.0, 0.0, -1.0), abs=1e-9)

    old = _off_origin_problem(pivot_from_anchor=False)
    a, d = _anchor_and_exit_dir(old, {"lens0": LensConfig(roll_deg=90.0)})
    assert math.hypot(a.x, a.y) == pytest.approx(8.0 * math.sqrt(2.0), abs=1e-9)
    assert math.hypot(d.x, d.y) > 0.05  # ~11.3 mm / 100 mm of steer


def test_every_slot_of_a_moved_object_moves_rigidly():
    """A movable object with two traced slots (a lens and a traced mount)
    moves as one body; the model used to keep only one of them."""
    prob, _ = _make_problem()
    mount = V3AnchorBindingSlot(
        scene_object_id="lens0", binding_id="mount",
        asset=V3AssetAnchorSnapshot(
            catalog_id="mount", kind="beam_dump",
            anchors=[V3Anchor(id="intercept_in", position_body=Vec3(0, 0, 0),
                              axis_x_body=Vec3(0, 0, 1), axis_y_body=Vec3(0, 1, 0),
                              axis_z_body=Vec3(1, 0, 0), aperture_mm=1.0)],
        ),
        effective_transform=V3Transform(origin=Vec3(0, 30, 0)),
    )
    two = ModeMatchProblem(
        scene=V3AnchorScene(slots=[*prob.scene.slots, mount]), lenses=prob.lenses,
        reverse_ray=prob.reverse_ray, seed_q=prob.seed_q, compare_point=prob.compare_point,
        axis=prob.axis, e2=prob.e2, e3=prob.e3, wavelength_nm=WL,
    )
    moved = two._build_scene({"lens0": LensConfig(d_axial=3.0, roll_deg=90.0)}).slots
    by_binding = {s.binding_id: s.effective_transform for s in moved if s.scene_object_id == "lens0"}
    assert set(by_binding) == {"b0", "mount"}
    # Pivot = the lens slot origin here (MovableLens.pivot unset, the lens
    # anchor is at body 0); axis +z, +90 deg: (0, 30, 0) -> (-30, 0, 3).
    o = by_binding["mount"].origin
    assert (o.x, o.y, o.z) == pytest.approx((-30.0, 0.0, 3.0), abs=1e-9)
    o = by_binding["b0"].origin
    assert (o.x, o.y, o.z) == pytest.approx((0.0, 0.0, 3.0), abs=1e-12)
