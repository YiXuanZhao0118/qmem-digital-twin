"""Sacher_TEC400_852nm_TA output mode from the cylindrical-lens WFS capture.

Reproduces the numbers in the "2026-08-21: the cylindrical-lens capture"
section of sacher-tec400-852nm-ta-output-mode.md.
Run: python docs/ta_out_wfs_cyl.py

Source data: Thorlabs WFS30-5C/M + MLA150-5C, 2026-08-21 16:58:46, exported
as tst.csv. Geometry, z measured from intercept_out along the output axis:
f = 50 mm cylindrical lens with power on the VERTICAL axis at z = 100 mm,
sensor at z = 200 mm. 100 mm = 2f, so the vertical is imaged ~1:1 onto the
sensor -- which is exactly why the vertical wavefront is unusable (see 2.).

sensor x = horizontal = body +y = outputSpatialModeX  (no lens in this path)
sensor y = vertical   = body +z = outputSpatialModeY  (the lens acts here)
"""
import math

LAM = 852e-6          # mm
D_LENS, F_CYL, Z_WFS = 100.0, 50.0, 200.0
SLOPE_MAX = (150e-3 / 2) / 5.2        # 14.42 mrad -- MLA150-5C half-pitch / f

# --- straight out of tst.csv ----------------------------------------------
A_PUP = 1.402 / 2                     # *** PUPIL *** Pupil Diameter X/Y / 2
W_MEAS = {"X": 0.898 / 2, "Y": 1.768 / 2}      # *** BEAM *** Beam Diameter/2
C_DEFOCUS = +3.192                    # Index 5, (Order, Frequency) = (2,  0)
C_ASTIG0 = -4.248                     # Index 6,                      (2,  2)
C_ASTIG45 = -0.534                    # Index 4,                      (2, -2)
# NOTE the CSV's Index 1 is PISTON, so its Index is the ANSI j of
# ta_out_m2.py PLUS ONE. Reading the bar chart off a photo gets this wrong.

# 2026-08-20 panel diameters at z = 15 mm, free space -- the one earlier
# number that never went through a Shack-Hartmann fit.
W15 = {"X": 1.667 / 2, "Y": 3.820 / 2}

S3, S6 = math.sqrt(3.0), math.sqrt(6.0)

# --- stored values (asset b12b42ef / physics element ae4cf5a2) -------------
LIVE = {"X": (229.6, -126.7), "Y": (3.96, -12.91)}


def curvature(a=A_PUP):
    """(R_x, R_y) at the sensor. Sign convention: R > 0 = diverging, i.e.
    the negative of what the file's optometric block prints."""
    inv_rx = (4*S3*C_DEFOCUS + 2*S6*C_ASTIG0) * LAM / a**2
    inv_ry = (4*S3*C_DEFOCUS - 2*S6*C_ASTIG0) * LAM / a**2
    return 1.0/inv_rx, 1.0/inv_ry


def q_of(w, r):
    return 1.0 / complex(1.0/r, -LAM/(math.pi*w*w))


def back_to_source(q, lensed):
    """q at the sensor -> q at intercept_out."""
    if lensed:
        q = q - (Z_WFS - D_LENS)
        q = 1.0 / (1.0/q + 1.0/F_CYL)
        q = q - D_LENS
    else:
        q = q - Z_WFS
    return q


def mode_of(q):
    """(waistUm, waistZOffsetMm) from q expressed at z = 0."""
    return math.sqrt(q.imag * LAM / math.pi) * 1000.0, -q.real


def w_at(w0_um, z0, z, lensed=False):
    """Forward: beam radius at plane z for a stored mode."""
    w0 = w0_um / 1000.0
    q = complex(-z0, math.pi * w0 * w0 / LAM)
    if lensed:
        q = q + D_LENS
        q = 1.0 / (1.0/q - 1.0/F_CYL)
        q = q + (z - D_LENS)
    else:
        q = q + z
    return math.sqrt(-LAM / (math.pi * (1.0/q).imag))


