"""Lens anchor-op behaviour when the beam is misaligned with the lens:
oblique incidence (tilt → astigmatism) and lateral decenter (asymmetric
clear-aperture clipping). At normal incidence / centred these reduce to the
existing symmetric thin-lens behaviour.
"""

import math

import pytest

from app.optical import anchor_ops  # noqa: F401  (registers anchor ops)
from app.optical.anchor_ops.lens import _tilt_astig_focals
from app.optical.anchor_tracer import (
    AnchorHit, AnchorOpContext, V3Anchor, V3AssetAnchorSnapshot, get_anchor_op,
)
from app.optical.aperture import gaussian_circular_aperture_fraction
from app.optical.jones import beam_local_sp
from app.optical.beam_ray import (
    Mat2,
    Vec3,
    make_beam_ray,
    q_matrix_after_abcd,
    q_matrix_principal_widths,
)


def _anchor(aperture_mm: float = 0.0) -> V3Anchor:
    return V3Anchor(
        id="intercept_in",
        position_body=Vec3(0, 0, 0),
        axis_x_body=Vec3(1, 0, 0),   # optical axis +x
        axis_y_body=Vec3(0, 1, 0),
        axis_z_body=Vec3(0, 0, 1),
        aperture_mm=aperture_mm,
    )


def _ctx(*, aperture_mm=0.0, off_y=0.0, off_z=0.0, f_mm=100.0) -> AnchorOpContext:
    anchor = _anchor(aperture_mm)
    hit = AnchorHit(
        slot=None, anchor=anchor, t_lab=0.0, hit_point_body=Vec3(0, off_y, off_z),
        offset_y_body=off_y, offset_z_body=off_z, cos_incidence=1.0,
    )
    asset = V3AssetAnchorSnapshot(
        catalog_id="lens", kind="lens", anchors=[anchor],
    )
    return AnchorOpContext(
        asset=asset, anchor=anchor, hit=hit,
        params={"focalLengthMm": f_mm}, dynamic={},
    )


def _collimated_ray(direction: Vec3) -> "BeamRay":
    # Huge waist ⇒ huge zR ⇒ effectively collimated at the lens, so after the
    # lens the waist forms at ≈ f_eff (−Re(q') ≈ f_eff for large zR).
    return make_beam_ray(
        origin=Vec3(0, 0, 0), direction=direction,
        wavelength_nm=780, waist_radius_mm=5.0, power_mw=1.0,
    )


# ── tilt-astigmatism helper (pure) ─────────────────────────────────────────

def test_tilt_helper_identity_at_normal_incidence():
    fy, fz = _tilt_astig_focals(100.0, 0.0, 0.0)
    assert fy == pytest.approx(100.0)
    assert fz == pytest.approx(100.0)


def test_tilt_helper_splits_in_principal_plane():
    # Tilt purely in the axisY plane (θ_z = 0): axisY is tangential → f·cosα,
    # axisZ is sagittal → f/cosα.
    alpha = math.radians(30)
    fy, fz = _tilt_astig_focals(100.0, math.tan(alpha), 0.0)
    assert fy == pytest.approx(100.0 * math.cos(alpha), rel=1e-9)
    assert fz == pytest.approx(100.0 / math.cos(alpha), rel=1e-9)


def test_tilt_helper_clamps_near_grazing():
    # Past ~60° the cos α floor caps the split so f·cosα can't collapse to 0.
    fy, fz = _tilt_astig_focals(100.0, math.tan(math.radians(85)), 0.0)
    # cos floored at 0.5 ⇒ tangential focal ≥ 0.5·f, sagittal ≤ 2·f.
    assert fy == pytest.approx(50.0, rel=1e-9)
    assert fz == pytest.approx(200.0, rel=1e-9)


def test_tilt_helper_diagonal_is_isotropic():
    # φ=45° (θ_y == θ_z): both axes get the same averaged power; the dropped
    # cross term is what would re-introduce the split, by design absent here.
    alpha = math.radians(20)
    s = math.tan(alpha) / math.sqrt(2.0)
    fy, fz = _tilt_astig_focals(100.0, s, s)
    assert fy == pytest.approx(fz, rel=1e-12)


# ── op end-to-end: oblique beam focuses astigmatically ─────────────────────

