"""2026-09-02 seed / TA-input spatial modes for the qmem twin.

Reproduces the numbers written to `Sacher_TEC400_852nm_TA.inputSpatialModeX/Y`
and `TS-2000-A.spatialModeX/Y` (see ta_seed_modes_0902.md).

Run:  python docs/ta_seed_modes_0902.py            # the analytic part (no DB)
      python docs/ta_seed_modes_0902.py --fit      # re-fit the DBR facet mode
                                                   # against the twin's collimator
                                                   # (needs the backend venv + DB)

Sign convention (Thorlabs WFS30, settled 2026-09-02 by a two-plane measurement):
P > 0 = DIVERGING, so R_gauss = +1000/P and 1/q = 1/R - i*lam/(pi*w^2).

Axis mapping: mode X lives on the anchor's axisY. For both `intercept_in` of the
TA and `intercept_out` of the DBR that axis is body +z = VERTICAL in the scene,
so WFS y (vertical) -> mode X and WFS x (horizontal) -> mode Y.
"""
import math
import sys

LAM = 852e-6      # mm, the wavelength the bench fits used


def q_from_wfs(diam_mm: float, p_dpt: float) -> complex:
    w = diam_mm / 2.0
    return 1.0 / complex(p_dpt / 1000.0, -LAM / (math.pi * w * w))


def mode_from_q(q0: complex) -> tuple[float, float]:
    """(waistUm, waistZOffsetMm) for an EMITTED beam whose q at the emit anchor
    is q0: Re(q) = -waistZOffsetMm, Im(q) = z_R."""
    return math.sqrt(q0.imag * LAM / math.pi) * 1e3, -q0.real


def w2_at(q: complex, z: float) -> float:
    return 2.0 * math.sqrt(-LAM / (math.pi * (1.0 / (q + z)).imag))


# ---------------------------------------------------------------- TA input mode
# repump input3.csv, 2026-09-01 15:35, WFS 25 mm outward of intercept_in, facing
# the TA. Core (r < 0.5 mm) fit of the raw wavefront; the file's own full-pupil
# optometric block is over range (Cyl -10 dpt) and must not be used.
TA_MEAS = {"vertical": (1.635, -4.10), "horizontal": (1.781, -0.60)}   # (2w mm, P dpt)
Z_WFS = 25.0

print("TA input mode (beam EMITTED by intercept_in, waistZOffsetMm outward):")
ta_mode = {}
for axis, (d, p) in TA_MEAS.items():
    q_facet = q_from_wfs(d, p) - Z_WFS
    w0, zoff = mode_from_q(q_facet)
    ta_mode[axis] = (w0, zoff)
    key = "inputSpatialModeX" if axis == "vertical" else "inputSpatialModeY"
    print("   %-10s -> %s = {waistUm %.2f, waistZOffsetMm %+.1f}   check @25 mm: 2w %.3f, P %+.2f dpt"
          % (axis, key, w0, zoff, w2_at(q_facet, Z_WFS), 1000 * (1 / (q_facet + Z_WFS)).real))
print("   the seed must be the TIME REVERSE: at 25 mm before the facet 1.781 x 1.635 mm, P +0.60 / +4.10 dpt (diverging).")

# ---------------------------------------------------------------- DBR seed
# dbr21.csv (path 525 mm) + dbr27.csv (path 675 mm), 2026-09-02, same exposure,
# no optics between. Joint Gaussian fit: virtual waists behind the DBR exit face.
DBR_FIT = {"vertical": (0.510, -457.0), "horizontal": (0.338, -195.0)}   # (w0 mm, waist path mm)
DBR_MEAS = {525: {"horizontal": 1.317, "vertical": 1.468}, 675: {"horizontal": 1.571, "vertical": 1.570}}
print("\nDBR collimated beam (hole 0 = collimator exit):")
for axis, (w0, z0) in DBR_FIT.items():
    q0 = complex(-z0, math.pi * w0 * w0 / LAM)
    print("   %-10s w0 %.3f mm @ %+.0f mm : 2w(525) %.3f (meas %.3f)  2w(675) %.3f (meas %.3f)"
          % (axis, w0, z0, w2_at(q0, 525), DBR_MEAS[525][axis], w2_at(q0, 675), DBR_MEAS[675][axis]))

