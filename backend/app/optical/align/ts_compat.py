"""The handful of three.js r170 / JavaScript primitives the align ports need.

The align solvers in this package are ports of frontend TypeScript
(``utils/mirrorCoupling.ts``, ``utils/isolatorAlign.ts``,
``utils/aomAlign.ts``) and are pinned to it by golden fixtures at 1e-9
(``backend/tests/fixtures/align/``). Most of that parity is plain algebra, but
three things are branchy or formatted, and a "mathematically equivalent"
rewrite would diverge on exactly the inputs that matter:

* ``Quaternion.setFromUnitVectors`` special-cases anti-parallel vectors
  (``r < Number.EPSILON``) and picks one particular 180 deg axis — a
  different axis is a different pose.
* ``Math.round`` rounds half toward +inf (Python's ``round`` is banker's), and
  ``Number.prototype.toFixed`` rounds half away from zero on the exact binary
  value; the solvers put both into user-facing numbers and warning text.
* ``Vector3.normalize`` multiplies by ``1 / length`` rather than dividing,
  and re-normalises already-unit vectors; mirroring the operation order keeps
  the two copies bit-identical in the common case, which keeps the
  ``sceneObjectEulerFromQuaternion`` gimbal branch choice identical too.

So each helper here is a line-for-line transcription of the three.js source
(``node_modules/three/src/math/{Quaternion,Vector3,Matrix4}.js``, r170) or of
the ECMAScript algorithm, NOT a re-derivation. Change them only together with
the TypeScript they mirror.
"""

from __future__ import annotations

import dataclasses
import math
import sys
from decimal import ROUND_HALF_UP, Context, Decimal, localcontext
from typing import Any, NamedTuple


class V(NamedTuple):
    """A 3-vector in mm or unitless — the TS ``{x, y, z}``."""

    x: float
    y: float
    z: float


# (x, y, z, w), the three.js component order.
Quat = tuple[float, float, float, float]

IDENTITY_QUAT: Quat = (0.0, 0.0, 0.0, 1.0)

# THREE.MathUtils.DEG2RAD / RAD2DEG.
DEG2RAD = math.pi / 180
RAD2DEG = 180 / math.pi

# Number.EPSILON (Quaternion.setFromUnitVectors' anti-parallel threshold).
JS_EPSILON = sys.float_info.epsilon


# ── plain vector algebra (object-literal helpers in the TS files) ───────────

def v_add(a: V, b: V) -> V:
    return V(a.x + b.x, a.y + b.y, a.z + b.z)


def v_sub(a: V, b: V) -> V:
    return V(a.x - b.x, a.y - b.y, a.z - b.z)


def v_mul(a: V, k: float) -> V:
    return V(a.x * k, a.y * k, a.z * k)


def v_dot(a: V, b: V) -> float:
    return a.x * b.x + a.y * b.y + a.z * b.z


def v_cross(a: V, b: V) -> V:
    return V(
        a.y * b.z - a.z * b.y,
        a.z * b.x - a.x * b.z,
        a.x * b.y - a.y * b.x,
    )


def v_hypot(a: V) -> float:
    """``Math.hypot(a.x, a.y, a.z)``."""
    return math.hypot(a.x, a.y, a.z)


def v_neg(a: V) -> V:
    """``Vector3.negate``."""
    return V(-a.x, -a.y, -a.z)


# ── THREE.Vector3 ───────────────────────────────────────────────────────────

def v3_length(v: V) -> float:
    """``Vector3.length``: ``sqrt(x*x + y*y + z*z)`` (not hypot)."""
    return math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)


def v3_normalize(v: V) -> V:
    """``Vector3.normalize``: ``divideScalar(length() || 1)``, where
    ``divideScalar(s)`` is ``multiplyScalar(1 / s)``."""
    length = v3_length(v)
    if length == 0 or length != length:  # JS `|| 1` also catches NaN
        length = 1.0
    s = 1 / length
    return V(v.x * s, v.y * s, v.z * s)


def v3_apply_quaternion(v: V, q: Quat) -> V:
    """``Vector3.applyQuaternion`` (the r170 ``t = 2 * cross(q.xyz, v)`` form)."""
    vx, vy, vz = v
    qx, qy, qz, qw = q
    tx = 2 * (qy * vz - qz * vy)
    ty = 2 * (qz * vx - qx * vz)
    tz = 2 * (qx * vy - qy * vx)
    return V(
        vx + qw * tx + qy * tz - qz * ty,
        vy + qw * ty + qz * tx - qx * tz,
        vz + qw * tz + qx * ty - qy * tx,
    )


def v3_length_sq(v: V) -> float:
    return v.x * v.x + v.y * v.y + v.z * v.z


# ── THREE.Quaternion ────────────────────────────────────────────────────────

def q_normalize(q: Quat) -> Quat:
    x, y, z, w = q
    length = math.sqrt(x * x + y * y + z * z + w * w)
    if length == 0:
        return IDENTITY_QUAT
    length = 1 / length
    return (x * length, y * length, z * length, w * length)


def q_multiply(a: Quat, b: Quat) -> Quat:
    """``a.clone().multiply(b)`` = ``multiplyQuaternions(a, b)``."""
    qax, qay, qaz, qaw = a
    qbx, qby, qbz, qbw = b
    return (
        qax * qbw + qaw * qbx + qay * qbz - qaz * qby,
        qay * qbw + qaw * qby + qaz * qbx - qax * qbz,
        qaz * qbw + qaw * qbz + qax * qby - qay * qbx,
        qaw * qbw - qax * qbx - qay * qby - qaz * qbz,
    )


