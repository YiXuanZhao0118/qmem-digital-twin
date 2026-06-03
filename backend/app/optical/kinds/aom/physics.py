"""AOM v3 PhysicsOp (Python mirror of frontend kinds/aom-v3/physics.ts).

Op name: diffract_aom
Kind: aom
Canonical v3 two-port layout is physical faces A/B. Directed transitions
A -> B and B -> A encode opposite frequency/side branches unless
transition params explicitly set order. Older A1/B1/A2/B2 catalog rows
and legacy B0/B+1/B-1 out faces are still accepted.
"""

from __future__ import annotations

import math
import re
from typing import Optional

from app.optical.aom_physics import (
    bragg_detuning_sinc2,
    first_order_efficiency,
    order_efficiency,
)
from app.optical.beam_ray import BeamRay, Vec3, vec3_distance
from app.optical.registry import (
    KindEntry,
    PhysicsOpContext,
    register_kind,
)


def _apply_abcd_to_q(A: float, B: float, C: float, D: float, q: complex) -> complex:
    return (A * q + B) / (C * q + D)


_FACE_ID_PATTERN = re.compile(r"^B([+-]?\d+)$")
RF_LOAD_Z_OHM = 50.0


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _finite_number(value) -> Optional[float]:
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return None


def _positive_finite_number(value) -> Optional[float]:
    n = _finite_number(value)
    if n is not None and n > 0:
        return n
    return None


def _vec_dot(a: Vec3, b: Vec3) -> float:
    return a.x * b.x + a.y * b.y + a.z * b.z


def _vec_len(a: Vec3) -> float:
    return math.sqrt(_vec_dot(a, a))


def _vec_norm(a: Vec3) -> Vec3:
    n = _vec_len(a)
    if n < 1e-15:
        return Vec3(1, 0, 0)
    return Vec3(a.x / n, a.y / n, a.z / n)


def _read_vec3(value) -> Optional[Vec3]:
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        x, y, z = value[:3]
    elif isinstance(value, dict):
        x, y, z = value.get("x"), value.get("y"), value.get("z")
    else:
        return None
    if all(isinstance(v, (int, float)) and math.isfinite(float(v)) for v in (x, y, z)):
        return Vec3(float(x), float(y), float(z))
    return None


def _transition_optical_axis(ctx: PhysicsOpContext) -> Vec3:
    if ctx.face_out.normal_body_local is not None:
        return _vec_norm(ctx.face_out.normal_body_local)
    return _vec_norm(Vec3(
        ctx.face_out.position_mm_body_local.x - ctx.face_in.position_mm_body_local.x,
        ctx.face_out.position_mm_body_local.y - ctx.face_in.position_mm_body_local.y,
        ctx.face_out.position_mm_body_local.z - ctx.face_in.position_mm_body_local.z,
    ))


def _read_rf_direction_body_local(ctx: PhysicsOpContext) -> Vec3:
    dynamic = ctx.dynamic or {}
    raw_rf_dir = (
        _read_vec3(dynamic.get("rfPropagationDirectionBodyLocal"))
        or _read_vec3(dynamic.get("acousticAxisBodyLocal"))
        or _read_vec3(ctx.params.get("rfPropagationDirectionBodyLocal"))
        or _read_vec3(ctx.params.get("acousticAxisBodyLocal"))
        or Vec3(1, 0, 0)
    )
    rf_len = _vec_len(raw_rf_dir)
    if rf_len < 1e-15:
        raise ValueError("AOM rfPropagationDirectionBodyLocal must be a non-zero vector")
    rf_dir = Vec3(raw_rf_dir.x / rf_len, raw_rf_dir.y / rf_len, raw_rf_dir.z / rf_len)
    optical_axis = _transition_optical_axis(ctx)
    dot = _vec_dot(rf_dir, optical_axis)
    if abs(dot) > 1e-6:
        raise ValueError(
            "AOM rfPropagationDirectionBodyLocal must be perpendicular "
            f"to the A->B optical axis; dot={dot}"
        )
    return rf_dir


def _first_defined(*values: Optional[float]) -> Optional[float]:
    for value in values:
        if value is not None:
            return value
    return None


def _vpp_to_power_w(vpp: float, z_ohm: float = RF_LOAD_Z_OHM) -> float:
    return (vpp * vpp) / (8.0 * z_ohm)


def _dbm_to_w(dbm: float) -> float:
    return 10.0 ** ((dbm - 30.0) / 10.0)


def _read_rf_frequency_mhz(ctx: PhysicsOpContext) -> float:
    dynamic = ctx.dynamic or {}
    return (
        _positive_finite_number(dynamic.get("aomFreqMhz"))
        or _positive_finite_number(dynamic.get("rfFrequencyMhz"))
        or _positive_finite_number(dynamic.get("aomRfFreqMhz"))
        or _positive_finite_number(ctx.params.get("aomFreqMhz"))
        or _positive_finite_number(ctx.params.get("centerFreqMhz"))
        or 80.0
    )


