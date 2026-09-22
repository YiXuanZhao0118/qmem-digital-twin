"""Two-mirror coupling — port of ``frontend/src/utils/mirrorCoupling.ts``.

Put mirror A and mirror B where the beam meets each at exactly 45 deg, on
each mirror's centre, and leaves B along a destination port's own axis.
Closed form, nothing iterated; the geometry, the both-beams-touch-both-mirrors
precondition and the distance-not-angle branch choice are explained in
``docs/introduce/mirror-coupling.md`` and in the TS header — read those, this
file only transcribes.

Pure (no DB). Pinned to the TypeScript by
``backend/tests/fixtures/align/mirror_coupling.json``; the warning / failure
strings are part of that pin (``js_to_fixed`` reproduces ``toFixed``).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from app.optical.align.frames import (
    AlignPose,
    scene_object_euler_from_quaternion,
    scene_object_to_quaternion,
)
from app.optical.align.ts_compat import (
    V,
    js_to_fixed,
    q_from_unit_vectors,
    q_multiply,
    v3_apply_quaternion,
    v3_normalize,
    v_add,
    v_cross,
    v_dot,
    v_hypot,
    v_mul,
    v_sub,
)
from app.optical.pose import V3Pose

# The reflective-face anchor every mirror / dichroic_mirror asset carries.
MIRROR_FACE_ANCHOR_ID = "intercept_face"

# Clear-aperture RADIUS when a mirror asset declares none (a 1/2" optic —
# the small end, so a missing aperture makes the touch test stricter).
DEFAULT_MIRROR_APERTURE_MM = 6.35

# |d0 x dT| below this counts as collinear.
COLLINEAR_SIN_EPS = 1e-6

# Beyond this distance the unique branch's answer is off the bench, and the
# free-DOF branch answers instead (mirrorCoupling.ts:91).
MAX_SOLVE_SPAN_MM = 5_000

# Perpendicular offsets below this make the two collinear lines coincide.
MIN_PERP_OFFSET_MM = 1e-3


@dataclass(frozen=True)
class Ray:
    origin: V
    dir: V


@dataclass(frozen=True)
class MirrorFacts:
    """Everything the solver needs about one mirror (TS ``MirrorFacts``)."""

    object_id: str
    name: str
    scene_object: V3Pose
    centre_cad: V
    normal_cad: V
    centre_lab: V
    normal_lab: V
    aperture_mm: float


@dataclass(frozen=True)
class SolveError:
    error: str


def unit_or_null(v: V) -> V | None:
    m = v_hypot(v)
    return None if m < 1e-12 else V(v.x / m, v.y / m, v.z / m)


def _unit_or_throw(v: V) -> V:
    u = unit_or_null(v)
    if u is None:
        raise ValueError("mirrorCoupling: degenerate vector")
    return u


def normalise_ray(r: Ray) -> Ray | None:
    d = unit_or_null(r.dir)
    return Ray(origin=r.origin, dir=d) if d is not None else None


def reflect(d: V, n: V) -> V:
    """Ideal reflection off a plane with unit normal ``n``."""
    return v_sub(d, v_mul(n, 2 * v_dot(d, n)))


# ─── the touch test ────────────────────────────────────────────────────────

@dataclass(frozen=True)
class SpotHit:
    point_lab: V
    decentre_mm: float
    t_mm: float
    in_aperture: bool
    front_side: bool
    aoi_deg: float


def intersect_mirror(ray: Ray, m: MirrorFacts) -> SpotHit | None:
    """A ray meeting a mirror's plane; ``None`` when parallel. ``t`` is signed
    (the backend tracer's ``intersect_anchor`` rejects ``t <= 0`` instead)."""
    n = m.normal_lab
    denom = v_dot(ray.dir, n)
    if abs(denom) < 1e-12:
        return None
    t = v_dot(v_sub(m.centre_lab, ray.origin), n) / denom
    point_lab = v_add(ray.origin, v_mul(ray.dir, t))
    decentre_mm = v_hypot(v_sub(point_lab, m.centre_lab))
    return SpotHit(
        point_lab=point_lab,
        decentre_mm=decentre_mm,
        t_mm=t,
        in_aperture=decentre_mm <= m.aperture_mm + 1e-9,
        front_side=denom < 0,
        aoi_deg=(math.acos(min(1.0, abs(denom))) * 180) / math.pi,
    )


@dataclass(frozen=True)
class TouchMatrix:
    seed_on_a: SpotHit | None
    seed_on_b: SpotHit | None
    target_on_b: SpotHit | None
    target_on_a: SpotHit | None
    ok: bool
    failures: list[str]


def check_mirror_touch(*, in_ray: Ray, target_ray: Ray, a: MirrorFacts, b: MirrorFacts) -> TouchMatrix:
    """The 2x2 precondition at the mirrors' CURRENT poses: the seed hits A
    then B, and the port axis run backwards hits B then A."""
    failures: list[str] = []

    def grade(hit: SpotHit | None, mirror: MirrorFacts, label: str) -> SpotHit | None:
        if hit is None:
            failures.append(f"{label} runs parallel to {mirror.name} — no crossing.")
            return None
        if hit.t_mm <= 0:
            failures.append(f"{label} crosses {mirror.name}'s plane behind its start point.")
        elif not hit.in_aperture:
            failures.append(
                f"{label} misses {mirror.name} by {js_to_fixed(hit.decentre_mm, 1)} mm "
                f"(clear aperture {js_to_fixed(mirror.aperture_mm, 1)} mm radius)."
            )
        return hit

    seed_on_a = grade(intersect_mirror(in_ray, a), a, "Seed beam")
    seed_on_b = None
    if seed_on_a is not None and seed_on_a.t_mm > 0:
        after_a = Ray(origin=seed_on_a.point_lab, dir=reflect(in_ray.dir, a.normal_lab))
        seed_on_b = grade(intersect_mirror(after_a, b), b, "Seed beam after " + a.name)

    reverse = Ray(origin=target_ray.origin, dir=v_mul(target_ray.dir, -1))
    target_on_b = grade(intersect_mirror(reverse, b), b, "Reverse reference ray")
    target_on_a = None
    if target_on_b is not None and target_on_b.t_mm > 0:
        after_b = Ray(origin=target_on_b.point_lab, dir=reflect(reverse.dir, b.normal_lab))
        target_on_a = grade(intersect_mirror(after_b, a), a, "Reverse reference ray after " + b.name)

    def good(h: SpotHit | None) -> bool:
        return h is not None and h.t_mm > 0 and h.in_aperture

    return TouchMatrix(
        seed_on_a=seed_on_a,
        seed_on_b=seed_on_b,
        target_on_b=target_on_b,
        target_on_a=target_on_a,
        ok=good(seed_on_a) and good(seed_on_b) and good(target_on_b) and good(target_on_a),
        failures=failures,
    )


# ─── the geometry solve ────────────────────────────────────────────────────

@dataclass(frozen=True)
class CouplingGeometry:
    d1: V
    centre_a: V
    centre_b: V
    normal_a: V
    normal_b: V
    leg_length_mm: float
    free_dof: bool
    fold_mm: float
    target_standoff_mm: float
    warnings: list[str] = field(default_factory=list)


def _is_finite_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def solve_coupling_geometry(
    *,
    in_ray: Ray,
    target_ray: Ray,
    current_a: V,
    current_b: V,
    fold_mm: float | None = None,
    aperture_a_mm: float | None = None,
    aperture_b_mm: float | None = None,
) -> CouplingGeometry | SolveError:
    """TS ``solveCouplingGeometry``. ``current_a`` / ``current_b`` only pick
    the least-travel default of the free DOF; ``fold_mm`` overrides it (and
    is ignored when the solution is unique)."""
    in_r = normalise_ray(in_ray)
    tgt_r = normalise_ray(target_ray)
    if in_r is None:
        return SolveError("Input beam direction is degenerate.")
    if tgt_r is None:
        return SolveError("Target port declares no usable axis direction.")

    p_in = in_r.origin
    d0 = in_r.dir
    p_t = tgt_r.origin
    d_t = tgt_r.dir

    w = v_sub(p_t, p_in)
    sin_theta = v_hypot(v_cross(d0, d_t))

    warnings: list[str] = []

    unique_span_mm = math.inf
    unique_s = 0.0
    unique_u = 0.0
    if sin_theta > COLLINEAR_SIN_EPS:
        c = v_dot(d0, d_t)
        a = v_dot(w, d0)
        b = v_dot(w, d_t)
        den = 1 - c * c
        unique_s = (a - c * b) / den
        unique_u = (c * a - b) / den
        unique_span_mm = max(abs(unique_s), abs(unique_u))

    if unique_span_mm <= MAX_SOLVE_SPAN_MM:
        centre_a = v_add(p_in, v_mul(d0, unique_s))
        centre_b = v_add(p_t, v_mul(d_t, unique_u))
        free_dof = False
    else:
        w_perp = v_sub(w, v_mul(d0, v_dot(w, d0)))
        if v_hypot(w_perp) < MIN_PERP_OFFSET_MM:
            return SolveError(
                "The input beam and the target axis are the same line — two mirrors "
                "would have nothing to correct. Offset the target, or steer with one mirror."
            )
        f_default = (
            v_dot(v_sub(current_a, p_in), d0)
            + v_dot(v_sub(v_sub(current_b, p_in), w_perp), d0)
        ) / 2
        f = fold_mm if _is_finite_number(fold_mm) else f_default
        centre_a = v_add(p_in, v_mul(d0, f))
        centre_b = v_add(centre_a, w_perp)
        free_dof = True

        if math.isfinite(unique_span_mm):
            to_port = v_sub(centre_b, p_t)
            off_axis_mm = v_hypot(v_sub(to_port, v_mul(d_t, v_dot(to_port, d_t))))
            warnings.append(
                f"The input beam is {js_to_fixed(math.asin(min(1.0, sin_theta)) * 180 / math.pi, 4)} deg "
                "off the destination axis, so no 45/45 pair meets it exactly on the bench "
                f"(that solve lands {js_to_fixed(unique_span_mm / 1000, 1)} m away). Solved as the "
                f"collinear case: the beam will arrive {js_to_fixed(off_axis_mm, 3)} mm off the port axis. "
                "Straighten the upstream beam to remove the residual."
            )

    leg_vec = v_sub(centre_b, centre_a)
    leg_length_mm = v_hypot(leg_vec)
    if leg_length_mm < MIN_PERP_OFFSET_MM:
        return SolveError(
            "The two mirror centres come out on top of each other — the input beam "
            "already meets the target axis. No two-mirror pair is needed here."
        )
    d1 = _unit_or_throw(leg_vec)

    normal_a = _unit_or_throw(v_sub(d1, d0))
    normal_b = _unit_or_throw(v_sub(d_t, d1))

    fold = v_dot(v_sub(centre_a, p_in), d0)
    target_standoff_mm = v_dot(v_sub(centre_b, p_t), d_t)

    if fold <= 0:
        warnings.append(
            f"Mirror A lands {js_to_fixed(abs(fold), 1)} mm UPSTREAM of where the input "
            "beam starts — the beam would never reach it."
        )
    if target_standoff_mm >= 0:
        warnings.append(
            f"Mirror B lands {js_to_fixed(target_standoff_mm, 1)} mm PAST the destination port — "
            "the beam would have to travel backwards."
        )
    clearance = (aperture_a_mm if aperture_a_mm is not None else 0) + (
        aperture_b_mm if aperture_b_mm is not None else 0
    )
    if clearance > 0 and leg_length_mm < clearance:
        warnings.append(
            f"The two mirrors end up {js_to_fixed(leg_length_mm, 1)} mm apart, less than their "
            f"combined clear radii ({js_to_fixed(clearance, 1)} mm) — the bodies will foul."
        )

    return CouplingGeometry(
        d1=d1,
        centre_a=centre_a,
        centre_b=centre_b,
        normal_a=normal_a,
        normal_b=normal_b,
        leg_length_mm=leg_length_mm,
        free_dof=free_dof,
        fold_mm=fold,
        target_standoff_mm=target_standoff_mm,
        warnings=warnings,
    )


# ─── pose synthesis ────────────────────────────────────────────────────────

@dataclass(frozen=True)
class MirrorMove:
    object_id: str
    name: str
    pose: AlignPose
    travel_mm: float
    rotation_deg: float


def pose_mirror_to(mirror: MirrorFacts, centre_lab: V, normal_lab: V) -> MirrorMove:
    """TS ``poseMirrorTo``: the SHORTEST rotation carrying the current normal
    onto ``normal_lab``, pre-multiplied onto the current orientation, then a
    translation putting the face centre on ``centre_lab``."""
    q_cur = scene_object_to_quaternion(mirror.scene_object)
    frm = v3_normalize(mirror.normal_lab)
    to = v3_normalize(normal_lab)
    q_delta = q_from_unit_vectors(frm, to)
    q_new = q_multiply(q_delta, q_cur)

    rotated_centre = v3_apply_quaternion(mirror.centre_cad, q_new)
    rx, ry, rz = scene_object_euler_from_quaternion(q_new)
    return MirrorMove(
        object_id=mirror.object_id,
        name=mirror.name,
        pose=AlignPose(
            x_mm=centre_lab.x - rotated_centre.x,
            y_mm=centre_lab.y - rotated_centre.y,
            z_mm=centre_lab.z - rotated_centre.z,
            rx_deg=rx,
            ry_deg=ry,
            rz_deg=rz,
        ),
        travel_mm=v_hypot(v_sub(centre_lab, mirror.centre_lab)),
        rotation_deg=(2 * math.acos(min(1.0, abs(q_delta[3]))) * 180) / math.pi,
    )


# ─── the whole plan ────────────────────────────────────────────────────────

@dataclass(frozen=True)
class CouplingPlan:
    geometry: CouplingGeometry
    move_a: MirrorMove
    move_b: MirrorMove
    before_decentre_a_mm: float | None
    before_decentre_b_mm: float | None
    before_target_miss_mm: float | None


def plan_mirror_coupling(
    *,
    in_ray: Ray,
    target_ray: Ray,
    a: MirrorFacts,
    b: MirrorFacts,
    fold_mm: float | None = None,
    touch: TouchMatrix | None = None,
) -> CouplingPlan | SolveError:
    """TS ``planMirrorCoupling``: solve + both poses + the before numbers."""
    geometry = solve_coupling_geometry(
        in_ray=in_ray,
        target_ray=target_ray,
        current_a=a.centre_lab,
        current_b=b.centre_lab,
        fold_mm=fold_mm,
        aperture_a_mm=a.aperture_mm,
        aperture_b_mm=b.aperture_mm,
    )
    if isinstance(geometry, SolveError):
        return geometry
    if touch is None:
        touch = check_mirror_touch(in_ray=in_ray, target_ray=target_ray, a=a, b=b)
    return CouplingPlan(
        geometry=geometry,
        move_a=pose_mirror_to(a, geometry.centre_a, geometry.normal_a),
        move_b=pose_mirror_to(b, geometry.centre_b, geometry.normal_b),
        before_decentre_a_mm=touch.seed_on_a.decentre_mm if touch.seed_on_a is not None else None,
        before_decentre_b_mm=touch.seed_on_b.decentre_mm if touch.seed_on_b is not None else None,
        before_target_miss_mm=current_target_miss_mm(in_ray, target_ray, a, b),
    )


def current_target_miss_mm(in_ray: Ray, target_ray: Ray, a: MirrorFacts, b: MirrorFacts) -> float | None:
    """How far the beam that currently leaves B misses the destination axis
    (line-line distance). ``None`` when the seed never gets that far."""
    hit_a = intersect_mirror(in_ray, a)
    if hit_a is None or hit_a.t_mm <= 0:
        return None
    after_a = Ray(origin=hit_a.point_lab, dir=reflect(in_ray.dir, a.normal_lab))
    hit_b = intersect_mirror(after_a, b)
    if hit_b is None or hit_b.t_mm <= 0:
        return None
    out_dir = reflect(after_a.dir, b.normal_lab)

    p1 = hit_b.point_lab
    p2 = target_ray.origin
    n = v_cross(out_dir, target_ray.dir)
    n_len = v_hypot(n)
    diff = v_sub(p2, p1)
    if n_len < COLLINEAR_SIN_EPS:
        along = v_mul(out_dir, v_dot(diff, out_dir))
        return v_hypot(v_sub(diff, along))
    return abs(v_dot(diff, v_mul(n, 1 / n_len)))