def q_from_unit_vectors(v_from: V, v_to: V) -> Quat:
    """``Quaternion.setFromUnitVectors`` — including its anti-parallel axis
    choice, which decides WHICH 180 deg turn a reversed optic gets."""
    r = v_from.x * v_to.x + v_from.y * v_to.y + v_from.z * v_to.z + 1
    if r < JS_EPSILON:
        r = 0.0
        if abs(v_from.x) > abs(v_from.z):
            q = (-v_from.y, v_from.x, 0.0, r)
        else:
            q = (0.0, -v_from.z, v_from.y, r)
    else:
        q = (
            v_from.y * v_to.z - v_from.z * v_to.y,
            v_from.z * v_to.x - v_from.x * v_to.z,
            v_from.x * v_to.y - v_from.y * v_to.x,
            r,
        )
    return q_normalize(q)


def q_from_axis_angle(axis: V, angle: float) -> Quat:
    """``Quaternion.setFromAxisAngle`` (assumes ``axis`` is unit — as in three,
    it is NOT normalised here)."""
    half = angle / 2
    s = math.sin(half)
    return (axis.x * s, axis.y * s, axis.z * s, math.cos(half))


def q_from_rotation_matrix(
    m11: float, m12: float, m13: float,
    m21: float, m22: float, m23: float,
    m31: float, m32: float, m33: float,
) -> Quat:
    """``Quaternion.setFromRotationMatrix`` for the matrix ``Matrix4.set``
    would build from these row-major entries."""
    trace = m11 + m22 + m33
    if trace > 0:
        s = 0.5 / math.sqrt(trace + 1.0)
        return ((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s)
    if m11 > m22 and m11 > m33:
        s = 2.0 * math.sqrt(1.0 + m11 - m22 - m33)
        return (0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s)
    if m22 > m33:
        s = 2.0 * math.sqrt(1.0 + m22 - m11 - m33)
        return ((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s)
    s = 2.0 * math.sqrt(1.0 + m33 - m11 - m22)
    return ((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s)


def m4_rotation_elements(q: Quat) -> list[float]:
    """``new Matrix4().makeRotationFromQuaternion(q).elements`` — column-major,
    16 entries, unit scale (``compose(_zero, q, _one)``)."""
    x, y, z, w = q
    x2, y2, z2 = x + x, y + y, z + z
    xx, xy, xz = x * x2, x * y2, x * z2
    yy, yz, zz = y * y2, y * z2, z * z2
    wx, wy, wz = w * x2, w * y2, w * z2
    return [
        1 - (yy + zz), xy + wz, xz - wy, 0.0,
        xy - wz, 1 - (xx + zz), yz + wx, 0.0,
        xz + wy, yz - wx, 1 - (xx + yy), 0.0,
        0.0, 0.0, 0.0, 1.0,
    ]


# ── JavaScript Number semantics ─────────────────────────────────────────────

def js_round(x: float) -> int:
    """``Math.round``: nearest integer, ties toward +infinity."""
    r = math.floor(x)
    return int(r + 1 if x - r >= 0.5 else r)


_FIXED_CTX = Context(prec=200)


def js_to_fixed(x: float, digits: int) -> str:
    """``Number.prototype.toFixed`` for |x| < 1e21: round the EXACT binary
    value half away from zero, keep a ``-`` on a negative that rounds to 0
    (``(-0.001).toFixed(1) === "-0.0"``), but not on ``-0`` itself."""
    if x != x:
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        x = 0.0
    with localcontext(_FIXED_CTX):
        q = Decimal(x).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)
    return format(q, "f")


def js_num(v: Any, fallback: float) -> float:
    """``typeof v === "number" && Number.isFinite(v) ? v : fallback``."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return fallback
    v = float(v)
    return v if math.isfinite(v) else fallback


def read_xyz(raw: Any) -> V | None:
    """A ``{x, y, z}`` object of finite numbers (the anchor JSON shape)."""
    if not isinstance(raw, dict):
        return None
    vals = [raw.get("x"), raw.get("y"), raw.get("z")]
    if all(isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n) for n in vals):
        return V(float(vals[0]), float(vals[1]), float(vals[2]))
    return None


# ── JSON in the TS shape ────────────────────────────────────────────────────

def camel(name: str) -> str:
    """snake_case -> camelCase, leaving an underscore-free name as is (so the
    AOM frame's ``D1`` stays ``D1``)."""
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


def to_json(obj: Any) -> Any:
    """Dataclasses / ``V`` / containers -> plain JSON in the TypeScript
    objects' shape (camelCase keys, vectors as ``{x, y, z}``). Both the
    endpoints and the parity fixtures go through this, so the wire format IS
    the shape the TS functions return."""
    if isinstance(obj, V):
        return {"x": obj.x, "y": obj.y, "z": obj.z}
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {camel(f.name): to_json(getattr(obj, f.name)) for f in dataclasses.fields(obj)}
    if isinstance(obj, dict):
        return {k: to_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_json(v) for v in obj]
    return obj


def v_from_json(d: dict) -> V:
    return V(float(d["x"]), float(d["y"]), float(d["z"]))
