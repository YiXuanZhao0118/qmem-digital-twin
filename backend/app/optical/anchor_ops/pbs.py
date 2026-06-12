"""PBS / beam_splitter anchor op (Phase 9.4; Glan-Laser added Phase 9.8).

Single primary anchor: ``intercept_face`` at the polarizer's internal
coating / air-gap centre. Shared by:
  - 45° cube PBS (Thorlabs PBS252 etc.) — params ``cubeSizeMm`` + ``refractiveIndex``.
  - Glan-Laser air-gap polarizer (Thorlabs IO-3/IO-5) — params
    ``lengthMm`` + ``refractiveIndex_e``/``refractiveIndex_o``.
  axisX = coating normal (the surface the beam reflects off in s)
  axisY = s-polarisation reference axis (in coating plane)
  axisZ = p-polarisation reference axis (= axisX × axisY)

Physics — two branches per hit. With ideal extinction the p-branch is pure p
and the s-branch pure s; finite extinction leaks the rejected component into
each port (params ``extinctionRatioPpDb`` for the transmitted/P port,
``extinctionRatioSpDb`` for the reflected/S port — see ``_extinction_atten``):
  p-branch (transmit_p):
    - jones = (√att_p·E_s, √(1−att_s)·E_p); power = |jones_p|² × |E_in|²⁻¹
    - Slab ABCD (cube length / refractiveIndex)
    - Output direction = ray.direction (straight through)
  s-branch (reflect_s):
    - jones = (√(1−att_p)·E_s, √att_s·E_p); power = |jones_s|² × |E_in|²⁻¹
    - Slab ABCD
    - Output direction = mirror reflect on axisX:
        d_out = d_in − 2 (d_in · axisX) · axisX
  Energy-conserving: t_p + t_s = 1 (the leak redistributes, not adds). att=0
  (no spec) ⇒ the original pure-p / pure-s split.

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
from app.optical.jones import beam_local_sp, jones_rotation_angle, rotate_jones


def _glan_frame_phi(direction: Vec3, axis_x: Vec3) -> float | None:
    """Signed angle (rad) from the beam-local s-axis to the polarizer's own
    plane-of-incidence s-axis (``dir × axisX``), about the propagation
    direction. ``axisX`` is the coating / cut normal, so ``dir × axisX`` is
    perpendicular to the plane of incidence — the reflected (o-ray) s-pol.

    Returns None at near-normal incidence (beam ∥ axisX), where the plane of
    incidence is undefined; callers then keep the raw beam-local jones.

    Why: the split MUST be referenced to the polarizer's physical clock angle.
    A standard horizontal PBS has ``dir × axisX`` ≈ beam-local s (phi≈0, no
    change), but an isolator's OUTPUT Glan is rotated ~45° about the beam vs
    the input Glan — so the two prisms must split on DIFFERENT axes. The old
    code used the world-up beam-local frame for both, so the output prism
    transmitted the Faraday-rotated component it should have reflected.
    """
    s_g = Vec3(
        direction.y * axis_x.z - direction.z * axis_x.y,
        direction.z * axis_x.x - direction.x * axis_x.z,
        direction.x * axis_x.y - direction.y * axis_x.x,
    )
    if s_g.x * s_g.x + s_g.y * s_g.y + s_g.z * s_g.z < 1e-9:
        return None
    s_g = s_g.normalized()
    s_bl, _ = beam_local_sp(direction)
    return jones_rotation_angle(s_bl, s_g, direction)


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


def _extinction_atten(er_db: object) -> float:
    """Power fraction of the REJECTED polarization that still leaks through a
    port, from that port's extinction ratio in dB (``att = 10**(-ER/10)``,
    same convention as the polarizer op). Missing / non-positive ⇒ 0.0 = an
    ideal split, so a plain PBS cube without a Glan-Laser spec keeps the
    perfect p-transmit / s-reflect behaviour."""
    if not isinstance(er_db, (int, float)) or er_db <= 0:
        return 0.0
    return 10.0 ** (-float(er_db) / 10.0)


def _pick_index(params: dict, keys: tuple[str, ...]) -> float:
    """First positive index among ``keys``, else the BK7 fallback. Lets the
    slab use the index the relevant ray actually sees (per branch below)."""
    for key in keys:
        v = params.get(key)
        if isinstance(v, (int, float)) and v > 0:
            return float(v)
    return 1.5168  # BK7 default


# Per-branch slab index. A PBS cube sets the isotropic ``refractiveIndex`` and
# both branches fall back to it (unchanged). A Glan-Laser calcite prism is
# birefringent: the TRANSMITTED beam is the extraordinary ray (sees n_e =
# ``refractiveIndex_e``); the rejected/reflected beam is the ordinary ray (sees
# n_o = ``refractiveIndex_o``).
_TRANSMIT_INDEX_KEYS = ("refractiveIndex", "refractiveIndex_e")
_REFLECT_INDEX_KEYS = ("refractiveIndex", "refractiveIndex_o")


def pbs_anchor_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    if ctx.anchor.id != "intercept_face":
        return [ray_in]

    y, theta_y, z, theta_z = beam_state_from_anchor_hit(ray_in, ctx.hit)
    cube_size = _pick_length_mm(ctx.params)
    # Transmitted (e-ray) and reflected (o-ray) branches use their own slab
    # index; isotropic PBS cubes get the same value for both.
    L_over_n_p = cube_size / _pick_index(ctx.params, _TRANSMIT_INDEX_KEYS)
    L_over_n_s = cube_size / _pick_index(ctx.params, _REFLECT_INDEX_KEYS)

    # Split in the polarizer's OWN plane-of-incidence frame (s = dir × axisX),
    # not the world-up beam-local frame, so the split tracks the prism's
    # physical clock angle (see _glan_frame_phi). Rotate the incoming Jones
    # into that frame; jones[0] then = the reflected (s) component, jones[1] =
    # the transmitted (p) component. Outputs are rotated back to beam-local
    # below for downstream propagation. mag is rotation-invariant.
    phi = _glan_frame_phi(ray_in.direction, ctx.anchor.axis_x_body)
    e_s, e_p = rotate_jones(ray_in.jones, phi) if phi is not None else ray_in.jones
    mag_in = _jones_mag2(ray_in.jones)

    # Finite extinction (Glan-Laser spec). att_p / att_s are the power fractions
    # of the WRONG polarization that leak into each port. The split stays
    # energy-conserving: every polarization's two output fractions sum to 1
    # (kept-in-correct-port + leaked-into-other = 1):
    #   transmitted (p) port: keeps (1-att_s)·E_p, leaks att_p·E_s
    #   reflected   (s) port: keeps (1-att_p)·E_s, leaks att_s·E_p
    # Pp governs the transmitted (P) port's s-leak; Sp the reflected (S) port's
    # p-leak. att=0 (no spec / plain cube) reproduces the ideal pure-p/pure-s
    # split, so existing assets without these keys are unchanged.
    att_p = _extinction_atten(ctx.params.get("extinctionRatioPpDb"))
    att_s = _extinction_atten(ctx.params.get("extinctionRatioSpDb"))
    jones_p = (e_s * math.sqrt(att_p), e_p * math.sqrt(1.0 - att_s))
    jones_s = (e_s * math.sqrt(1.0 - att_p), e_p * math.sqrt(att_s))
    t_p = _jones_mag2(jones_p) / mag_in if mag_in > 1e-30 else 0.0
    t_s = _jones_mag2(jones_s) / mag_in if mag_in > 1e-30 else 0.0
    # Rotate the two output Jones back into the beam-local frame (inverse of
    # the plane-of-incidence rotation) so downstream segments read them in the
    # frame the solver carries.
    if phi is not None:
        jones_p = rotate_jones(jones_p, -phi)
        jones_s = rotate_jones(jones_s, -phi)

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
        jones=jones_p,  # full p + extinction-suppressed s leak
        power_mw=ray_in.power_mw * t_p,
        qx=complex(ray_in.qx.real + L_over_n_p, ray_in.qx.imag),
        qy=complex(ray_in.qy.real + L_over_n_p, ray_in.qy.imag),
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
        jones=jones_s,  # full s + extinction-suppressed p leak
        power_mw=ray_in.power_mw * t_s,
        qx=complex(ray_in.qx.real + L_over_n_s, ray_in.qx.imag),
        qy=complex(ray_in.qy.real + L_over_n_s, ray_in.qy.imag),
        path_length_mm=ray_in.path_length_mm + cube_size,
    )

    return [out_p, out_s]


register_anchor_op("pbs", pbs_anchor_op)
register_anchor_op("beam_splitter", pbs_anchor_op)
