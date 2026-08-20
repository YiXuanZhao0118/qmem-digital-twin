"""Lens anchor op (Phase 9.3).

Single primary anchor: ``optical_center`` at the lens body midpoint.
  axisX = optical axis (beam propagation through the lens body)
  axisY/axisZ = transverse axes (spherical lens is symmetric; cylindrical
                                  uses fx along axisY, fy along axisZ).

Physics — thin-lens approximation per axis:
  state' = M · state where state = (y, θ_y, z, θ_z, 1)
  for biconvex / plano-convex (spherical):
      M = [[1,0,0,0,0],
           [-1/f, 1, 0, 0, 0],
           [0, 0, 1, 0, 0],
           [0, 0, -1/f, 1, 0],
           [0, 0, 0, 0, 1]]
  for cylindrical: kick only on axisY (focusing axis), identity on axisZ.

q-parameter: 1/q' = 1/q − 1/f (applied to both qx and qy for spherical).

Thick lens (short-focus / aspheric, e.g. A230TM-B): when the asset's
``default_params`` carry ``radiusFrontMm`` + ``refractiveIndex`` +
``centerThicknessMm`` the op switches to the **full air→air thick-lens ABCD**
(both surfaces + glass slab folded into one matrix). The anchor sits at the
FRONT vertex; the out-ray is emitted at the BACK vertex (anchor + d·axisX) so
the focus lands at the physically correct plane (back vertex + BFL) instead of
the thin-lens approximation that collapses the principal planes. Aspheric =
its vertex (paraxial) radius here; conic/aspheric terms affect aberration
only, which a paraxial q-tracer does not model. See docs/introduce/optics.md.

Power: the chief ray is on-axis at ``optical_center`` by construction, so a
beam wider than the clear aperture loses the wings — the on-axis Gaussian
fraction ``1 − exp(−2a²/w²)`` (a = ``anchor.aperture_mm``, w = √(wx·wy)).
AR-coating / Fresnel loss is the separate ``default_params.transmittance``
factor. Both are applied to ``power_mw`` (energy half of the aperture story;
the diffraction *pattern* lives in the POP field channel).
"""

from __future__ import annotations

import math

from app.optical.anchor_tracer import (
    AnchorOpContext,
    apply_abcd_state,
    beam_state_from_anchor_hit,
    out_ray_from_state,
    register_anchor_op,
)
from app.optical.aperture import (
    gaussian_circular_aperture_fraction,
    gaussian_width_mm,
)
from app.optical.beam_ray import (
    BeamRay,
    Mat2,
    Vec3,
    q_after_thin_element,
    q_matrix_after_abcd,
    q_power_tensor,
)
from app.optical.jones import q_axis_to_beam, q_beam_to_axis


# Floor on cos α for the tilted-lens astigmatism split (≈ 60° incidence). The
# thin-lens f·cosα / f/cosα model is a small-angle approximation; past this a
# near-grazing hit would otherwise drive f·cosα → 0 and collapse the beam.
_COS_INCIDENCE_FLOOR = 0.5


def _q_after_lens(q: complex, f_mm: float) -> complex:
    # q_out from ABCD A=1, B=0, C=-1/f, D=1: q' = q / (1 - q/f)
    denom = 1.0 - q / f_mm
    if abs(denom) < 1e-20:
        return q
    return q / denom


def _surface_power(radius_mm, n: float, *, is_front: bool) -> float:
    """Paraxial power of one refracting surface. A flat face (radius None / 0 /
    ≈∞) has zero power. Sign convention matches ``thorlabs_la1509_b.json``:
    front P = (n−1)/R, back P = (1−n)/R, R>0 when the surface is convex toward
    the incoming light."""
    if radius_mm is None:
        return 0.0
    r = float(radius_mm)
    if abs(r) < 1e-9 or abs(r) > 1e6:
        return 0.0
    return ((n - 1.0) / r) if is_front else ((1.0 - n) / r)


