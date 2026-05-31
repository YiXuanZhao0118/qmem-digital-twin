"""PBS / beam_splitter anchor op (Phase 9.4; Glan-Laser added Phase 9.8).

Single primary anchor: ``intercept_face`` at the polarizer's internal
coating / air-gap centre. Shared by:
  - 45° cube PBS (Thorlabs PBS252 etc.) — params ``cubeSizeMm`` + ``refractiveIndex``.
  - Glan-Laser air-gap polarizer (Thorlabs IO-3/IO-5) — params
    ``lengthMm`` + ``refractiveIndex_e``/``refractiveIndex_o``.
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


def _pick_length_mm(params: dict) -> float:
    """Length of the polarizer body along the beam axis.
      - PBS cube: ``cubeSizeMm`` (BK7 cube edge).
      - Glan-Laser / calcite air-gap polarizer: ``lengthMm`` (calcite
        prism length; the cube param doesn't apply).
    Falls back to a 1-inch cube when neither is set."""
    for key in ("cubeSizeMm", "lengthMm"):
        v = params.get(key)
        if isinstance(v, (int, float)) and v > 0:
            return float(v)
    return 25.4


def _pick_refractive_index(params: dict) -> float:
    """Effective refractive index used for the ABCD slab propagation
    L/n. For PBS cubes it's the isotropic glass index; for Glan-Laser
    calcite we use the ordinary index (s-ray bulk medium) — the
    extraordinary index governs the actual air-gap reflection condition
    but the bulk-propagation slab is dominated by the o-ray geometry."""
    n = params.get("refractiveIndex")
    if isinstance(n, (int, float)) and n > 0:
        return float(n)
    n_o = params.get("refractiveIndex_o")
    if isinstance(n_o, (int, float)) and n_o > 0:
        return float(n_o)
    return 1.5168  # BK7 default


def pbs_anchor_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    if ctx.anchor.id != "intercept_face":
        return [ray_in]

    y, theta_y, z, theta_z = beam_state_from_anchor_hit(ray_in, ctx.hit)
    cube_size = _pick_length_mm(ctx.params)
    n_index = _pick_refractive_index(ctx.params)
    L_over_n = cube_size / n_index

    mag_in = _jones_mag2(ray_in.jones)

    # In anchor local basis, jones[0] aligns with axisY (s) and jones[1]
    # aligns with axisZ (p). Convention: backfill placed axisY = s-pol.
    mag_s = _jones_mag2_component(ray_in.jones, 0)
    mag_p = _jones_mag2_component(ray_in.jones, 1)
    t_p = mag_p / mag_in if mag_in > 1e-30 else 0.0
    t_s = mag_s / mag_in if mag_in > 1e-30 else 0.0

    # ── p branch (transmit) ─────────────────────────────────────────
    # Direction preserved (straight through the cube). Origin = the coating
    # hit point — the SAME start as the reflected branch — so the
    # transmitted beam renders as ONE continuous line through the optic.
    # (Previously the origin was shifted +cube_size past the coating, which
    # left a cube-length gap in the drawn beam between the entry coating and
    # the exit face — visible as the beam "disappearing" through the PBS /
    # glan.) The glass slab is still modelled in the beam state below
    # (qx/qy += L/n, path_length += cube_size); only the render origin moves.
    # The tracer's t_min guard (intersect_anchor) drops the t≈0 self-hit, so
    # starting on the coating plane does not re-trigger this anchor.
    out_p_origin = ctx.hit.hit_point_body
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
