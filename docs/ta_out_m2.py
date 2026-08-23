"""Sacher_TEC400_852nm_TA output mode: curvature check + M^2 from the WFS data.

Reproduces the numbers quoted in sacher-tec400-852nm-ta-output-mode.md.
Run: python docs/ta_out_m2.py

Source data: Thorlabs WFS30-5C/M + MLA150-5C, 2026-08-19, 1.5 cm from the
output aperture. Only the OUT_1459 column was read off the numeric panel; the
rest were estimated from bar-chart heights (input +/-0.01, output +/-0.1).
"""
import math
import numpy as np

LAM = 852e-6          # mm
A_OUT = 3.5           # output pupil radius, mm -- SUPERSEDED, see pupil_scan()
Z_MEAS = 15.0         # measurement plane, mm downstream of intercept_out

# Beam diameters read off the WFS panel (2026-08-20). These falsify the a = 3.5
# mm pupil the derivation above assumes -- the spot does NOT fill the sensor.
W_MEAS = {"x": 1.667/2, "y": 3.82/2}     # RADII at Z_MEAS, mm
SLOPE_LIMIT_MRAD = 14.4                  # MLA150-5C: (150/2) um / 5.2 mm

# ANSI j -> coefficient in waves @ 852 nm
ZERNIKE = {                        # j: (IN_1505, OUT_1459, OUT_1520)
    1:  (-0.090, -2.800, -2.65),   2:  (-0.085, -0.498,  0.68),
    3:  (-0.020, -0.389, -0.42),   4:  ( 0.010,  0.842, -0.45),
    5:  ( 0.210, -1.822, -2.25),   6:  (-0.155,  4.023,  4.30),
    7:  (-0.020, -0.389, -0.15),   8:  ( 0.065,  0.324, -0.42),
    9:  ( 0.000,  0.173,  0.20),   10: ( 0.040, -0.358,  0.30),
    11: ( 0.045, -0.087,  0.28),   12: (-0.015,  0.007, -0.55),
    13: ( 0.040,  0.346, -0.10),   14: (-0.035,  0.455,  0.68),
    15: ( 0.110, -0.543, -1.15),
}
COLS = {"IN_1505": 0, "OUT_1459": 1, "OUT_1520": 2}
NM = {1: (1, -1), 2: (1, 1), 3: (2, -2), 4: (2, 0), 5: (2, 2), 6: (3, -3),
      7: (3, -1), 8: (3, 1), 9: (3, 3), 10: (4, -4), 11: (4, -2), 12: (4, 0),
      13: (4, 2), 14: (4, 4), 15: (5, -5)}
NAME = {6: "Trefoil Y", 7: "Coma Y", 8: "Coma X", 9: "Trefoil X",
        10: "Quadrafoil Y", 11: "2nd Astig 45", 12: "Spherical",
        13: "2nd Astig 0/90", 14: "Quadrafoil X", 15: "Pentafoil Y"}
RESIDUAL = list(range(6, 16))   # tilt/defocus/astig excluded: qx/qy carry those


def c(col, j):
    return ZERNIKE[j][COLS[col]]


# --- 1. curvature -> GaussianMode -----------------------------------------

def curvature(col, a=A_OUT):
    """Two-axis wavefront radius from defocus + 0/90 astigmatism."""
    c4, c5 = c(col, 4), c(col, 5)
    inv_rx = (4 * math.sqrt(3) * c4 + 2 * math.sqrt(6) * c5) * LAM / a ** 2
    inv_ry = (4 * math.sqrt(3) * c4 - 2 * math.sqrt(6) * c5) * LAM / a ** 2
    return 1 / inv_rx, 1 / inv_ry


def mode_from_w_and_R(w, R, m2_=1.0):
    """(waistUm, waistZOffsetMm) for a real radius w and wavefront radius R at
    the measurement plane. waistUm is the REAL waist: _q_at_waist_mm stores
    zR = pi*w0^2/(M2*lam) and readout multiplies the embedded width by
    sqrt(M2), so the two cancel back to w0."""
    lam_r = LAM * m2_
    z = R / (1.0 + (lam_r * R / (math.pi * w * w)) ** 2)   # signed dist from waist
    zr = math.sqrt(max(z * (R - z), 0.0))
    w0 = w / math.sqrt(1.0 + (z / zr) ** 2)
    return w0 * 1000.0, Z_MEAS - z


def mode_to_w_and_R(w0_um, off_mm, m2_=1.0):
    """Inverse: what the stored params give back at the measurement plane."""
    zr = math.pi * (w0_um / 1000.0) ** 2 / (m2_ * LAM)
    z = Z_MEAS - off_mm
    return (w0_um / 1000.0) * math.sqrt(1 + (z / zr) ** 2), z + zr * zr / z