def _thick_lens_abcd(
    radius_front_mm, radius_back_mm, n: float, d_mm: float,
) -> tuple[float, float, float, float]:
    """Air→air thick-lens ABCD: M = S₂ · T(d/n) · S₁. EFL = −1/C. Validated
    against the LA1509 golden (R=51.5, ∞, n=1.5168, d=3.6)."""
    p1 = _surface_power(radius_front_mm, n, is_front=True)
    p2 = _surface_power(radius_back_mm, n, is_front=False)
    tau = d_mm / n
    a = 1.0 - p1 * tau
    b = tau
    c = -(p1 + p2 - p1 * p2 * tau)
    dd = 1.0 - p2 * tau
    return a, b, c, dd


def _q_after_abcd(q: complex, a: float, b: float, c: float, d: float) -> complex:
    # q' = (A·q + B)/(C·q + D)
    denom = c * q + d
    if abs(denom) < 1e-20:
        return q
    return (a * q + b) / denom


def _tilt_astig_power_tensor(
    f_mm: float, theta_y: float, theta_z: float,
) -> Mat2:
    """The same tilted-lens astigmatism as :func:`_tilt_astig_focals`, but as
    the FULL 2x2 focusing-power tensor in the anchor's (axisY, axisZ) frame.

    Its diagonal is identical to that function's ``(1/f_y, 1/f_z)``; the
    difference is that the off-diagonal cross term -- which the scalar q pair
    could not represent, and which that docstring records as dropped -- is now
    carried. Non-zero whenever the incidence plane is not aligned with a
    principal axis (worst at azimuth 45 deg).
    """
    tan2 = theta_y * theta_y + theta_z * theta_z
    if tan2 < 1e-15:
        return q_power_tensor(1.0 / f_mm, 1.0 / f_mm, 0.0)
    cos_a = 1.0 / math.sqrt(1.0 + tan2)
    cos_a = max(cos_a, _COS_INCIDENCE_FLOOR)
    p_t = 1.0 / (f_mm * cos_a)   # tangential (in the plane of incidence)
    p_s = cos_a / f_mm           # sagittal
    return q_power_tensor(p_t, p_s, math.atan2(theta_z, theta_y))


def _lens_power_factor(ray_in: BeamRay, ctx: AnchorOpContext) -> float:
    """Combined power transmission of the lens: clear-aperture clipping ×
    coating transmittance. ``ray_in`` is already propagated to the hit, so
    its qx/qy give the spot at the lens. Returns 1.0 when no aperture is
    defined (``anchor.aperture_mm`` ≤ 0).

    Beam decenter: when the chief ray hits the lens off the optical axis
    (``hit.offset_y/z``) the Gaussian is clipped asymmetrically, so we feed
    the radial decenter ``r_c`` into the aperture fraction — the on-axis
    closed form would over-state how much power survives a misaligned beam.
    """
    wl = ray_in.wavelength_nm
    wx = gaussian_width_mm(ray_in.qx, wl)
    wy = gaussian_width_mm(ray_in.qy, wl)
    w_eff = (wx * wy) ** 0.5
    r_c = math.hypot(ctx.hit.offset_y_body, ctx.hit.offset_z_body)
    t_ap = gaussian_circular_aperture_fraction(w_eff, ctx.anchor.aperture_mm, r_c)
    transmittance = float(ctx.params.get("transmittance", 1.0))
    return t_ap * transmittance