def _read_rf_drive_power_w(ctx: PhysicsOpContext) -> Optional[float]:
    dynamic = ctx.dynamic or {}
    p = _first_defined(
        _finite_number(dynamic.get("rfDrivePowerW")),
        _finite_number(dynamic.get("aomRfPowerW")),
        _finite_number(ctx.params.get("rfDrivePowerW")),
        _finite_number(ctx.params.get("aomRfPowerW")),
    )
    vpp = _first_defined(
        _positive_finite_number(dynamic.get("aomRfVpp")),
        _positive_finite_number(dynamic.get("rfVpp")),
        _positive_finite_number(ctx.params.get("aomRfVpp")),
        _positive_finite_number(ctx.params.get("rfVpp")),
    )
    if p is None and vpp is not None:
        p = _vpp_to_power_w(vpp)
    dbm = _first_defined(
        _finite_number(dynamic.get("aomRfPowerDbm")),
        _finite_number(dynamic.get("rfPowerDbm")),
        _finite_number(ctx.params.get("aomRfPowerDbm")),
        _finite_number(ctx.params.get("rfPowerDbm")),
    )
    if p is None and dbm is not None:
        p = _dbm_to_w(dbm)
    if p is None or not math.isfinite(p) or p < 0:
        return None
    max_w = _positive_finite_number(ctx.params.get("rfPowerMaxW"))
    return min(p, max_w) if max_w is not None else p


def parse_order_from_face_id(face_id: str) -> int:
    m = _FACE_ID_PATTERN.match(face_id)
    if not m:
        raise ValueError(
            f'AOM diffract_aom: face_out.id must match B[+/-n], got "{face_id}"'
        )
    return int(m.group(1))


def order_from_context(ctx: PhysicsOpContext) -> int:
    explicit = _first_defined(
        _finite_number(ctx.params.get("order")),
        _finite_number(ctx.params.get("diffractionOrder")),
    )
    if explicit is not None:
        return int(explicit)
    if ctx.face_in.id == "A" and ctx.face_out.id == "B":
        return 1
    if ctx.face_in.id == "B" and ctx.face_out.id == "A":
        return -1
    if ctx.face_in.id == "A1" and ctx.face_out.id == "B1":
        return 1
    if ctx.face_in.id == "A2" and ctx.face_out.id == "B2":
        return -1
    return parse_order_from_face_id(ctx.face_out.id)


def bragg_angle_rad(
    wavelength_nm: float,
    freq_mhz: float,
    acoustic_velocity_mps: float,
    refractive_index: float | None = None,
) -> float:
    """asin(lambda * f / (2 * v)) with lambda in nm -> m and f in MHz -> Hz."""
    lambda_m = wavelength_nm * 1e-9
    f_hz = freq_mhz * 1e6
    _ = refractive_index
    arg = (lambda_m * f_hz) / (2 * acoustic_velocity_mps)
    return math.asin(max(-1.0, min(1.0, arg)))


def _deflect_along_rf_side(input_dir: Vec3, rf_dir: Vec3, deflect_rad: float) -> Vec3:
    in_dir = _vec_norm(input_dir)
    dot = _vec_dot(rf_dir, in_dir)
    rf_transverse = Vec3(
        rf_dir.x - in_dir.x * dot,
        rf_dir.y - in_dir.y * dot,
        rf_dir.z - in_dir.z * dot,
    )
    side = _vec_norm(rf_transverse)
    return _vec_norm(Vec3(
        in_dir.x * math.cos(deflect_rad) + side.x * math.sin(deflect_rad),
        in_dir.y * math.cos(deflect_rad) + side.y * math.sin(deflect_rad),
        in_dir.z * math.cos(deflect_rad) + side.z * math.sin(deflect_rad),
    ))


def _angle_to_axis_rad(direction: Vec3, axis: Vec3) -> float:
    """Unsigned angle between a ray direction and the optical axis."""
    d = _vec_norm(direction)
    a = _vec_norm(axis)
    return math.acos(max(-1.0, min(1.0, _vec_dot(d, a))))


