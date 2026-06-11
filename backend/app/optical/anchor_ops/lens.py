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

from app.optical.anchor_tracer import (
    AnchorOpContext,
    apply_abcd_state,
    apply_thin_lens_state,
    beam_state_from_anchor_hit,
    out_ray_from_state,
    register_anchor_op,
)
from app.optical.aperture import (
    gaussian_circular_aperture_fraction,
    gaussian_width_mm,
)
from app.optical.beam_ray import BeamRay, Vec3


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


def _lens_power_factor(ray_in: BeamRay, ctx: AnchorOpContext) -> float:
    """Combined power transmission of the lens: clear-aperture clipping ×
    coating transmittance. ``ray_in`` is already propagated to the hit, so
    its qx/qy give the spot at the lens. Returns 1.0 when no aperture is
    defined (``anchor.aperture_mm`` ≤ 0)."""
    wl = ray_in.wavelength_nm
    wx = gaussian_width_mm(ray_in.qx, wl)
    wy = gaussian_width_mm(ray_in.qy, wl)
    w_eff = (wx * wy) ** 0.5
    t_ap = gaussian_circular_aperture_fraction(w_eff, ctx.anchor.aperture_mm)
    transmittance = float(ctx.params.get("transmittance", 1.0))
    return t_ap * transmittance


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
        return [out_ray.replaced(
            origin=back_origin,
            qx=_q_after_abcd(ray_in.qx, a, b, c, dd),
            qy=_q_after_abcd(ray_in.qy, a, b, c, dd),
            power_mw=power_out,
            path_length_mm=ray_in.path_length_mm + d_mm,
        )]

    # Thin lens (fallback): focusing on both axes equally.
    f_mm = float(ctx.params.get("focalLengthMm", 100.0))
    y_out, ty_out, z_out, tz_out = apply_thin_lens_state(
        y, theta_y, z, theta_z, f_mm,
    )
    out_ray = out_ray_from_state(
        ray_in, ctx.anchor, y_out, ty_out, z_out, tz_out,
        flip_propagation=False,
    )
    return [out_ray.replaced(
        qx=_q_after_lens(ray_in.qx, f_mm),
        qy=_q_after_lens(ray_in.qy, f_mm),
        power_mw=power_out,
    )]


def lens_cylindrical_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
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
    return [out_ray.replaced(
        qx=_q_after_lens(ray_in.qx, fy_mm),
        power_mw=ray_in.power_mw * _lens_power_factor(ray_in, ctx),
    )]


register_anchor_op("lens", lens_anchor_op)
register_anchor_op("lens_biconvex", lens_anchor_op)
register_anchor_op("lens_plano_convex", lens_anchor_op)
register_anchor_op("lens_cylindrical", lens_cylindrical_op)