def _tilt_astig_focals(
    f_mm: float, theta_y: float, theta_z: float,
) -> tuple[float, float]:
    """Per-axis effective focal lengths ``(f_y, f_z)`` for a thin lens hit at
    oblique incidence — i.e. when the beam axis is tilted relative to the
    lens optical axis (anchor axisX).

    A tilt by angle α splits the focal length into the tangential
    ``f·cos α`` (in the plane of incidence) and sagittal ``f/cos α``
    (perpendicular) — the standard thin-lens astigmatism of a tilted lens.
    ``theta_y``/``theta_z`` are the beam-direction slopes onto axisY/axisZ
    (tan α = √(θ_y²+θ_z²)); the incidence plane sits at azimuth
    φ = atan2(θ_z, θ_y) in the (axisY, axisZ) frame. We rotate the focusing-
    power tensor diag(1/f_t, 1/f_s) into that frame and keep the DIAGONAL
    terms 1/f_y, 1/f_z (qx ↔ axisY plane, qy ↔ axisZ plane).

    Limitation: the off-diagonal cross-astigmatism term (non-zero for a tilt
    not aligned with a principal axis, e.g. φ≈45°) is dropped — the q-tracer
    carries qx/qy independently and cannot represent a rotated astigmatism
    axis. Reduces exactly to (f, f) at normal incidence. Thick-lens and
    cylindrical paths are NOT corrected (see docs/introduce/optics.md).
    """
    tan2 = theta_y * theta_y + theta_z * theta_z
    if tan2 < 1e-15:
        return f_mm, f_mm
    cos_a = 1.0 / math.sqrt(1.0 + tan2)  # tan α = √tan2 ⇒ cos α = 1/√(1+tan²α)
    # The thin-lens cos α split is only meaningful for modest tilts; beyond
    # ~60° the approximation breaks down and a near-grazing hit would collapse
    # f·cos α → 0. Floor cos α so the focal split is capped at [0.5f, 2f]
    # rather than diverging (mirrors beam_ray's _NONPARAXIAL_S_FLOOR pattern).
    cos_a = max(cos_a, _COS_INCIDENCE_FLOOR)
    p_t = 1.0 / (f_mm * cos_a)           # tangential focusing power 1/f_t
    p_s = cos_a / f_mm                   # sagittal focusing power 1/f_s
    c2 = theta_y * theta_y / tan2        # cos²φ
    s2 = theta_z * theta_z / tan2        # sin²φ
    p_yy = p_t * c2 + p_s * s2
    p_zz = p_t * s2 + p_s * c2
    return 1.0 / p_yy, 1.0 / p_zz


def _is_thick(params: dict) -> bool:
    """Thick-lens model when the asset carries surface curvature + glass."""
    return (
        params.get("radiusFrontMm") is not None
        and params.get("refractiveIndex") is not None
        and params.get("centerThicknessMm") is not None
    )


