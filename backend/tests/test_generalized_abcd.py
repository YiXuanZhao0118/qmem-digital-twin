"""Tests for generalized_abcd.py — 5x5 algebra + Generalized ABCD propagation."""

import math

import numpy as np
import pytest

from app.solvers.generalized_abcd import (
    BeamMisaligned,
    apply_operator,
    compose,
    m_curved_mirror,
    m_cylindrical_rotated,
    m_cylindrical_standard,
    m_faraday_slab,
    m_flat_mirror,
    m_free_space,
    m_glan_slab,
    m_glass_plate,
    m_pbs_reflected,
    m_pbs_transmitted,
    m_rotation,
    m_splitter_reflection_advanced,
    m_thin_lens,
    q_from_waist,
    radius_of_curvature_mm,
    spot_radius_um,
    waist_um_from_q,
)


WAVELENGTH_NM = 780.241


# --------- operator matrix structure ---------


def test_free_space_matrix_form():
    M = m_free_space(123.0)
    assert M[0, 1] == 123.0
    assert M[2, 3] == 123.0
    # all other off-identity entries zero
    expected = np.eye(5)
    expected[0, 1] = 123.0
    expected[2, 3] = 123.0
    np.testing.assert_allclose(M, expected)


def test_thin_lens_centered_aligned_is_pure_focus():
    f = 100.0
    M = m_thin_lens(f)
    assert M[1, 0] == pytest.approx(-1.0 / f)
    assert M[3, 2] == pytest.approx(-1.0 / f)
    assert M[1, 4] == 0.0 and M[3, 4] == 0.0


def test_thin_lens_decenter_tilt_per_spec():
    """Literal verification of M[1,4] = δ/f + α(1 − 1/f) etc."""
    f = 100.0
    dx, dy = 0.5, -0.3
    ax, ay = 0.001, 0.002
    M = m_thin_lens(f, delta_x_mm=dx, delta_y_mm=dy,
                    alpha_x_rad=ax, alpha_y_rad=ay)
    inv_f = 1.0 / f
    assert M[1, 4] == pytest.approx(dx * inv_f - ax)
    assert M[3, 4] == pytest.approx(dy * inv_f - ay)


def test_cylindrical_x_axis_has_focus_in_x_and_plate_in_y():
    """x-focusing cyl lens with thickness d, index n: y-block is glass plate."""
    f, d, n = 50.0, 5.0, 1.515
    M = m_cylindrical_standard(f, axis="x", thickness_mm=d, refractive_index=n,
                               alpha_y_rad=0.01)
    # x-block: focusing
    assert M[1, 0] == pytest.approx(-1.0 / f)
    # y-block: glass plate (d/n in B element)
    assert M[2, 3] == pytest.approx(d / n)
    # y-block tilt-induced shift
    assert M[2, 4] == pytest.approx(0.01 * d * (1.0 - 1.0 / n))


def test_cylindrical_y_axis_swaps_blocks():
    f, d, n = 50.0, 5.0, 1.515
    M = m_cylindrical_standard(f, axis="y", thickness_mm=d, refractive_index=n)
    # x-block now glass plate
    assert M[0, 1] == pytest.approx(d / n)
    # y-block focusing
    assert M[3, 2] == pytest.approx(-1.0 / f)


def test_cylindrical_default_thickness_zero_recovers_thin_lens_only_in_focus_axis():
    """Default d=0, n=1: focus-axis behaves as thin lens, other axis identity."""
    M = m_cylindrical_standard(75.0, axis="x")
    # y-block should be identity sub-block
    assert M[2, 3] == 0.0
    assert M[2, 4] == 0.0


def test_flat_mirror_has_no_decenter_term():
    """Spec: mirror's 5th column has only 2α, no δ."""
    M = m_flat_mirror(alpha_x_rad=0.003, alpha_y_rad=0.004)
    assert M[1, 1] == 1.0 and M[3, 3] == 1.0
    assert M[1, 4] == pytest.approx(2.0 * 0.003)
    assert M[3, 4] == pytest.approx(2.0 * 0.004)