# Facet mode stored on TS-2000-A (fitted with --fit against LENS_PLANO_CONVEX2,
# f 4.51 / n 1.59 / 2.75 mm thick, 4.98 mm from the facet in the live scene):
DBR_FACET = {"spatialModeX (vertical)": (2.164, +0.032), "spatialModeY (horizontal)": (3.278, +0.042)}
for k, v in DBR_FACET.items():
    print("   stored %s = {waistUm %.3f, waistZOffsetMm %+.3f}" % (k, *v))

if "--fit" in sys.argv:
    import asyncio, dataclasses, os
    from scipy.optimize import least_squares
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
    os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://qmem:qmem_password@localhost:55432/qmem_twin")
    from app.db import AsyncSessionLocal
    from app.optical import anchor_ops  # noqa: F401
    from app.optical.db_scene_loader import load_anchor_scene_from_db
    from app.optical.solver import solve_anchor_scene
    from app.optical.anchor_tracer import V3AnchorScene

    async def _load():
        async with AsyncSessionLocal() as s:
            return await load_anchor_scene_from_db(s)
    scene = asyncio.run(_load())
    dbr = next(s for s in scene.slots if s.asset.kind == "laser_source" and "spatialModeX" in s.asset.default_params
               and abs(float(s.asset.default_params.get("centerWavelengthNm", 0)) - 852.347) < 0.01)
    lens = next(s for s in scene.slots if s.asset.kind == "lens_plano_convex"
                and abs(float(s.asset.default_params.get("focalLengthMm", 0)) - 4.51) < 0.01)
    lam_twin = float(dbr.asset.default_params["centerWavelengthNm"]) * 1e-6

    def post_lens_q(wx, zx, wy, zy):
        dp = dict(dbr.asset.default_params)
        dp["spatialModeX"] = {"waistUm": wx, "mSquared": 1.0, "waistZOffsetMm": zx}
        dp["spatialModeY"] = {"waistUm": wy, "mSquared": 1.0, "waistZOffsetMm": zy}
        slot = dataclasses.replace(dbr, asset=dataclasses.replace(dbr.asset, default_params=dp))
        res = solve_anchor_scene(V3AnchorScene(slots=[slot, lens]))
        segs = sorted((s for s in res.lab_segments if s.emitter_scene_object_id == dbr.scene_object_id),
                      key=lambda s: s.path_length_mm_at_start)
        post = segs[-1]
        return complex(post.qx_re_at_start, post.qx_im_at_start), complex(post.qy_re_at_start, post.qy_im_at_start)

    tx = complex(-DBR_FIT["vertical"][1], math.pi * DBR_FIT["vertical"][0] ** 2 / lam_twin)
    ty = complex(-DBR_FIT["horizontal"][1], math.pi * DBR_FIT["horizontal"][0] ** 2 / lam_twin)

    def resid(p):
        qx, qy = post_lens_q(*p)
        return [(qx.real - tx.real) / 100, (qx.imag - tx.imag) / 100, (qy.real - ty.real) / 100, (qy.imag - ty.imag) / 100]
    sol = least_squares(resid, x0=[2.0, 0.0, 3.0, 0.0], x_scale=[1, 0.01, 1, 0.01], xtol=1e-12, ftol=1e-12)
    print("\n--fit: spatialModeX = {waistUm %.3f, waistZOffsetMm %+.3f}, spatialModeY = {waistUm %.3f, waistZOffsetMm %+.3f}  (cost %.1e)"
          % (sol.x[0], sol.x[1], sol.x[2], sol.x[3], sol.cost))