def bragg_detuning_factor(
    ray_in: BeamRay,
    ctx: PhysicsOpContext,
    freq_mhz: float,
    v_acoustic: float,
    n: float,
    l_mm: float,
) -> float:
    """sinc^2 Bragg phase-matching factor for off-axis incidence.

    Thick-grating coupled-wave theory: efficiency scales as sinc^2(dk*L/2),
    where dk is the longitudinal wave-vector mismatch produced by deviating
    from the matched incidence angle. We treat the canonical on-axis input
    (ray along the A->B optical axis) as perfectly matched, so a ray arriving
    at external angle dtheta_ext to that axis sees:

        K       = 2*pi*f / v                 (acoustic grating vector, 1/m)
        theta_B = asin(lambda*f / (2*n*v))   (internal Bragg angle)
        dk      = K * cos(theta_B) * (dtheta_ext / n)   (Snell to internal)
        xi      = dk * L / 2
        factor  = (sin xi / xi)^2            (-> 1 as xi -> 0)

    On-axis input (dtheta_ext = 0) returns 1.0 exactly.
    """
    dtheta_ext = _angle_to_axis_rad(ray_in.direction, _transition_optical_axis(ctx))
    return bragg_detuning_sinc2(
        dtheta_ext, ray_in.wavelength_nm, freq_mhz, v_acoustic, n, l_mm,
    )


def bragg_acceptance_mrad(freq_mhz: float, v_acoustic: float, n: float, l_mm: float) -> float:
    """External half-width to the first sinc^2 null (xi = pi), in mrad.

    Solving xi = dk*L/2 = pi with dk = K*(dtheta_ext/n) (cos(theta_B)~1):
        dtheta_ext = n * v / (f * L)
    """
    f_hz = freq_mhz * 1e6
    l_m = l_mm * 1e-3
    return (n * v_acoustic / (f_hz * l_m)) * 1e3


def first_order_efficiency_from_context(
    ray_in: BeamRay,
    ctx: PhysicsOpContext,
    theta_b_rad: float,
) -> float:
    # Delegate the closed-form to the shared module (single source of truth,
    # also used by the production anchor op); read RF power with this op's ctx.
    return first_order_efficiency(
        ray_in.wavelength_nm, theta_b_rad,
        rf_power_w=_read_rf_drive_power_w(ctx),
        m2=_positive_finite_number(ctx.params.get("figureOfMeritM2")),
        l_mm=_positive_finite_number(ctx.params.get("crystalLengthMm")),
        w_mm=_positive_finite_number(ctx.params.get("acousticBeamWidthMm")),
        base_efficiency=_finite_number(ctx.params.get("baseEfficiency")),
        requires_rf_drive=ctx.params.get("requiresRfDrive") is True,
    )


def diffract_aom_op(ray_in: BeamRay, ctx: PhysicsOpContext) -> list[BeamRay]:
    order = order_from_context(ctx)

    freq_mhz = _read_rf_frequency_mhz(ctx)
    v_acoustic = (
        _positive_finite_number(ctx.params.get("acousticVelocityMps"))
        or _positive_finite_number(ctx.params.get("acousticVelocityMPerS"))
        or 4200.0
    )
    n = _positive_finite_number(ctx.params.get("refractiveIndex")) or 2.26
    L = ctx.params.get("crystalLengthMm")
    if not isinstance(L, (int, float)):
        L = vec3_distance(
            ctx.face_in.position_mm_body_local,
            ctx.face_out.position_mm_body_local,
        )
    L = float(L)

    theta_b = bragg_angle_rad(ray_in.wavelength_nm, freq_mhz, v_acoustic, n)
    deflect_rad = order * 2 * theta_b

    dir_out = _deflect_along_rf_side(
        ray_in.direction,
        _read_rf_direction_body_local(ctx),
        deflect_rad,
    )

    detune = bragg_detuning_factor(ray_in, ctx, freq_mhz, v_acoustic, n, L)
    first_order_eff = first_order_efficiency_from_context(ray_in, ctx, theta_b) * detune
    eff = order_efficiency(order, first_order_eff)
    new_power = ray_in.power_mw * eff

    # Doppler shift: order m diffracts off the f_RF acoustic wave, shifting the
    # optical frequency by m*f_RF. Tracked as an offset on the nominal carrier.
    new_freq_offset_hz = ray_in.freq_offset_hz + order * freq_mhz * 1e6

    b_slab = L / n
    qx_out = _apply_abcd_to_q(1, b_slab, 0, 1, ray_in.qx)
    qy_out = _apply_abcd_to_q(1, b_slab, 0, 1, ray_in.qy)

    new_origin = ctx.face_out.position_mm_body_local
    thickness = vec3_distance(
        ctx.face_in.position_mm_body_local,
        ctx.face_out.position_mm_body_local,
    )

    return [ray_in.replaced(
        origin=new_origin,
        direction=dir_out,
        qx=qx_out,
        qy=qy_out,
        power_mw=new_power,
        path_length_mm=ray_in.path_length_mm + thickness,
        freq_offset_hz=new_freq_offset_hz,
    )]


register_kind("aom", KindEntry(
    ops={"diffract_aom": diffract_aom_op},
    needs_aperture=True,
))