def test_curved_mirror_combines_focus_and_reflection():
    R = 200.0
    M = m_curved_mirror(R, delta_x_mm=0.1, alpha_x_rad=0.005)
    inv_f = 2.0 / R
    assert M[1, 0] == pytest.approx(-inv_f)
    assert M[1, 1] == 1.0
    assert M[1, 4] == pytest.approx(0.1 * inv_f + 2.0 * 0.005)


def test_pbs_reflected_uses_advanced_splitter_model():
    L, n = 12.7, 1.515
    plate_alpha = 0.001
    coating_alpha = 0.003
    M = m_pbs_reflected(
        L,
        n,
        plate_alpha_x_rad=plate_alpha,
        coating_alpha_x_rad=coating_alpha,
        reflection_fraction=0.5,
    )
    s = L * (1.0 - 1.0 / n)
    assert M[0, 1] == pytest.approx(L / n)
    assert M[1, 4] == pytest.approx(2.0 * coating_alpha)
    assert M[0, 4] == pytest.approx(
        plate_alpha * s + (L * 0.5 / n) * 2.0 * coating_alpha
    )


def test_splitter_reflection_rejects_bad_inputs():
    with pytest.raises(ValueError):
        m_splitter_reflection_advanced(1.0, 0.0)
    with pytest.raises(ValueError):
        m_splitter_reflection_advanced(-1.0, 1.5)
    with pytest.raises(ValueError):
        m_splitter_reflection_advanced(1.0, 1.5, reflection_fraction=1.1)


def test_pbs_transmitted_equals_glass_plate():
    D, n = 12.7, 1.515
    np.testing.assert_allclose(
        m_pbs_transmitted(D, n, alpha_x_rad=0.001, alpha_y_rad=0.002),
        m_glass_plate(D, n, alpha_x_rad=0.001, alpha_y_rad=0.002),
    )


def test_glass_plate_snell_reduced():
    d, n = 10.0, 1.5
    M = m_glass_plate(d, n, alpha_x_rad=0.001, alpha_y_rad=0.002)
    assert M[0, 1] == pytest.approx(d / n)
    assert M[2, 3] == pytest.approx(d / n)
    assert M[0, 4] == pytest.approx(0.001 * d * (1.0 - 1.0 / n))
    assert M[2, 4] == pytest.approx(0.002 * d * (1.0 - 1.0 / n))


def test_glan_slab_astigmatic_B_xy():
    """Glan slab: B_x = L/n + ΔB_air, B_y = L/n. The user-spec compact
    catalogue model (L=7.5 mm, n_e=1.48, ΔB=0.05 mm) → B_y = 5.0676 mm,
    B_x = 5.1176 mm."""
    M = m_glan_slab(7.5, 1.48, wedge_angle_deg=38.5, air_gap_dB_x_mm=0.05)
    expected_By = 7.5 / 1.48
    assert M[2, 3] == pytest.approx(expected_By)
    assert M[0, 1] == pytest.approx(expected_By + 0.05)
    # M[0,1] strictly greater than M[2,3] — that's the whole point.
    assert M[0, 1] > M[2, 3]
    # No augmented offset by default.
    assert M[0, 4] == 0.0


def test_glan_slab_zero_astigmatism_reduces_to_glass_plate_diagonal():
    """ΔB_x = 0 should make B_x == B_y == L/n (matches m_glass_plate's
    diagonal block for the same L, n)."""
    L, n = 7.5, 1.48
    M_glan = m_glan_slab(L, n, air_gap_dB_x_mm=0.0)
    assert M_glan[0, 1] == pytest.approx(M_glan[2, 3])
    assert M_glan[0, 1] == pytest.approx(L / n)


def test_glan_slab_augmented_offset_lands_in_M04():
    """E_x augmented term sits in M[0,4] and survives matrix multiply
    against the augmented (x, θ_x, y, θ_y, 1) state vector."""
    M = m_glan_slab(7.5, 1.48, augmented_offset_x_mm=0.12)
    assert M[0, 4] == pytest.approx(0.12)
    # On-axis input → x_out = 0 + 0 + 0.12·1 = 0.12 mm.
    v_in = np.array([0.0, 0.0, 0.0, 0.0, 1.0])
    v_out = M @ v_in
    assert v_out[0] == pytest.approx(0.12)
    # y unaffected.
    assert v_out[2] == 0.0