def lens_anchor_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    if ctx.anchor.id != "intercept_in":
        return [ray_in]

    y, theta_y, z, theta_z = beam_state_from_anchor_hit(ray_in, ctx.hit)
    power_out = ray_in.power_mw * _lens_power_factor(ray_in, ctx)

    if _is_thick(ctx.params):
        # Full thick-lens ABCD (both surfaces + glass slab), air→air.
        n = float(ctx.params["refractiveIndex"])
        d_mm = float(ctx.params["centerThicknessMm"])
        a, b, c, dd = _thick_lens_abcd(
            ctx.params.get("radiusFrontMm"), ctx.params.get("radiusBackMm"),
            n, d_mm,
        )
        y_out, ty_out, z_out, tz_out = apply_abcd_state(
            y, theta_y, z, theta_z, a, b, c, dd,
        )
        out_ray = out_ray_from_state(
            ray_in, ctx.anchor, y_out, ty_out, z_out, tz_out,
            flip_propagation=False,
        )
        # The ABCD maps front-vertex plane → back-vertex plane; emit the ray
        # at the back vertex = front vertex (anchor) + d along the (signed)
        # optical axis, so the focus lands at back_vertex + BFL.
        ax = ctx.anchor.axis_x_body
        inc_dot = (
            ray_in.direction.x * ax.x + ray_in.direction.y * ax.y
            + ray_in.direction.z * ax.z
        )
        out_sign = 1.0 if inc_dot >= 0 else -1.0
        back_origin = Vec3(
            out_ray.origin.x + ax.x * d_mm * out_sign,
            out_ray.origin.y + ax.y * d_mm * out_sign,
            out_ray.origin.z + ax.z * d_mm * out_sign,
        )
        # Rotationally symmetric blocks: frame-independent, but routed through
        # the matrix law so an incoming off-diagonal propagates correctly.
        q_thick = q_matrix_after_abcd(
            ray_in.q_matrix, Mat2.scalar(complex(a)), Mat2.scalar(complex(b)),
            Mat2.scalar(complex(c)), Mat2.scalar(complex(dd)),
        )
        return [out_ray.replaced(
            origin=back_origin,
            qx=q_thick.xx, qy=q_thick.yy, qxy=q_thick.xy,
            power_mw=power_out,
            path_length_mm=ray_in.path_length_mm + d_mm,
        )]

    # Thin lens (fallback). At oblique incidence the lens is astigmatic: the
    # focal length splits per transverse axis (f_y for axisY/qx, f_z for
    # axisZ/qy). At normal incidence f_y = f_z = f, so this is a no-op for a
    # head-on beam and keeps the symmetric behaviour.
    f_mm = float(ctx.params.get("focalLengthMm", 100.0))
    f_y, f_z = _tilt_astig_focals(f_mm, theta_y, theta_z)
    out_ray = out_ray_from_state(
        ray_in, ctx.anchor,
        y=y, theta_y=theta_y - y / f_y,
        z=z, theta_z=theta_z - z / f_z,
        flip_propagation=False,
    )
    # Q lives in the beam-local frame; the lens' power tensor lives in its own
    # (axisY, axisZ) frame. Rotate in, apply, rotate back -- this is what makes
    # a lens rolled about the optical axis behave correctly.
    q_in = q_beam_to_axis(ray_in.q_matrix, ctx.anchor.axis_y_body, ray_in.direction)
    q_out = q_after_thin_element(
        q_in, _tilt_astig_power_tensor(f_mm, theta_y, theta_z),
    )
    q_out = q_axis_to_beam(q_out, ctx.anchor.axis_y_body, ray_in.direction)
    return [out_ray.replaced(
        qx=q_out.xx, qy=q_out.yy, qxy=q_out.xy,
        power_mw=power_out,
    )]


def lens_cylindrical_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    """Cylindrical lens — focuses one transverse axis, passes the other.

    Orientation is GEOMETRIC, carried by the intercept_in anchor frame, NOT a
    param: axisY = power (curved) axis, axisZ = cylinder line (no power) — both
    ⊥ axisX (optical axis) by construction. Re-orient by rotating the anchor's
    axisY/axisZ about axisX. The old ``cylindricalAxis`` string was retired
    (2026-06-12) as a redundant second source of truth; this op never read it.
    """
    if ctx.anchor.id != "intercept_in":
        return [ray_in]

    y, theta_y, z, theta_z = beam_state_from_anchor_hit(ray_in, ctx.hit)
    fy_mm = float(ctx.params.get("focalLengthMm", 100.0))
    # axisY is the focusing axis; axisZ pass-through.
    out_ray = out_ray_from_state(
        ray_in, ctx.anchor,
        y=y, theta_y=theta_y - y / fy_mm,
        z=z, theta_z=theta_z,
        flip_propagation=False,
    )
    q_in = q_beam_to_axis(ray_in.q_matrix, ctx.anchor.axis_y_body, ray_in.direction)
    q_out = q_after_thin_element(q_in, q_power_tensor(1.0 / fy_mm, 0.0, 0.0))
    q_out = q_axis_to_beam(q_out, ctx.anchor.axis_y_body, ray_in.direction)
    return [out_ray.replaced(
        qx=q_out.xx, qy=q_out.yy, qxy=q_out.xy,
        power_mw=ray_in.power_mw * _lens_power_factor(ray_in, ctx),
    )]


register_anchor_op("lens", lens_anchor_op)
register_anchor_op("lens_biconvex", lens_anchor_op)
register_anchor_op("lens_plano_convex", lens_anchor_op)
register_anchor_op("lens_cylindrical", lens_cylindrical_op)