def vertical_from_sizes(target200=None, target15=None):
    """The VERTICAL solved from two SIZE readings only -- no wavefront slope,
    so it survives the dynamic-range problem that kills the y Zernike fit.
    w(15 mm, free) and w(200 mm, through the lens) are two equations in
    (w0, z0). Returns the z0 < 0 branch (the z0 > 0 mirror image fits the
    sensor reading equally well but misses the 15 mm one by 10x)."""
    t200 = target200 if target200 is not None else W_MEAS["Y"]
    t15 = target15 if target15 is not None else W15["Y"]
    best = None
    for i in range(20000):
        w0 = (0.5 + i * 0.001) / 1000.0
        k = (t15 / w0) ** 2 - 1.0
        if k <= 0:
            continue
        zr = math.pi * w0 * w0 / LAM
        z0 = 15.0 - zr * math.sqrt(k)              # z0 < 0 branch
        err = w_at(w0 * 1000.0, z0, Z_WFS, True) - t200
        if best is None or abs(err) < abs(best[0]):
            best = (err, w0 * 1000.0, z0)
    return best[1], best[2]


if __name__ == "__main__":
    rx, ry = curvature()
    R = {"X": rx, "Y": ry}

    print("1. curvature at the sensor, and the file's own cross-checks")
    print(f"   R_x = {rx:+9.2f} mm     R_y = {ry:+9.3f} mm")
    # Thorlabs negates the whole block relative to this convention.
    print(f"   mean power {-(1/rx + 1/ry)/2*1000:+8.3f} dpt   "
          f"(file: Fourier M  = -38.361)")
    print(f"   J0         {-(1/rx - 1/ry)/2*1000:+8.3f} dpt   "
          f"(file: Fourier J0 =  36.093)")
    print(f"   astig axis {0.5*math.degrees(math.atan2(C_ASTIG45, C_ASTIG0)):+8.2f}"
          f" deg  (file: Optometric Axis 3.583, 90 deg convention offset)")

    print("\n2. dynamic range -- the two axes land on opposite sides of it")
    for ax in ("X", "Y"):
        s = A_PUP / abs(R[ax]) * 1000.0
        print(f"   {ax}: edge slope over the {2*A_PUP:.3f} mm pupil ="
              f" {s:6.1f} mrad -> "
              f"{'OK' if s <= SLOPE_MAX*1000 else 'OVER, fit is invalid'}")
    print(f"   limit {SLOPE_MAX*1000:.1f} mrad. The y wavefront column in the CSV"
          f" folds back below y = -0.9 mm: spot crossover, not a parabola.")

    print("\n3. inversion")
    for ax in ("X", "Y"):
        w0, z0 = mode_of(back_to_source(q_of(W_MEAS[ax], R[ax]), ax == "Y"))
        print(f"   mode{ax} from the wavefront: waistUm={w0:8.2f}"
              f"  waistZOffsetMm={z0:+8.2f}"
              f"  ({LAM/(math.pi*w0/1000)*1000:6.2f} mrad)"
              f"{'   <- OVER RANGE, not used' if ax == 'Y' else ''}")
    w0y, z0y = vertical_from_sizes()
    print(f"   modeY from the two SIZES:  waistUm={w0y:8.2f}"
          f"  waistZOffsetMm={z0y:+8.2f}"
          f"  ({LAM/(math.pi*w0y/1000)*1000:6.2f} mrad)   <- stored")

    print("\n4. forward check of the stored values")
    print(f"   {'':<10}{'2w @ 200 mm':>13}{'tst.csv':>10}"
          f"{'2w @ 15 mm':>13}{'2026-08-20':>12}")
    for ax, lensed, m200, m15 in (("modeX", False, 0.898, 1.667),
                                  ("modeY", True, 1.768, 3.820)):
        w0, z0 = LIVE[ax[-1]]
        print(f"   {ax:<10}{2*w_at(w0, z0, Z_WFS, lensed):11.3f}mm{m200:8.3f}mm"
              f"{2*w_at(w0, z0, 15.0):11.3f}mm{m15:10.3f}mm")
    print("   modeX misses the 2026-08-20 horizontal by 3x -- see the doc.")

    print("\n5. slope-free proof that the vertical waist is NOT at the facet")
    print("   (w0 = 2.13 um, the superseded value, scanned over z0)")
    for z0 in (0.0, -5.0, -12.91, -20.0):
        print(f"   z0 = {z0:+7.2f} mm -> 2w at the sensor ="
              f" {2*w_at(2.13, z0, Z_WFS, True):7.3f} mm   (measured 1.768)")