def test_glan_slab_rejects_bad_inputs():
    with pytest.raises(ValueError):
        m_glan_slab(7.5, 0.0)
    with pytest.raises(ValueError):
        m_glan_slab(7.5, -1.0)
    with pytest.raises(ValueError):
        m_glan_slab(-1.0, 1.48)


def test_faraday_slab_symmetric_B_xy():
    """Faraday slab is geometrically symmetric (TGG end faces flat):
    B_x = B_y = L/n. For the user-spec TGG (L=8 mm, n=1.95) → 4.103 mm."""
    M = m_faraday_slab(8.0, 1.95, rotation_deg=45.0)
    expected = 8.0 / 1.95
    assert M[0, 1] == pytest.approx(expected)
    assert M[2, 3] == pytest.approx(expected)
    assert M[0, 1] == M[2, 3]


def test_faraday_slab_tilt_rotation_block():
    """45° tilt rotation: incoming (θ_x, θ_y) = (1, 0) → outgoing
    (cos 45°, -sin 45°). Block sits in rows 1,3 / cols 1,3."""
    M = m_faraday_slab(8.0, 1.95, rotation_deg=45.0)
    inv_sqrt2 = 1.0 / math.sqrt(2.0)
    # M[1,1] = cos 45°, M[1,3] = sin 45°
    assert M[1, 1] == pytest.approx(inv_sqrt2)
    assert M[1, 3] == pytest.approx(inv_sqrt2)
    # M[3,1] = -sin 45°, M[3,3] = cos 45°
    assert M[3, 1] == pytest.approx(-inv_sqrt2)
    assert M[3, 3] == pytest.approx(inv_sqrt2)
    # Apply to (0, 1, 0, 0, 1) — pure +x tilt.
    v_in = np.array([0.0, 1.0, 0.0, 0.0, 1.0])
    v_out = M @ v_in
    # θ_x_out = cos 45° = 1/√2; θ_y_out = -sin 45° = -1/√2.
    assert v_out[1] == pytest.approx(inv_sqrt2)
    assert v_out[3] == pytest.approx(-inv_sqrt2)


def test_faraday_slab_zero_rotation_reduces_to_glass_plate_block():
    """rotation_deg = 0 → identity tilt block → matches a symmetric
    glass-plate diagonal (no tilt coupling)."""
    M = m_faraday_slab(8.0, 1.95, rotation_deg=0.0)
    assert M[1, 1] == pytest.approx(1.0)
    assert M[1, 3] == pytest.approx(0.0)
    assert M[3, 1] == pytest.approx(0.0)
    assert M[3, 3] == pytest.approx(1.0)


def test_faraday_slab_augmented_offsets():
    """E_x lands in M[0,4], E_y in M[2,4]. On-axis input picks them up
    as constant lateral shifts."""
    M = m_faraday_slab(8.0, 1.95, rotation_deg=45.0,
                       augmented_offset_x_mm=0.1, augmented_offset_y_mm=-0.05)
    assert M[0, 4] == pytest.approx(0.1)
    assert M[2, 4] == pytest.approx(-0.05)
    v_in = np.array([0.0, 0.0, 0.0, 0.0, 1.0])
    v_out = M @ v_in
    assert v_out[0] == pytest.approx(0.1)
    assert v_out[2] == pytest.approx(-0.05)


def test_faraday_slab_rejects_bad_inputs():
    with pytest.raises(ValueError):
        m_faraday_slab(8.0, 0.0)
    with pytest.raises(ValueError):
        m_faraday_slab(-1.0, 1.95)


def test_rotation_orthogonal():
    R = m_rotation(0.37)
    np.testing.assert_allclose(R @ m_rotation(-0.37), np.eye(5), atol=1e-12)


def test_cylindrical_rotated_zero_equals_standard():
    np.testing.assert_allclose(
        m_cylindrical_standard(50.0, axis="x"),
        m_cylindrical_rotated(50.0, 0.0, axis="x"),
        atol=1e-12,
    )