# --- 2. M^2 from the residual wavefront ------------------------------------
# Exact second-moment invariant for E = A(x,y)exp(i*phi) with a Gaussian A, at
# the ideal beam's waist plane:
#     M_x^2 = sqrt(1 + 4[<x^2><phi_x^2> - <x phi_x>^2])    (phi in rad, x in mm)
# Validated against a brute-force FFT -- see validate().

_N = 1401
_G = np.linspace(-1.35, 1.35, _N)        # rho units, past the pupil for gradients
_RX, _RY = np.meshgrid(_G, _G, indexing="xy")
_RHO = np.hypot(_RX, _RY)
_THETA = np.arctan2(_RY, _RX)
_H = (_G[1] - _G[0]) * A_OUT             # grid step, mm
_XMM, _YMM = _RX * A_OUT, _RY * A_OUT


def _radial(n, m, rho):
    m = abs(m)
    out = np.zeros_like(rho)
    for k in range((n - m) // 2 + 1):
        out += ((-1) ** k * math.factorial(n - k)
                / (math.factorial(k) * math.factorial((n + m) // 2 - k)
                   * math.factorial((n - m) // 2 - k))) * rho ** (n - 2 * k)
    return out


def _zern(j, rho, theta):
    n, m = NM[j]
    norm = math.sqrt(2 * (n + 1)) if m else math.sqrt(n + 1)
    ang = np.sin(abs(m) * theta) if m < 0 else np.cos(m * theta)
    return norm * _radial(n, m, rho) * ang


def m2(col, modes=RESIDUAL, w_over_a=1.0):
    W = np.zeros_like(_RHO)
    for j in modes:
        W += c(col, j) * _zern(j, _RHO, _THETA)
    phi = 2 * math.pi * W
    phiy, phix = np.gradient(phi, _H, _H)
    w = w_over_a * A_OUT
    inten = np.exp(-2 * (_XMM ** 2 + _YMM ** 2) / w ** 2) * (_RHO <= 1.0)
    s = inten.sum()

    def mean(f):
        return float((inten * f).sum() / s)

    out = []
    for u, du in ((_XMM, phix), (_YMM, phiy)):
        du_c, u_c = du - mean(du), u - mean(u)          # drop mean tilt
        out.append(math.sqrt(max(
            1.0 + 4 * (mean(u_c ** 2) * mean(du_c ** 2) - mean(u_c * du_c) ** 2),
            1.0)))
    return out


def validate():
    """Second-moment formula vs a brute-force FFT on an untruncated Gaussian."""
    k, w, n, length = 2 * math.pi / LAM, 1.0, 2048, 12.0
    x = (np.arange(n) - n // 2) * (length / n)
    h = length / n
    xx, yy = np.meshgrid(x, x, indexing="xy")
    amp = np.exp(-(xx ** 2 + yy ** 2) / w ** 2)
    cases = {
        "flat": np.zeros_like(xx),
        "defocus": k * (xx ** 2 + yy ** 2) / 1000.0,
        "astigmatism": k * (xx ** 2 - yy ** 2) / 1600.0,
        "cubic 2 wave/mm3": 2 * math.pi * 2.0 * xx ** 3,
        "trefoil 1 wave": 2 * math.pi * 1.0 * (xx ** 3 - 3 * xx * yy ** 2),
    }
    print(f"   {'case':<18}{'formula x/y':>18}{'FFT x/y':>18}")
    for name, phi in cases.items():
        inten = amp ** 2
        s = inten.sum()

        def mean(f, _i=inten, _s=s):
            return float((_i * f).sum() / _s)

        phiy, phix = np.gradient(phi, h, h)
        spec = np.fft.fftshift(np.fft.fft2(np.fft.ifftshift(amp * np.exp(1j * phi))))
        fr = np.fft.fftshift(np.fft.fftfreq(n, h))
        fx, fy = np.meshgrid(fr, fr, indexing="xy")
        j2 = np.abs(spec) ** 2
        sj = j2.sum()

        def meanf(f, _j=j2, _s=sj):
            return float((_j * f).sum() / _s)

        f_out, g_out = [], []
        for u, du, t in ((xx, phix, fx * LAM), (yy, phiy, fy * LAM)):
            du_c, u_c = du - mean(du), u - mean(u)
            vu, vd, cov = mean(u_c ** 2), mean(du_c ** 2), mean(u_c * du_c)
            f_out.append(math.sqrt(max(1 + 4 * (vu * vd - cov ** 2), 1.0)))
            vt = meanf(t ** 2) - meanf(t) ** 2
            g_out.append(4 * math.pi / LAM
                         * math.sqrt(max(vu * vt - (cov / k) ** 2, 0.0)))
        print(f"   {name:<18}{f_out[0]:9.3f}{f_out[1]:9.3f}"
              f"{g_out[0]:9.3f}{g_out[1]:9.3f}")


def pupil_scan(col="OUT_1520"):
    """How the derived mode moves with the assumed Zernike pupil radius.

    1/R scales as 1/a^2 and the trefoil edge slope dW/dr|r=a = 8.485*c6*lam/a
    as 1/a, so the pupil sets both the curvature AND whether the capture was
    inside the sensor's dynamic range at all."""
    c4, c5, c6 = c(col, 4), c(col, 5), c(col, 6)
    kx = 4*math.sqrt(3)*c4 + 2*math.sqrt(6)*c5
    ky = 4*math.sqrt(3)*c4 - 2*math.sqrt(6)*c5
    wx, wy = W_MEAS["x"], W_MEAS["y"]
    print(f"   measured at z={Z_MEAS:.0f} mm:  w_x={wx:.3f} mm  w_y={wy:.3f} mm"
          f"   (model currently gives 3.50 mm on both axes)")
    print(f"   {'pupil a (mm)':<26}{'R_x':>9}{'R_y':>9}"
          f"{'modeX w0/off':>21}{'modeY w0/off':>21}{'m6 slope':>10}")
    for label, ax, ay in (
        ("3.500  README assumption", 3.5, 3.5),
        ("1.910  = y beam radius", 1.91, 1.91),
        ("1.372  = mean beam radius", 1.3718, 1.3718),
        ("0.834  = x beam radius", 0.8335, 0.8335),
        ("elliptical  a_x / a_y", 0.8335, 1.91),
    ):
        rx, ry = ax**2/(kx*LAM), ay**2/(ky*LAM)
        x0, xo = mode_from_w_and_R(wx, rx)
        y0, yo = mode_from_w_and_R(wy, ry)
        slope = 8.485*abs(c6)*LAM/max(ax, ay)*1000.0
        flag = "OVER" if slope > SLOPE_LIMIT_MRAD else "ok"
        print(f"   {label:<26}{rx:9.1f}{ry:9.1f}"
              f"{x0:11.1f}um{xo:8.1f}mm{y0:11.1f}um{yo:8.1f}mm"
              f"{slope:7.1f} {flag}")
    print(f"   dynamic-range limit = {SLOPE_LIMIT_MRAD} mrad")


# --- the 2026-08-19 fit these formulas produced ---------------------------
# NOT what is stored today: the asset was re-fitted 2026-08-22 from the
# cylindrical-lens capture -- see docs/ta_out_wfs_cyl.py.
LIVE = {"X": (78.8, 1031.3), "Y": (140.8, -1800.9)}


if __name__ == "__main__":
    print("1. curvature -> GaussianMode  (w = 3.5 mm at z = 15 mm)")
    for col_ in ("OUT_1459", "OUT_1520"):
        rx, ry = curvature(col_)
        print(f"   {col_}: R_x={rx:9.1f}  R_y={ry:9.1f} mm")
        for lbl, radius in (("X", rx), ("Y", ry)):
            w0_, off_ = mode_from_w_and_R(A_OUT, radius)
            print(f"      mode{lbl}: waistUm={w0_:7.1f}  waistZOffsetMm={off_:9.1f}")

    print("\n2. what the 2026-08-19 params give back at z = 15 mm")
    for lbl, (w0_, off_) in LIVE.items():
        w_, r_ = mode_to_w_and_R(w0_, off_)
        print(f"   mode{lbl}: waistUm={w0_} off={off_}  ->  w={w_:.3f} mm  R={r_:9.1f} mm")

    print("\n3. second-moment estimator vs brute-force FFT")
    validate()

    print("\n4. M^2 from the residual wavefront (modes 6..15)")
    print(f"   {'column':<10}{'RMS resid':>11}{'M2_x':>8}{'M2_y':>8}")
    for col_ in ("IN_1505", "OUT_1459", "OUT_1520"):
        mx, my = m2(col_)
        rms = math.sqrt(sum(c(col_, j) ** 2 for j in RESIDUAL))
        print(f"   {col_:<10}{rms:11.3f}{mx:8.1f}{my:8.1f}")

    print("\n5. OUT_1520 per-mode contribution (each mode alone)")
    print(f"   {'j':>3} {'name':<16}{'c (waves)':>10}{'M2_x':>8}{'M2_y':>8}")
    for j_ in RESIDUAL:
        mx, my = m2("OUT_1520", [j_])
        print(f"   {j_:3d} {NAME[j_]:<16}{c('OUT_1520', j_):10.2f}{mx:8.1f}{my:8.1f}")

    print("\n6. sensitivity of the OUT_1520 M^2 to the assumed fill factor")
    for wa in (0.7, 0.85, 1.0, 1.2):
        mx, my = m2("OUT_1520", w_over_a=wa)
        print(f"   w/a={wa:4.2f}:  M2_x={mx:6.1f}  M2_y={my:6.1f}")

    print("\n7. the pupil radius is NOT 3.5 mm -- what that does to the mode")
    pupil_scan()
