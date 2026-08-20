"""BeamRay — Python mirror of frontend/src/optical/beam-ray.ts.

See that file's docstring for full convention. Highlights:
  - origin / direction in lab mm
  - the transverse envelope is the complex symmetric 2x2 beam matrix Q
    (`QMatrix`): qx/qy are its DIAGONAL, qxy the cross term that a
    rotated astigmatism axis needs. qxy == 0 everywhere today.
  - jones = (E_s, E_p) in beam-local s/p frame
  - power in mW, wavelength in nm
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from typing import Optional


# ---------------------------------------------------------------------------
# Vec3
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Vec3:
    x: float
    y: float
    z: float

    def __add__(self, other: "Vec3") -> "Vec3":
        return Vec3(self.x + other.x, self.y + other.y, self.z + other.z)

    def __sub__(self, other: "Vec3") -> "Vec3":
        return Vec3(self.x - other.x, self.y - other.y, self.z - other.z)

    def __mul__(self, s: float) -> "Vec3":
        return Vec3(self.x * s, self.y * s, self.z * s)

    __rmul__ = __mul__

    def dot(self, other: "Vec3") -> float:
        return self.x * other.x + self.y * other.y + self.z * other.z

    def length(self) -> float:
        return math.sqrt(self.dot(self))

    def normalized(self) -> "Vec3":
        n = self.length()
        if n < 1e-15:
            raise ValueError("cannot normalize zero vector")
        return Vec3(self.x / n, self.y / n, self.z / n)


def vec3_distance(a: Vec3, b: Vec3) -> float:
    return (a - b).length()


# ---------------------------------------------------------------------------
# Complex helper (use built-in complex throughout)
# ---------------------------------------------------------------------------

def q_at_waist(waist_radius_mm: float, lambda_mm: float) -> complex:
    """q at the waist: q = i * z_R where z_R = pi * w0^2 / lambda."""
    z_r = math.pi * waist_radius_mm * waist_radius_mm / lambda_mm
    return complex(0.0, z_r)


# Non-paraxial divergence -----------------------------------------------------
# The q-parameter ABCD propagation is paraxial (z_R = π w₀²/λ), which makes the
# far-field half-angle θ = M²λ/(π w₀) — fine for w₀ ≫ λ, but it over-/mis-states
# divergence as w₀ → λ (high-NA fiber tips, tight focuses). We KEEP q paraxial
# (so chief-ray geometry + lens focusing stay correct) and apply the
# non-paraxial correction ONLY to the reported/rendered beam WIDTH:
#   s     = M²λ/(π w₀)            (paraxial divergence param = sin θ, rigorous)
#   floor : s ≤ 1  ⇔  w₀ ≥ M²λ/π (NA=1 diffraction limit; s>1 is evanescent)
#   z_R_eff = z_R·√(1−s²)         (far-field slope → tan(arcsin s) = s/√(1−s²))
# Low NA (s≪1): z_R_eff ≈ z_R, recovers the paraxial hyperbola exactly.
# Shared by the laser emitter, the optical-link cone, TA mode-match, and (next)
# fiber mode-match so every high-NA waist is treated identically.
_NONPARAXIAL_S_FLOOR = 0.999  # cap below 1 so z_R_eff never hits 0 (90° cone)


def nonparaxial_fundamental_waist_mm(
    q_re_mm: float, q_im_mm: float, m2: float, wavelength_nm: float,
) -> tuple[float, bool]:
    """Non-paraxial FUNDAMENTAL (mode-factor-excluded) real beam radius at the
    point described by paraxial ``q`` (``q_im`` = z_R, ``q_re`` = signed
    distance from the waist). Returns ``(w_real_mm, past_diffraction_limit)``;
    multiply by the transverse-mode width factor afterwards."""
    z_r = abs(q_im_mm)
    lam_mm = wavelength_nm * 1e-6
    if z_r <= 0.0 or lam_mm <= 0.0:
        return 0.0, False
    m2_eff = m2 if (m2 and m2 > 0) else 1.0
    w0_embedded_mm = math.sqrt(lam_mm * z_r / math.pi)
    w0_real_mm = w0_embedded_mm * math.sqrt(m2_eff)
    s = m2_eff * lam_mm / (math.pi * w0_real_mm) if w0_real_mm > 0 else 1.0
    past_limit = s >= 1.0
    s_eff = min(s, _NONPARAXIAL_S_FLOOR)
    z_r_eff = z_r * math.sqrt(1.0 - s_eff * s_eff)
    if z_r_eff <= 0.0:
        return w0_real_mm, past_limit
    w_real_mm = w0_real_mm * math.sqrt(1.0 + (q_re_mm / z_r_eff) ** 2)
    return w_real_mm, past_limit


# ---------------------------------------------------------------------------
# 2x2 complex algebra + the transverse beam matrix Q
# ---------------------------------------------------------------------------
# Step 1 of the general-astigmatism upgrade. A scalar pair (qx, qy) can only
# describe astigmatism whose principal axes coincide with the element frame —
# see the limitation note in anchor_ops/lens.py:_tilt_astig_focals and in
# solvers/generalized_abcd.py:apply_operator. The closed object is instead the
# complex symmetric matrix Q, propagated by Q' = (A·Q + B)(C·Q + D)^-1 with
# 2x2 ABCD blocks (Arnaud & Kogelnik general astigmatism).
#
# Nothing writes a non-zero off-diagonal yet: every op still drives the
# diagonal, and the helpers below take an EXACT scalar fast path whenever the
# inputs are diagonal, so results are bit-identical to the pre-refactor code.


@dataclass(frozen=True)
class Mat2:
    """2x2 complex matrix, row-major ``[[xx, xy], [yx, yy]]``."""

    xx: complex
    xy: complex
    yx: complex
    yy: complex

    @staticmethod
    def identity() -> "Mat2":
        return Mat2(1 + 0j, 0j, 0j, 1 + 0j)

    @staticmethod
    def diag(xx: complex, yy: complex) -> "Mat2":
        return Mat2(xx, 0j, 0j, yy)

    @staticmethod
    def scalar(s: complex) -> "Mat2":
        """Isotropic block — what every rotationally symmetric element uses."""
        return Mat2(s, 0j, 0j, s)

    @property
    def is_diagonal(self) -> bool:
        return self.xy == 0 and self.yx == 0

    def __add__(self, o: "Mat2") -> "Mat2":
        return Mat2(self.xx + o.xx, self.xy + o.xy, self.yx + o.yx, self.yy + o.yy)

    def __matmul__(self, o: "Mat2") -> "Mat2":
        return Mat2(
            self.xx * o.xx + self.xy * o.yx,
            self.xx * o.xy + self.xy * o.yy,
            self.yx * o.xx + self.yy * o.yx,
            self.yx * o.xy + self.yy * o.yy,
        )

    def det(self) -> complex:
        return self.xx * self.yy - self.xy * self.yx

    def inverse(self) -> "Mat2":
        d = self.det()
        if abs(d) < 1e-30:
            raise ZeroDivisionError("singular 2x2 matrix")
        return Mat2(self.yy / d, -self.xy / d, -self.yx / d, self.xx / d)


@dataclass(frozen=True)
class QMatrix:
    """Transverse beam matrix of a general-astigmatic Gaussian.

    Complex SYMMETRIC 2x2 (``yx == xy``), i.e. three independent complex
    numbers; the field is ``E ~ exp(-i·k/2 · r^T Q^-1 r)``.

    ``xx`` / ``yy`` are exactly the historical scalar ``qx`` / ``qy``. ``xy``
    is the cross term the scalar pair could not represent; ``xy == 0`` means
    orthogonal ("simple") astigmatism aligned with the element frame, which is
    every beam the tracer builds today.
    """

    xx: complex
    yy: complex
    xy: complex = 0j

    @property
    def is_diagonal(self) -> bool:
        return self.xy == 0

    def as_mat2(self) -> Mat2:
        return Mat2(self.xx, self.xy, self.xy, self.yy)

    @staticmethod
    def from_mat2(m: Mat2) -> "QMatrix":
        # Re-symmetrize: Q stays symmetric analytically, so the average only
        # absorbs rounding, never a real asymmetry.
        return QMatrix(m.xx, m.yy, 0.5 * (m.xy + m.yx))


def _q_scalar_after_abcd(
    q: complex, a: complex, b: complex, c: complex, d: complex,
) -> complex:
    """Scalar ABCD law. Byte-for-byte the arithmetic of
    ``anchor_ops.lens._q_after_abcd``, including its degenerate-denominator
    guard — the diagonal fast path below must not perturb a single ULP."""
    denom = c * q + d
    if abs(denom) < 1e-20:
        return q
    return (a * q + b) / denom


def q_matrix_after_abcd(
    q: QMatrix, a: Mat2, b: Mat2, c: Mat2, d: Mat2,
) -> QMatrix:
    """Propagate Q through one element: ``Q' = (A·Q + B)(C·Q + D)^-1``.

    Reduces to two independent scalar ABCD laws — the exact pre-refactor
    arithmetic — when Q and all four blocks are diagonal.
    """
    if (
        q.is_diagonal
        and a.is_diagonal and b.is_diagonal
        and c.is_diagonal and d.is_diagonal
    ):
        return QMatrix(
            _q_scalar_after_abcd(q.xx, a.xx, b.xx, c.xx, d.xx),
            _q_scalar_after_abcd(q.yy, a.yy, b.yy, c.yy, d.yy),
            0j,
        )
    qm = q.as_mat2()
    num = (a @ qm) + b
    den = (c @ qm) + d
    try:
        return QMatrix.from_mat2(num @ den.inverse())
    except ZeroDivisionError:
        return q


def sym2_rotate(
    xx: float, yy: float, xy: float, phi_rad: float,
) -> tuple[float, float, float]:
    """Re-express a REAL symmetric 2x2 in a basis rotated by ``phi_rad``:
    ``T' = R.T.R^T`` with the same ``R`` as :func:`q_rotate` / ``rotate_jones``.

    Returns the input untouched when the rotation is zero OR the tensor is
    isotropic (``xx == yy`` and ``xy == 0``) -- an isotropic tensor is the
    same in every frame, so this is exact, not an approximation, and it is
    what keeps every equal-M2 beam bit-unchanged.
    """
    if phi_rad == 0.0 or (xy == 0.0 and xx == yy):
        return xx, yy, xy
    c = math.cos(phi_rad)
    s = math.sin(phi_rad)
    cc, ss, cs = c * c, s * s, c * s
    return (
        cc * xx + 2.0 * cs * xy + ss * yy,
        ss * xx - 2.0 * cs * xy + cc * yy,
        cs * (yy - xx) + (cc - ss) * xy,
    )


def sym2_eig(xx: float, yy: float, xy: float) -> tuple[float, float, float]:
    """Eigen-decomposition of a real symmetric 2x2. Returns
    ``(lambda_major, lambda_minor, azimuth_of_major)``."""
    mid = 0.5 * (xx + yy)
    rad = math.hypot(0.5 * (xx - yy), xy)
    return mid + rad, mid - rad, 0.5 * math.atan2(2.0 * xy, xx - yy)


def q_rotate(q: QMatrix, phi_rad: float) -> QMatrix:
    """Re-express Q in a transverse basis rotated by ``phi_rad`` about the
    propagation direction.

    Uses exactly ``jones.rotate_jones``' convention — components transform by
    ``R = [[c, s], [-s, c]]`` — so Q and the Jones vector stay coherent under
    every frame change the tracer makes. Q is a symmetric 2-tensor, hence
    ``Q' = R·Q·R^T``.

    ``phi_rad == 0`` returns the input untouched, so a scene whose elements
    are all mutually aligned about the beam axis is bit-unchanged.
    """
    if phi_rad == 0.0:
        return q
    c = math.cos(phi_rad)
    s = math.sin(phi_rad)
    cc, ss, cs = c * c, s * s, c * s
    xx, yy, xy = q.xx, q.yy, q.xy
    return QMatrix(
        cc * xx + 2.0 * cs * xy + ss * yy,
        ss * xx - 2.0 * cs * xy + cc * yy,
        cs * (yy - xx) + (cc - ss) * xy,
    )


def q_power_tensor(inv_f_u: float, inv_f_v: float, phi_rad: float) -> Mat2:
    """Real symmetric focusing-power tensor P of an element whose principal
    axes (powers ``1/f_u``, ``1/f_v``) sit at ``phi_rad`` from the frame Q is
    expressed in. A thin element is then ``Q' = Q·(I - P·Q)^-1``, equivalently
    ``Q'^-1 = Q^-1 - P``.

    ``inv_f_v = 0`` gives a cylindrical lens; equal powers give a spherical
    one, for which P is isotropic and ``phi_rad`` is irrelevant.
    """
    c = math.cos(phi_rad)
    s = math.sin(phi_rad)
    pxx = inv_f_u * c * c + inv_f_v * s * s
    pyy = inv_f_u * s * s + inv_f_v * c * c
    pxy = (inv_f_u - inv_f_v) * c * s
    return Mat2(complex(pxx), complex(pxy), complex(pxy), complex(pyy))


def q_after_thin_element(q: QMatrix, p: Mat2) -> QMatrix:
    """Apply a thin focusing element with power tensor ``P``: A=D=I, B=0, C=-P."""
    return q_matrix_after_abcd(
        q,
        Mat2.identity(),
        Mat2.scalar(0j),
        Mat2(-p.xx, -p.xy, -p.yx, -p.yy),
        Mat2.identity(),
    )


def _w_from_scalar_q(q: complex, lam_mm: float) -> float:
    """1/e^2 field radius from a scalar q. Same expression and evaluation
    order as ``aperture.gaussian_width_mm`` so the two agree exactly."""
    im = q.imag
    if im <= 0.0 or lam_mm <= 0.0:
        return 0.0
    w_sq = lam_mm * (q.real * q.real + im * im) / (math.pi * im)
    return math.sqrt(max(w_sq, 0.0))


def q_width_tensor(
    q: QMatrix, wavelength_nm: float,
) -> tuple[float, float, float]:
    """The EMBEDDED width-squared tensor ``W`` of Q, so that the 1/e^2 field
    radius along a unit direction ``n`` is ``sqrt(n^T W n)``.

    ``|E|^2 ~ exp(k. r^T Im(Q^-1) r)`` gives ``W = -(lambda/pi).Im(Q^-1)^-1``;
    its eigenvalues are the squared principal widths. Returns zeros for a
    degenerate beam.
    """
    lam_mm = wavelength_nm * 1e-6
    if lam_mm <= 0.0:
        return 0.0, 0.0, 0.0
    try:
        p = q.as_mat2().inverse()
    except ZeroDivisionError:
        return 0.0, 0.0, 0.0
    a = p.xx.imag
    c = p.yy.imag
    b = 0.5 * (p.xy.imag + p.yx.imag)
    det = a * c - b * b
    if det == 0.0:
        return 0.0, 0.0, 0.0
    k = -lam_mm / (math.pi * det)          # -(lambda/pi) . 1/det
    return k * c, k * a, -k * b            # inverse of [[a,b],[b,c]], scaled


def beam_real_widths(
    q: QMatrix,
    wavelength_nm: float,
    mult_xx: float = 1.0,
    mult_yy: float = 1.0,
    mult_xy: float = 0.0,
) -> tuple[float, float, float]:
    """``(w_major_mm, w_minor_mm, azimuth_rad)`` of the REAL beam.

    The real width tensor is ``W_real = S.W_emb.S`` where ``W_emb`` comes from
    Q and ``S`` is the symmetric width-multiplier tensor (sqrt(M2) times the
    transverse-mode factor, per principal axis). For a diagonal ``S`` and a
    diagonal ``W_emb`` this is exactly today's per-axis
    ``embedded_width * width_mult``; the difference is that both now rotate
    together, so the answer no longer depends on which frame Q happens to be
    expressed in.
    """
    wxx, wyy, wxy = q_width_tensor(q, wavelength_nm)
    # S.W.S for symmetric 2x2, written out (all products are symmetric).
    axx = mult_xx * wxx + mult_xy * wxy
    axy = mult_xx * wxy + mult_xy * wyy
    ayx = mult_xy * wxx + mult_yy * wxy
    ayy = mult_xy * wxy + mult_yy * wyy
    rxx = axx * mult_xx + axy * mult_xy
    rxy = axx * mult_xy + axy * mult_yy
    ryy = ayx * mult_xy + ayy * mult_yy
    lam_a, lam_b, azim = sym2_eig(rxx, ryy, rxy)
    return math.sqrt(max(lam_a, 0.0)), math.sqrt(max(lam_b, 0.0)), azim


def q_matrix_principal_widths(
    q: QMatrix, wavelength_nm: float,
) -> tuple[float, float, float]:
    """``(w_major_mm, w_minor_mm, azimuth_rad)`` of the intensity ellipse.

    ``azimuth`` is the direction of ``w_major`` measured from +x in the frame
    Q is expressed in, and is always 0 or pi/2 for a diagonal Q.

    Derivation: with ``P = Q^-1``, ``|E|^2 ~ exp(k·r^T Im(P) r)``, so the
    principal w^2 are ``-lambda/(pi·mu)`` over the eigenvalues ``mu`` of
    ``Im(P)`` (negative definite for a physical beam) and the principal axes
    are its eigenvectors.
    """
    lam_mm = wavelength_nm * 1e-6
    if lam_mm <= 0.0:
        return 0.0, 0.0, 0.0
    if q.is_diagonal:
        wx = _w_from_scalar_q(q.xx, lam_mm)
        wy = _w_from_scalar_q(q.yy, lam_mm)
        return (wx, wy, 0.0) if wx >= wy else (wy, wx, math.pi / 2.0)

    try:
        p = q.as_mat2().inverse()
    except ZeroDivisionError:
        return 0.0, 0.0, 0.0
    a = p.xx.imag
    c = p.yy.imag
    b = 0.5 * (p.xy.imag + p.yx.imag)
    # major w <=> the eigenvalue closest to zero (both are negative)
    mu_major, mu_minor, azim = sym2_eig(a, c, b)

    def _w(mu: float) -> float:
        if mu >= 0.0:
            return 0.0
        return math.sqrt(-lam_mm / (math.pi * mu))

    return _w(mu_major), _w(mu_minor), azim


# ---------------------------------------------------------------------------
# BeamRay
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class BeamRay:
    # Chief ray (lab frame, mm)
    origin: Vec3
    direction: Vec3                  # unit vector

    # Gaussian beam envelope (per-axis q)
    qx: complex
    qy: complex

    # Spectrum & energy
    wavelength_nm: float              # nominal optical carrier
    power_mw: float

    # Polarization (beam-local s/p frame)
    jones: tuple[complex, complex]   # (E_s, E_p)

    # Off-diagonal of the transverse beam matrix Q (see QMatrix above).
    # qx/qy are Q's diagonal; this is Q.xy == Q.yx. Zero for every beam the
    # tracer builds today — orthogonal astigmatism aligned with the element
    # frame — and it rides unchanged through replaced() like width_mult.
    qxy: complex = 0j

    # Tracking
    path_length_mm: float = 0.0
    phase_accum_rad: float = 0.0
    # Accumulated optical-frequency offset (Hz) relative to the nominal carrier
    # implied by wavelength_nm. AOMs add order*f_RF here instead of perturbing
    # wavelength_nm, so a beat note between two rays is the exact difference of
    # their freq_offset_hz (no catastrophic cancellation).
    freq_offset_hz: float = 0.0

    # Embedded-Gaussian per-axis width multiplier (M²/mode upgrade). qx/qy
    # carry the EMBEDDED fundamental Gaussian (its z_R already reduced by M²
    # so divergence is correct); the REAL transverse width = (q-derived
    # embedded width) × width_mult. width_mult folds √(M²) and the high-order
    # transverse-mode factor (LG: √(2p+|l|+1) both axes; HG: x=√(2m+1),
    # y=√(2n+1)). 1.0 = TEM00, M²=1. Pure readout scale — does NOT affect
    # propagation, so it rides unchanged through every ABCD op via replaced().
    # It IS frame-dependent though; see width_mult_xy below.
    width_mult_x: float = 1.0
    width_mult_y: float = 1.0
    # Off-diagonal of the width-multiplier TENSOR (Step 2c). width_mult_x/y
    # are its diagonal. It does not affect propagation, but it is a tensor,
    # not a pair of scalars: it must rotate with the frame alongside Q or the
    # multiplier stops lining up with the axis it is meant to scale. Zero (and
    # rotation-exempt) whenever the two axes share a multiplier.
    width_mult_xy: float = 0.0
    # Per-axis M² (beam quality), carried separately from width_mult so the
    # non-paraxial width correction can recover the divergence param s =
    # M²λ/(πw₀) at readout. mode_factor = width_mult / √M². Default 1.0 = M²=1.
    m2x: float = 1.0
    m2y: float = 1.0
    # Off-diagonal of the M2 tensor — same story as width_mult_xy.
    m2xy: float = 0.0

    # Bookkeeping
    parent_id: Optional[str] = None
    exclude_face_key: Optional[str] = None
    is_ghost: bool = False

    def replaced(self, **kwargs) -> "BeamRay":
        """Return a new BeamRay with fields overridden."""
        return replace(self, **kwargs)

    @property
    def q_matrix(self) -> QMatrix:
        """The transverse envelope as one complex symmetric 2x2."""
        return QMatrix(self.qx, self.qy, self.qxy)

    def with_q_matrix(self, q: QMatrix) -> "BeamRay":
        """Write a Q matrix back onto the ray (diagonal -> qx/qy as before)."""
        return replace(self, qx=q.xx, qy=q.yy, qxy=q.xy)

    @property
    def width_mult_tensor(self) -> tuple[float, float, float]:
        """``(xx, yy, xy)`` of the symmetric width-multiplier tensor."""
        return self.width_mult_x, self.width_mult_y, self.width_mult_xy

    @property
    def m2_tensor(self) -> tuple[float, float, float]:
        """``(xx, yy, xy)`` of the symmetric M² tensor."""
        return self.m2x, self.m2y, self.m2xy

    def rotated_frame(self, phi_rad: float) -> "BeamRay":
        """Re-express Q and BOTH readout tensors in a transverse basis rotated
        by ``phi_rad``. One call so the three can never rotate by different
        amounts — the failure mode Step 2c exists to close."""
        q = q_rotate(self.q_matrix, phi_rad)
        wxx, wyy, wxy = sym2_rotate(*self.width_mult_tensor, phi_rad)
        mxx, myy, mxy = sym2_rotate(*self.m2_tensor, phi_rad)
        return replace(
            self, qx=q.xx, qy=q.yy, qxy=q.xy,
            width_mult_x=wxx, width_mult_y=wyy, width_mult_xy=wxy,
            m2x=mxx, m2y=myy, m2xy=mxy,
        )

    def real_widths(self) -> tuple[float, float, float]:
        """``(w_major_mm, w_minor_mm, azimuth_rad)`` of the real beam here —
        Q scaled by the multiplier tensor, frame-independent by construction."""
        return beam_real_widths(
            self.q_matrix, self.wavelength_nm, *self.width_mult_tensor,
        )


def make_beam_ray(
    *,
    origin: Vec3,
    direction: Vec3,
    wavelength_nm: float,
    waist_radius_mm: float = 0.5,
    power_mw: float = 1.0,
    jones: tuple[complex, complex] = (complex(1, 0), complex(0, 0)),
) -> BeamRay:
    """Build a BeamRay at a waist of `waist_radius_mm`, propagating along
    `direction`. Defaults: circular Gaussian (qx = qy), linearly polarized
    in +s, 1 mW."""
    lambda_mm = wavelength_nm * 1e-6
    q = q_at_waist(waist_radius_mm, lambda_mm)
    return BeamRay(
        origin=origin,
        direction=direction.normalized(),
        qx=q,
        qy=q,
        wavelength_nm=wavelength_nm,
        power_mw=power_mw,
        jones=jones,
    )