def test_cylindrical_rotated_pi_over_2_swaps_focusing_axis():
    """An x-focusing cyl rotated 90° should focus in y instead."""
    M = m_cylindrical_rotated(50.0, math.pi / 2.0, axis="x")
    # x-focusing element (M[1,0]) should vanish
    assert abs(M[1, 0]) < 1e-12
    # y-focusing element (M[3,2]) should equal -1/f
    assert M[3, 2] == pytest.approx(-1.0 / 50.0)


def test_compose_right_to_left():
    M_a = m_thin_lens(100.0)
    M_b = m_free_space(50.0)
    np.testing.assert_allclose(compose(M_a, M_b), M_b @ M_a)


# --------- q-parameter constructors ---------


def test_q_at_waist_is_pure_imaginary():
    q = q_from_waist(100.0, 0.0, WAVELENGTH_NM)
    assert q.real == 0.0
    assert q.imag > 0.0


def test_waist_roundtrip():
    q = q_from_waist(150.0, 0.0, WAVELENGTH_NM)
    assert waist_um_from_q(q, WAVELENGTH_NM) == pytest.approx(150.0)


def test_spot_at_waist_equals_waist():
    q = q_from_waist(100.0, 0.0, WAVELENGTH_NM)
    assert spot_radius_um(q, WAVELENGTH_NM) == pytest.approx(100.0)


def test_spot_grows_far_from_waist():
    q = q_from_waist(100.0, 0.0, WAVELENGTH_NM)
    q_far = complex(q.real + 1000.0, q.imag)
    assert spot_radius_um(q_far, WAVELENGTH_NM) > 100.0


def test_radius_at_waist_is_infinite():
    q = q_from_waist(100.0, 0.0, WAVELENGTH_NM)
    assert math.isinf(radius_of_curvature_mm(q))


# --------- apply_operator: q-ABCD law ---------


def test_free_space_propagation_advances_q_real_part():
    q0 = q_from_waist(100.0, 0.0, WAVELENGTH_NM)
    beam = BeamMisaligned(q_x=q0, q_y=q0, wavelength_nm=WAVELENGTH_NM)
    out = apply_operator(beam, m_free_space(200.0))
    assert out.q_x.real == pytest.approx(q0.real + 200.0)
    assert out.q_x.imag == pytest.approx(q0.imag)


def test_thin_lens_focuses_collimated_beam_to_focal_length():
    """A collimated Gaussian (waist at lens) focuses to a waist at ~f behind."""
    f_mm = 100.0
    q_in = q_from_waist(1000.0, 0.0, WAVELENGTH_NM)  # 1mm waist, collimated
    beam = BeamMisaligned(q_x=q_in, q_y=q_in, wavelength_nm=WAVELENGTH_NM)
    out = apply_operator(beam, m_thin_lens(f_mm))
    # New waist sits at z = -out.q_x.real ahead of current plane
    # For tight collimated → strong focus, distance ≈ f
    assert -out.q_x.real == pytest.approx(f_mm, rel=0.01)


def test_flat_mirror_leaves_q_unchanged_in_unfolded_frame():
    """Unfolded-frame spec: q_out = q_in for a flat mirror."""
    q0 = complex(50.0, 30.0)  # generic non-trivial q
    beam = BeamMisaligned(q_x=q0, q_y=q0, wavelength_nm=WAVELENGTH_NM)
    out = apply_operator(beam, m_flat_mirror())
    assert out.q_x == pytest.approx(q0)
    assert out.q_y == pytest.approx(q0)


def test_glass_plate_propagates_q_by_d_over_n():
    """Per spec: q_out = q_in + d/n through a glass plate."""
    q0 = q_from_waist(500.0, 0.0, WAVELENGTH_NM)
    beam = BeamMisaligned(q_x=q0, q_y=q0, wavelength_nm=WAVELENGTH_NM)
    d, n = 10.0, 1.5
    out = apply_operator(beam, m_glass_plate(d, n))
    assert out.q_x.real == pytest.approx(q0.real + d / n)


# --------- apply_operator: chief-ray vector update ---------


