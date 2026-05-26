"""PBS / beam_splitter anchor op (Phase 9.4).

Single primary anchor: ``coating_plane`` at the cube's internal Brewster
plate centre.
  axisX = coating normal (the surface the beam reflects off in s)
  axisY = s-polarisation reference axis (in coating plane)
  axisZ = p-polarisation reference axis (= axisX × axisY)

Physics — two branches per hit:
  p-branch (transmit_p):
    - Project jones onto axisZ (p axis); power = |E_p|² × |E_in|²⁻¹
    - Slab ABCD (cube length / refractiveIndex)
    - Output direction = ray.direction (straight through)
  s-branch (reflect_s):
    - Project jones onto axisY (s axis); power = |E_s|² × |E_in|²⁻¹
    - Slab ABCD
    - Output direction = mirror reflect on axisX:
        d_out = d_in − 2 (d_in · axisX) · axisX

Both branches' rays start at the coating_plane anchor and propagate
forward; the renderer joins them to whichever port they exit through.

Returns two rays (one per branch); near-zero-power ones get terminated
upstream by the threshold check.
"""

from __future__ import annotations

import math

from app.optical.anchor_tracer import (
    AnchorOpContext,
    apply_slab_state,
    beam_state_from_anchor_hit,
    out_ray_from_state,
    register_anchor_op,
)
from app.optical.beam_ray import BeamRay, Vec3


def _jones_mag2_component(j: tuple[complex, complex], idx: int) -> float:
    e = j[idx]
    return e.real * e.real + e.imag * e.imag


def _jones_mag2(j: tuple[complex, complex]) -> float:
    return _jones_mag2_component(j, 0) + _jones_mag2_component(j, 1)


def pbs_anchor_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    if ctx.anchor.id != "coating_plane":
        return [ray_in]

    y, theta_y, z, theta_z = beam_state_from_anchor_hit(ray_in, ctx.hit)
    cube_size = float(ctx.params.get("cubeSizeMm", 25.4))
    n_index = float(ctx.params.get("refractiveIndex", 1.5168))
    L_over_n = cube_size / n_index

    mag_in = _jones_mag2(ray_in.jones)

    # In anchor local basis, jones[0] aligns with axisY (s) and jones[1]
    # aligns with axisZ (p). Convention: backfill placed axisY = s-pol.
    mag_s = _jones_mag2_component(ray_in.jones, 0)
    mag_p = _jones_mag2_component(ray_in.jones, 1)
    t_p = mag_p / mag_in if mag_in > 1e-30 else 0.0
    t_s = mag_s / mag_in if mag_in > 1e-30 else 0.0

    # ── p branch (transmit) ─────────────────────────────────────────
    # Direction preserved (straight through the cube). Origin shifts
    # past the coating by cube_size along the incoming direction —
    # paraxial approx; full beam-path is cube_size / cos(incidence) but
    # for 45° cube and near-axial rays it's within a few %.
    out_p_origin = Vec3(
        ctx.hit.hit_point_body.x + cube_size * ray_in.direction.x,
        ctx.hit.hit_point_body.y + cube_size * ray_in.direction.y,
        ctx.hit.hit_point_body.z + cube_size * ray_in.direction.z,
    )
    out_p = ray_in.replaced(
        origin=out_p_origin,
        direction=ray_in.direction,
        jones=(complex(0, 0), ray_in.jones[1]),  # pure p
        power_mw=ray_in.power_mw * t_p,
        qx=complex(ray_in.qx.real + L_over_n, ray_in.qx.imag),
        qy=complex(ray_in.qy.real + L_over_n, ray_in.qy.imag),
        path_length_mm=ray_in.path_length_mm + cube_size,
    )

    # ── s branch (reflect) ──────────────────────────────────────────
    # Mirror formula on axisX in body frame.
    n_x = ctx.anchor.axis_x_body
    d_in = ray_in.direction
    dot = d_in.dot(n_x)
    refl_dir = Vec3(
        d_in.x - 2 * dot * n_x.x,
        d_in.y - 2 * dot * n_x.y,
        d_in.z - 2 * dot * n_x.z,
    )
    out_s_origin = ctx.hit.hit_point_body
    out_s = ray_in.replaced(
        origin=out_s_origin,
        direction=refl_dir,
        jones=(ray_in.jones[0], complex(0, 0)),  # pure s
        power_mw=ray_in.power_mw * t_s,
        qx=complex(ray_in.qx.real + L_over_n, ray_in.qx.imag),
        qy=complex(ray_in.qy.real + L_over_n, ray_in.qy.imag),
        path_length_mm=ray_in.path_length_mm + cube_size,
    )

    return [out_p, out_s]


register_anchor_op("pbs", pbs_anchor_op)
register_anchor_op("beam_splitter", pbs_anchor_op)