def test_oblique_beam_focuses_at_split_focals():
    """Tangential focus at f·cosα, sagittal at f/cosα.

    Which of qx / qy carries which is a question about the FRAME, not about
    the lens: since Step 2b, Q is expressed in the beam-local (s, p) basis of
    ``jones.beam_local_sp``, not in the anchor's (axisY, axisZ). For a beam
    tilted inside the x-y plane that basis comes out s = world +z, so the
    plane of incidence lies along p -- and the TANGENTIAL focal therefore
    lands on qy, the sagittal on qx. Asserting it the other way round (as this
    test did before 2b) was asserting the frame conflation, not the optics.
    """
    op = get_anchor_op("lens")
    f = 100.0
    alpha = math.radians(30)
    # Tilt in the x-y plane: θ_y = tanα, θ_z = 0.
    direction = Vec3(math.cos(alpha), math.sin(alpha), 0.0)
    ray = _collimated_ray(direction)
    [out] = op(ray, _ctx(f_mm=f))

    s_beam, p_beam = beam_local_sp(direction)
    # incidence plane = span(direction, lens axisX); both lie in x-y, so the
    # in-plane transverse direction is p and the out-of-plane one is s.
    assert abs(s_beam.z) == pytest.approx(1.0, abs=1e-12)
    assert abs(p_beam.z) == pytest.approx(0.0, abs=1e-12)

    # Collimated ⇒ post-lens waist distance ≈ effective focal per axis.
    assert -out.qx.real == pytest.approx(f / math.cos(alpha), rel=2e-3)  # sagittal
    assert -out.qy.real == pytest.approx(f * math.cos(alpha), rel=2e-3)  # tangential
    # The incidence plane is itself a principal axis here, so no cross term.
    assert abs(out.qxy) == pytest.approx(0.0, abs=1e-9)


def test_oblique_beam_off_principal_azimuth_makes_a_cross_term():
    """The term ``_tilt_astig_focals`` documents as dropped. Tilt the beam at
    45 deg in azimuth so the incidence plane is aligned with neither principal
    axis: Q must come out with a non-zero off-diagonal, and its principal axes
    must be rotated away from the frame axes."""
    op = get_anchor_op("lens")
    f = 100.0
    t = math.tan(math.radians(20)) / math.sqrt(2.0)
    direction = Vec3(1.0, t, t).normalized()
    [out] = op(_collimated_ray(direction), _ctx(f_mm=f))

    assert abs(out.qxy) > 1e-6

    # A thin lens cannot change the spot shape (Q'^-1 = Q^-1 - P with P real),
    # and the input here is round, so the azimuth is degenerate AT the lens.
    # The rotated astigmatism only becomes visible downstream.
    downstream = q_matrix_after_abcd(
        out.q_matrix, Mat2.identity(), Mat2.scalar(complex(60.0)),
        Mat2.scalar(0j), Mat2.identity(),
    )
    major, minor, azim = q_matrix_principal_widths(downstream, 852.347)
    assert major > minor > 0.0
    assert math.degrees(abs(azim)) % 90.0 > 1.0


def test_normal_incidence_stays_circular():
    op = get_anchor_op("lens")
    [out] = op(_collimated_ray(Vec3(1, 0, 0)), _ctx(f_mm=100.0))
    assert out.qx.real == pytest.approx(out.qy.real, rel=1e-12)


# ── decenter: asymmetric clear-aperture clipping ───────────────────────────

def test_decenter_reduces_transmission_vs_centred():
    op = get_anchor_op("lens")
    w0 = 2.0
    a = 2.0
    centred = op(
        make_beam_ray(origin=Vec3(0, 0, 0), direction=Vec3(1, 0, 0),
                      wavelength_nm=780, waist_radius_mm=w0, power_mw=1.0),
        _ctx(aperture_mm=a),
    )[0]
    off = op(
        make_beam_ray(origin=Vec3(0, 0, 0), direction=Vec3(1, 0, 0),
                      wavelength_nm=780, waist_radius_mm=w0, power_mw=1.0),
        _ctx(aperture_mm=a, off_y=1.5),
    )[0]
    # On-axis closed form for the centred case.
    assert centred.power_mw == pytest.approx(1.0 - math.exp(-2.0), rel=1e-9)
    # Decentred always passes strictly less (more of the wing is clipped).
    assert off.power_mw < centred.power_mw
    # Matches the aperture helper fed the same radial decenter.
    expected = gaussian_circular_aperture_fraction(w0, a, 1.5)
    assert off.power_mw == pytest.approx(expected, rel=1e-9)


def test_centred_no_aperture_is_lossless_and_unchanged_focus():
    # Regression: with no decenter and no aperture the op is unchanged.
    op = get_anchor_op("lens")
    [out] = op(_collimated_ray(Vec3(1, 0, 0)), _ctx(f_mm=50.0))
    assert out.power_mw == pytest.approx(1.0, rel=1e-12)
    assert -out.qx.real == pytest.approx(50.0, rel=2e-3)