def test_free_space_advances_off_axis_beam():
    """Off-axis beam with tilt θ propagating L should land at x_c + L·θ."""
    q0 = q_from_waist(100.0, 0.0, WAVELENGTH_NM)
    beam = BeamMisaligned(q_x=q0, q_y=q0, x_c_mm=0.5, theta_xc_rad=0.01,
                          wavelength_nm=WAVELENGTH_NM)
    out = apply_operator(beam, m_free_space(100.0))
    assert out.x_c_mm == pytest.approx(0.5 + 100.0 * 0.01)
    assert out.theta_xc_rad == pytest.approx(0.01)


def test_decentered_lens_kicks_on_axis_beam():
    """δ=0.5mm decenter, f=100mm: on-axis beam gains θ_xc = δ/f = 5 mrad."""
    q0 = q_from_waist(1000.0, 0.0, WAVELENGTH_NM)
    beam = BeamMisaligned(q_x=q0, q_y=q0, wavelength_nm=WAVELENGTH_NM)
    out = apply_operator(beam, m_thin_lens(100.0, delta_x_mm=0.5))
    assert out.theta_xc_rad == pytest.approx(0.5 / 100.0)


def test_glass_plate_shifts_tilted_beam():
    """Tilted beam through plate: x_c shifts by (d/n)·θ; angle preserved."""
    q0 = q_from_waist(500.0, 0.0, WAVELENGTH_NM)
    beam = BeamMisaligned(q_x=q0, q_y=q0, theta_xc_rad=0.01,
                          wavelength_nm=WAVELENGTH_NM)
    d, n = 10.0, 1.5
    out = apply_operator(beam, m_glass_plate(d, n))
    assert out.x_c_mm == pytest.approx((d / n) * 0.01)
    assert out.theta_xc_rad == pytest.approx(0.01)


def test_tilted_mirror_deflects_by_2_alpha():
    """Tilt α on mirror gives 2α deflection of reflected angle."""
    q0 = q_from_waist(500.0, 0.0, WAVELENGTH_NM)
    beam = BeamMisaligned(q_x=q0, q_y=q0, wavelength_nm=WAVELENGTH_NM)
    out = apply_operator(beam, m_flat_mirror(alpha_x_rad=0.005))
    assert out.theta_xc_rad == pytest.approx(2.0 * 0.005)


def test_flat_mirror_unaffected_by_decenter():
    """Spec: pure translation of a mirror does not deflect the ray.
    There's no δ param to pass, and the 5th column is zero of δ origin."""
    M = m_flat_mirror(alpha_x_rad=0.0, alpha_y_rad=0.0)
    # 5th column should be zero apart from M[4,4] = 1
    assert M[0, 4] == 0.0 and M[1, 4] == 0.0
    assert M[2, 4] == 0.0 and M[3, 4] == 0.0


def test_compose_equals_sequential_application():
    q0 = q_from_waist(200.0, 0.0, WAVELENGTH_NM)
    beam = BeamMisaligned(q_x=q0, q_y=q0, x_c_mm=0.2, theta_xc_rad=0.005,
                          wavelength_nm=WAVELENGTH_NM)
    M_lens = m_thin_lens(150.0, delta_x_mm=0.1)
    M_space = m_free_space(80.0)

    seq = apply_operator(apply_operator(beam, M_lens), M_space)
    once = apply_operator(beam, compose(M_lens, M_space))

    assert seq.x_c_mm == pytest.approx(once.x_c_mm)
    assert seq.theta_xc_rad == pytest.approx(once.theta_xc_rad)
    assert seq.q_x.real == pytest.approx(once.q_x.real)
    assert seq.q_x.imag == pytest.approx(once.q_x.imag)


def test_rotated_cylindrical_couples_x_and_y_chief_ray():
    """A cyl lens focusing in x, rotated 45° around beam axis, should
    deflect a beam offset in x toward BOTH x and y axes (cross-coupling)."""
    q0 = q_from_waist(500.0, 0.0, WAVELENGTH_NM)
    beam = BeamMisaligned(q_x=q0, q_y=q0, x_c_mm=1.0,
                          wavelength_nm=WAVELENGTH_NM)
    M = m_cylindrical_rotated(100.0, math.pi / 4.0, axis="x")
    out = apply_operator(beam, M)
    # For 45° rotation, x-offset gets distributed into both axes' angle updates
    assert abs(out.theta_xc_rad) > 1e-9
    assert abs(out.theta_yc_rad) > 1e-9
