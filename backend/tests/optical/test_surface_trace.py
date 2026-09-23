"""Phase 1 of docs/surface-optics.md: tracing through real surfaces.

Each case checks the surface engine against something derived independently:
closed-form optics (plate displacement, Brewster, Kogelnik's tilted-plate
astigmatism, retardance of a tilted waveplate), the existing thick-lens
ABCD golden, and an exact finite ray fan for the oblique-incidence focus.
"""

from __future__ import annotations

import cmath
import math

import pytest

from app.optical.anchor_ops.lens import _q_after_abcd, _thick_lens_abcd
from app.optical.beam_ray import BeamRay, Vec3, make_beam_ray
from app.optical.jones import beam_local_sp, jones_intensity
from app.optical.surfaces import parse_surface_model, trace_element
from app.optical.surfaces.geometry import intersect
from app.optical.surfaces.materials import UNIAXIAL

LAM = 780.0
X = {"x": 1, "y": 0, "z": 0}
Y = {"x": 0, "y": 1, "z": 0}
Z = {"x": 0, "y": 0, "z": 1}


def surf(sid, x, front, back, *, normal=X, axis_y=Y, shape=None, radius=12.7, coating=None, pos=None):
    s = {
        "id": sid,
        "positionMmBodyLocal": pos or {"x": x, "y": 0, "z": 0},
        "axisXBodyLocal": normal,
        "axisYBodyLocal": axis_y,
        "shape": shape or {"type": "plane"},
        "aperture": {"shape": "circle", "radiusMm": radius},
        "front": front,
        "back": back,
    }
    if coating:
        s["coating"] = coating
    return s


def plate(n=1.5, thickness=5.0, **media):
    return parse_surface_model({
        "media": {"glass": media or {"n": n}},
        "surfaces": [surf("A", 0.0, "glass", "air"), surf("B", thickness, "air", "glass")],
    })


def beam(direction=Vec3(1, 0, 0), origin=None, waist=0.5, jones=(1 + 0j, 0j)) -> BeamRay:
    d = direction.normalized()
    return make_beam_ray(
        origin=origin or d * -20.0, direction=d, wavelength_nm=LAM,
        waist_radius_mm=waist, power_mw=1.0, jones=jones,
    )


def tilted(theta_deg: float) -> Vec3:
    """Tilted in the x–y plane, so the plane of incidence is horizontal and
    the canonical s axis (world +z) is the SAGITTAL axis."""
    t = math.radians(theta_deg)
    return Vec3(math.cos(t), math.sin(t), 0.0)


def only_exit(res):
    assert len(res.exits) == 1, (res.exits, res.lost)
    return res.exits[0]


# ---------------------------------------------------------------------------
# Plane-parallel plate
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("theta", [0.0, 10.0, 30.0, 56.3])
def test_tilted_plate_displaces_without_deviating(theta):
    n, L = 1.5, 5.0
    d = tilted(theta)
    ray = beam(d)
    out = only_exit(trace_element(plate(n, L), ray))
    th = math.radians(theta)
    shift = L * math.sin(th) * (1 - math.cos(th) / math.sqrt(n * n - math.sin(th) ** 2))
    # perpendicular distance between the incoming line and the outgoing line
    rel = out.origin - ray.origin
    perp = rel - d * rel.dot(d)
    assert out.direction.dot(d) == pytest.approx(1.0, abs=1e-14)
    assert perp.length() == pytest.approx(shift, abs=1e-12)


def test_path_length_is_geometric():
    n, L, theta = 1.5, 5.0, 30.0
    d = tilted(theta)
    ray = beam(d)
    res = trace_element(plate(n, L), ray)
    out = only_exit(res)
    (seg,) = res.segments
    th = math.radians(theta)
    cos_t = math.sqrt(1 - (math.sin(th) / n) ** 2)
    assert (seg.end - seg.ray.origin).length() == pytest.approx(L / cos_t, abs=1e-12)
    to_entry = seg.ray.origin - ray.origin
    assert out.path_length_mm == pytest.approx(to_entry.length() + L / cos_t, abs=1e-12)


def test_brewster_plate_is_kogelnik_astigmatic():
    """Kogelnik: a plate of thickness L at Brewster acts as air of length
    L·√(n²+1)/n² sagittally and L·√(n²+1)/n⁴ tangentially."""
    n, L = 1.5, 5.0
    d = tilted(math.degrees(math.atan(n)))
    ray = beam(d, waist=0.3)
    res = trace_element(plate(n, L), ray)
    out = only_exit(res)
    entry_air = (res.segments[0].ray.origin - ray.origin).length()
    q0 = ray.qx
    # At the exit point the beam has crossed entry_air of air and the plate.
    # Canonical s is world z here, i.e. the sagittal axis.
    s_eff = L * math.sqrt(n * n + 1) / (n * n)
    t_eff = L * math.sqrt(n * n + 1) / n ** 4
    assert out.qx == pytest.approx(q0 + entry_air + s_eff, abs=1e-9)
    assert out.qy == pytest.approx(q0 + entry_air + t_eff, abs=1e-9)
    assert abs(out.qxy) < 1e-12


def test_brewster_p_is_lossless_and_s_is_not():
    n = 1.5
    d = tilted(math.degrees(math.atan(n)))
    s_axis, p_axis = beam_local_sp(d)
    assert abs(s_axis.z) == pytest.approx(1.0)   # s is the sagittal axis
    p_out = only_exit(trace_element(plate(n), beam(d, jones=(0j, 1 + 0j))))
    s_out = only_exit(trace_element(plate(n), beam(d, jones=(1 + 0j, 0j))))
    assert p_out.power_mw == pytest.approx(1.0, abs=1e-12)
    # two uncoated surfaces at Brewster: T_s = 1 − r_s² per face
    ci = 1 / math.sqrt(1 + n * n)
    ct = n / math.sqrt(1 + n * n)
    r_s = (ci - n * ct) / (ci + n * ct)
    assert s_out.power_mw == pytest.approx((1 - r_s ** 2) ** 2, abs=1e-12)


def test_normal_incidence_fresnel_and_ar_coating():
    n = 1.5
    r = ((n - 1) / (n + 1)) ** 2
    out = only_exit(trace_element(plate(n), beam()))
    assert out.power_mw == pytest.approx((1 - r) ** 2, abs=1e-14)
    coated = parse_surface_model({
        "media": {"glass": {"n": n}},
        "surfaces": [
            surf("A", 0.0, "glass", "air", coating={"type": "ar", "reflectance": 0.0025}),
            surf("B", 5.0, "air", "glass", coating={"type": "ar", "reflectance": 0.0025}),
        ],
    })
    assert only_exit(trace_element(coated, beam())).power_mw == pytest.approx(0.9975 ** 2, abs=1e-14)


def test_reverse_traversal_is_symmetric():
    n, L = 1.5, 5.0
    fwd = beam(tilted(20.0))
    back_dir = Vec3(-math.cos(math.radians(20)), math.sin(math.radians(20)), 0.0)
    rev = beam(back_dir, origin=Vec3(25.0, -5.0, 0.0))
    a = only_exit(trace_element(plate(n, L), fwd))
    b = only_exit(trace_element(plate(n, L), rev))
    assert a.power_mw == pytest.approx(b.power_mw, abs=1e-14)
    assert b.direction.dot(back_dir) == pytest.approx(1.0, abs=1e-14)
    rel_a, rel_b = a.origin - fwd.origin, b.origin - rev.origin
    perp_a = rel_a - fwd.direction * rel_a.dot(fwd.direction)
    perp_b = rel_b - back_dir * rel_b.dot(back_dir)
    assert perp_a.length() == pytest.approx(perp_b.length(), abs=1e-12)


# ---------------------------------------------------------------------------
# Total internal reflection: right-angle prism
# ---------------------------------------------------------------------------

def right_angle_prism(n=1.5168):
    s2 = math.sqrt(0.5)
    return parse_surface_model({
        "media": {"glass": {"n": n}},
        "surfaces": [
            # entry leg, facing −x (normal +x points into the glass)
            surf("in", 0.0, "glass", "air", radius=20.0),
            # hypotenuse x + y = 10, normal (1, 1, 0)/√2: glass on the −normal side
            surf("hyp", 0.0, "air", "glass", pos={"x": 10, "y": 0, "z": 0},
                 normal={"x": s2, "y": s2, "z": 0}, axis_y={"x": -s2, "y": s2, "z": 0}, radius=30.0),
            # exit leg, the plane y = −10 with normal −y: glass above it
            surf("out", 0.0, "air", "glass", pos={"x": 0, "y": -10, "z": 0},
                 normal={"x": 0, "y": -1, "z": 0}, axis_y=X, radius=30.0),
        ],
    })


def test_right_angle_prism_turns_the_beam_by_tir():
    n = 1.5168
    res = trace_element(right_angle_prism(n), beam(Vec3(1, 0, 0), origin=Vec3(-20, 0, 0)))
    out = only_exit(res)
    assert out.direction.dot(Vec3(0, -1, 0)) == pytest.approx(1.0, abs=1e-14)
    t_face = 1 - ((n - 1) / (n + 1)) ** 2
    # TIR is lossless; only the two normal-incidence faces cost power
    assert out.power_mw == pytest.approx(t_face ** 2, abs=1e-12)
    assert [seg.medium for seg in res.segments] == ["glass", "glass"]


def test_tir_phase_matches_fresnel():
    """Past the critical angle |r_s| = |r_p| = 1 and the s–p phase difference
    is the textbook 2·atan(cosθ·√(sin²θ − 1/n²)/sin²θ)."""
    from app.optical.surfaces.interface import fresnel

    n, th = 1.5168, math.radians(45)
    sin2_t = (n * math.sin(th)) ** 2
    ct = 1j * math.sqrt(sin2_t - 1)
    r_s, r_p, _, _ = fresnel(n, 1.0, math.cos(th), ct)
    assert abs(r_s) == pytest.approx(1.0) and abs(r_p) == pytest.approx(1.0)
    dphi = cmath.phase(r_s / r_p)
    expect = 2 * math.atan(math.cos(th) * math.sqrt(math.sin(th) ** 2 - 1 / n ** 2) / math.sin(th) ** 2)
    assert abs(dphi) == pytest.approx(expect, abs=1e-12)


# ---------------------------------------------------------------------------
# Lenses
# ---------------------------------------------------------------------------

LA1509 = dict(r1=51.5, n=1.5168, d=3.6)


def la1509():
    return parse_surface_model({
        "media": {"glass": {"n": LA1509["n"]}},
        "surfaces": [
            surf("A", 0.0, "glass", "air", shape={"type": "sphere", "radiusMm": LA1509["r1"]}),
            surf("B", LA1509["d"], "air", "glass"),
        ],
    })


def test_la1509_matches_the_thick_lens_golden():
    ray = beam(waist=1.0)
    res = trace_element(la1509(), ray)
    out = only_exit(res)
    assert out.origin.x == pytest.approx(LA1509["d"], abs=1e-12)
    assert out.direction.dot(Vec3(1, 0, 0)) == pytest.approx(1.0, abs=1e-15)
    a, b, c, dd = _thick_lens_abcd(LA1509["r1"], None, LA1509["n"], LA1509["d"])
    q_front = ray.qx + 20.0
    expect = _q_after_abcd(q_front, a, b, c, dd)
    assert out.qx == pytest.approx(expect, rel=1e-12)
    assert out.qy == pytest.approx(expect, rel=1e-12)


def test_decentred_lens_steers_by_d_over_f():
    efl = LA1509["r1"] / (LA1509["n"] - 1)
    h = 0.5
    out = only_exit(trace_element(la1509(), beam(origin=Vec3(-20, h, 0))))
    angle = math.atan2(out.direction.y, out.direction.x)
    assert angle == pytest.approx(-h / efl, rel=2e-3)


def test_single_tilted_surface_focus_matches_an_exact_ray_fan():
    """Coddington at a tilted sphere, checked against real rays: a parallel
    beam refracted by one spherical surface into glass (a 'solid' lens) focuses
    at different tangential and sagittal distances; the Q the engine carries
    must agree with where exactly-traced neighbour rays cross the chief ray."""
    from app.optical.surfaces.interface import interact

    n, R = 1.5168, 40.0

    theta = math.radians(25.0)
    one = parse_surface_model({
        "media": {"glass": {"n": n}},
        "surfaces": [surf("A", 0.0, "glass", "air", shape={"type": "sphere", "radiusMm": R}, radius=20.0)],
    })
    s = one.surfaces[0]
    d = tilted(25.0)

    def refract(origin):
        r = make_beam_ray(origin=origin, direction=d, wavelength_nm=LAM, waist_radius_mm=1e3)
        h = intersect(s, r.origin, r.direction)
        (o,), _ = interact(r.replaced(origin=h.point, qx=complex(0, 1e9), qy=complex(0, 1e9)), h, s, one)
        return o.ray

    # a collimated input: huge Rayleigh range, so Re(Q⁻¹) ≈ 0
    chief = refract(Vec3(0, 0, 0) - d * 20.0)
    qinv = chief.q_matrix.as_mat2().inverse()
    # reduced: Re(Q̂⁻¹) = −n/f  (converging) → f = −n/Re
    f_sag = -n / qinv.xx.real
    f_tan = -n / qinv.yy.real

    def crossing(offset_dir):
        """Where a parallel neighbour ray, refracted exactly, meets the chief
        ray — measured along the chief from its exit point. Solved in the
        plane transverse to the chief (not via 1 − (a·b)², which cancels
        catastrophically for nearly parallel lines)."""
        eps = 1e-4
        m = refract(Vec3(0, 0, 0) - d * 20.0 + offset_dir * eps)
        a = chief.direction
        w0 = m.origin - chief.origin
        db = m.direction - a
        w_perp = w0 - a * a.dot(w0)
        b_perp = db - a * a.dot(db)
        u = -w_perp.dot(b_perp) / b_perp.dot(b_perp)
        return a.dot(w0 + m.direction * u)

    in_s, in_p = beam_local_sp(d)   # sagittal = in_s (world z), tangential = in_p
    assert crossing(in_s) == pytest.approx(f_sag, rel=1e-9)
    assert crossing(in_p) == pytest.approx(f_tan, rel=1e-5)   # residual: coma, O(eps)
    ct = math.sqrt(1 - (math.sin(theta) / n) ** 2)
    delta = n * ct - math.cos(theta)
    assert f_sag == pytest.approx(n * R / delta, rel=1e-6)          # Coddington sagittal
    assert f_tan == pytest.approx(n * R * ct ** 2 / delta, rel=1e-6)  # Coddington tangential


def test_cylinder_focuses_one_axis_only():
    model = parse_surface_model({
        "media": {"glass": {"n": 1.5}},
        "surfaces": [
            surf("A", 0.0, "glass", "air", shape={"type": "cylinder", "radiusMm": 25.0}),
            surf("B", 3.0, "air", "glass"),
        ],
    })
    out = only_exit(trace_element(model, beam(waist=1.0)))
    q_air = beam(waist=1.0).qx + 20.0 + 3.0 / 1.5   # the unpowered axis: a slab
    # curvature along the surface's y (world y); canonical s is world z here
    assert out.qx == pytest.approx(q_air, rel=1e-12)
    assert out.qy != pytest.approx(q_air, rel=1e-3)
    assert abs(out.qxy) < 1e-12


# ---------------------------------------------------------------------------
# Mirrors, beam splitters
# ---------------------------------------------------------------------------

def mirror(shape=None, normal=None, axis_y=Y, reflectance=0.99):
    return parse_surface_model({
        "surfaces": [surf("M", 0.0, "air", "opaque", normal=normal or {"x": -1, "y": 0, "z": 0},
                          axis_y=axis_y, shape=shape,
                          coating={"type": "hr", "reflectance": reflectance})],
    })


def test_flat_mirror_at_45_degrees():
    s2 = math.sqrt(0.5)
    m = mirror(normal={"x": -s2, "y": s2, "z": 0}, axis_y={"x": s2, "y": s2, "z": 0})
    out = only_exit(trace_element(m, beam()))
    assert out.direction.dot(Vec3(0, 1, 0)) == pytest.approx(1.0, abs=1e-14)
    assert out.power_mw == pytest.approx(0.99, abs=1e-14)


def test_concave_mirror_focal_length_is_r_over_2():
    R = 200.0   # concave toward the beam: centre on the air (+axisX) side, R > 0
    m = mirror(shape={"type": "sphere", "radiusMm": R})
    ray = beam(waist=2.0)
    out = only_exit(trace_element(m, ray))
    assert out.direction.dot(Vec3(-1, 0, 0)) == pytest.approx(1.0, abs=1e-15)
    q_at = ray.qx + 20.0
    expect = q_at / (1 - q_at / (R / 2))   # thin lens f = R/2
    assert out.qx == pytest.approx(expect, rel=1e-12)
    assert out.qy == pytest.approx(expect, rel=1e-12)


def test_back_of_a_mirror_absorbs():
    res = trace_element(mirror(), beam(Vec3(-1, 0, 0), origin=Vec3(20, 0, 0)))
    assert res.exits == [] and res.absorbed_mw == pytest.approx(1.0)


def pbs_cube(size=10.0, n=1.5168, pp_db=None, sp_db=None):
    s2 = math.sqrt(0.5)
    h = size / 2
    coating = {"type": "polarizing"}
    if pp_db is not None:
        coating["extinctionRatioPpDb"] = pp_db
    if sp_db is not None:
        coating["extinctionRatioSpDb"] = sp_db
    face = {"type": "ar", "reflectance": 0.0}
    return parse_surface_model({
        "media": {"g1": {"n": n}, "g2": {"n": n}},
        "surfaces": [
            surf("in", -h, "g1", "air", coating=face, radius=h),
            # hypotenuse through the centre, normal (1, 1, 0)/√2; g1 is the −x prism
            surf("hyp", 0.0, "g2", "g1", normal={"x": s2, "y": s2, "z": 0},
                 axis_y={"x": -s2, "y": s2, "z": 0}, radius=h * 1.5, coating=coating),
            surf("t_out", h, "air", "g2", coating=face, radius=h),
            # the reflected port: the face y = −h, normal −y, g1 above it
            surf("r_out", 0.0, "air", "g1", pos={"x": 0, "y": -h, "z": 0},
                 normal={"x": 0, "y": -1, "z": 0}, axis_y=X, coating=face, radius=h),
            # the two unused faces close the cube
            surf("g2_side", 0.0, "air", "g2", pos={"x": 0, "y": h, "z": 0},
                 normal={"x": 0, "y": 1, "z": 0}, axis_y=X, coating=face, radius=h),
        ],
    })


def test_pbs_transmits_p_and_reflects_s():
    # beam along +x in the x–y plane: canonical s = world z, which is also the
    # s of the hypotenuse's plane of incidence (normal in x–y)
    t = trace_element(pbs_cube(), beam(origin=Vec3(-20, 0, 0), jones=(0j, 1 + 0j)))
    r = trace_element(pbs_cube(), beam(origin=Vec3(-20, 0, 0), jones=(1 + 0j, 0j)))
    t_out, r_out = only_exit(t), only_exit(r)
    assert t_out.direction.dot(Vec3(1, 0, 0)) == pytest.approx(1.0, abs=1e-14)
    assert r_out.direction.dot(Vec3(0, -1, 0)) == pytest.approx(1.0, abs=1e-14)
    assert t_out.power_mw == pytest.approx(1.0, abs=1e-14)
    assert r_out.power_mw == pytest.approx(1.0, abs=1e-14)


def test_pbs_extinction_leaks_into_the_other_port():
    res = trace_element(pbs_cube(pp_db=30.0), beam(origin=Vec3(-20, 0, 0), jones=(1 + 0j, 0j)))
    powers = sorted(o.power_mw for o in res.exits)
    assert powers == pytest.approx([1e-3, 1 - 1e-3], abs=1e-14)


# ---------------------------------------------------------------------------
# Waveplates
# ---------------------------------------------------------------------------

def quartz_plate(thickness, optic_axis=Z):
    return parse_surface_model({
        "media": {"quartz": {"material": "crystal_quartz", "opticAxis": optic_axis}},
        "surfaces": [
            surf("A", 0.0, "quartz", "air", coating={"type": "ar", "reflectance": 0.0}),
            surf("B", thickness, "air", "quartz", coating={"type": "ar", "reflectance": 0.0}),
        ],
    })


def quartz_indices(lam=LAM):
    o, e = UNIAXIAL["crystal_quartz"]
    return o.n(lam), e.n(lam)


def half_wave_thickness(lam=LAM):
    n_o, n_e = quartz_indices(lam)
    return lam * 1e-6 / (2 * (n_e - n_o))


def test_zero_order_hwp_flips_45_degree_linear():
    # optic axis = world z = canonical s for a +x beam; input at +45°
    j = (complex(math.sqrt(0.5)), complex(math.sqrt(0.5)))
    out = only_exit(trace_element(quartz_plate(half_wave_thickness()), beam(jones=j)))
    e_s, e_p = out.jones
    # a half-wave plate with its axis on s maps (1, 1)/√2 to (1, −1)/√2 up to a phase
    assert e_p / e_s == pytest.approx(-1.0, abs=1e-9)
    assert jones_intensity(out.jones) == pytest.approx(1.0, abs=1e-12)


def test_hwp_retardance_drifts_with_wavelength():
    L = half_wave_thickness(780.0)
    j = (complex(math.sqrt(0.5)), complex(math.sqrt(0.5)))
    ray = beam(jones=j).replaced(wavelength_nm=852.0)
    out = only_exit(trace_element(quartz_plate(L), ray))
    n_o, n_e = quartz_indices(852.0)
    expect = 2 * math.pi * (n_e - n_o) * L / (852.0 * 1e-6)
    assert cmath.phase(out.jones[0] / out.jones[1]) == pytest.approx(expect, abs=1e-9)


def test_tilted_waveplate_retardance_matches_the_exact_formula_to_first_order():
    """Tilt about the optic axis (k stays ⊥ c). Exact:
    δ = k₀·L·(√(n_e² − sin²θ) − √(n_o² − sin²θ)). The single-chief-ray model
    refracts with n_o and is exact to first order in (n_e − n_o)."""
    L = half_wave_thickness()
    n_o, n_e = quartz_indices()
    k0 = 2 * math.pi / (LAM * 1e-6)
    j = (complex(math.sqrt(0.5)), complex(math.sqrt(0.5)))
    for deg in (10.0, 20.0, 30.0):
        th = math.radians(deg)
        out = only_exit(trace_element(quartz_plate(L), beam(tilted(deg), jones=j)))
        got = cmath.phase(out.jones[0] / out.jones[1]) % (2 * math.pi)
        exact = k0 * L * (math.sqrt(n_e ** 2 - math.sin(th) ** 2) - math.sqrt(n_o ** 2 - math.sin(th) ** 2))
        assert got == pytest.approx(exact, rel=1e-3)
        assert got > math.pi   # tilting a zero-order plate adds retardance


# ---------------------------------------------------------------------------
# Robustness
# ---------------------------------------------------------------------------

def test_a_ray_that_misses_comes_back_unchanged():
    ray = beam(origin=Vec3(-20, 50, 0))
    res = trace_element(plate(), ray)
    assert res.exits == [ray] and res.segments == []


def test_a_ray_through_the_rim_is_lost_not_silently_passed():
    """Face A's aperture is smaller than face B's: a ray outside A but inside
    B meets B from its glass side while in air — the part's edge."""
    model = parse_surface_model({
        "media": {"glass": {"n": 1.5}},
        "surfaces": [surf("A", 0.0, "glass", "air", radius=2.0), surf("B", 5.0, "air", "glass", radius=10.0)],
    })
    res = trace_element(model, beam(origin=Vec3(-20, 5, 0)))
    assert res.exits == [] and res.lost_mw == pytest.approx(1.0)
    assert "from its 'glass' side" in res.lost[0]


def test_conic_with_zero_k_equals_the_sphere():
    def lens(shape):
        return parse_surface_model({
            "media": {"glass": {"n": 1.5168}},
            "surfaces": [surf("A", 0.0, "glass", "air", shape=shape), surf("B", 3.6, "air", "glass")],
        })
    ray = beam(origin=Vec3(-20, 1.0, 0.5), waist=0.8)
    a = only_exit(trace_element(lens({"type": "sphere", "radiusMm": 51.5}), ray))
    b = only_exit(trace_element(lens({"type": "conic", "radiusMm": 51.5, "conic": 0.0}), ray))
    assert (a.origin - b.origin).length() < 1e-10
    assert a.direction.dot(b.direction) == pytest.approx(1.0, abs=1e-14)
    assert a.qx == pytest.approx(b.qx, rel=1e-9) and a.qy == pytest.approx(b.qy, rel=1e-9)
    assert a.qxy == pytest.approx(b.qxy, abs=1e-9)


def la1509_b_step():
    """The surface model written to the `la1509_b_step` asset (2026-09-23),
    from its CAD mesh: flat face at z = 0, a sphere-fit dome (R = 51.500,
    residual 1.7e-7 mm) with its apex at z = 3.59, N-BK7."""
    ar = {"type": "ar", "reflectance": 0.0025}
    zax, yax = {"x": 0, "y": 0, "z": 1}, {"x": 0, "y": 1, "z": 0}
    return parse_surface_model({
        "media": {"glass": {"material": "N-BK7"}},
        "surfaces": [
            surf("flat", 0.0, "glass", "air", pos={"x": 0, "y": 0, "z": 0.0},
                 normal=zax, axis_y=yax, coating=ar),
            surf("convex", 0.0, "air", "glass", pos={"x": 0, "y": 0, "z": 3.59},
                 normal=zax, axis_y=yax, shape={"type": "sphere", "radiusMm": -51.5}, coating=ar),
        ],
    })


@pytest.mark.parametrize("lam", [780.0, 852.0])
@pytest.mark.parametrize("direction", [1.0, -1.0])
def test_la1509_b_step_matches_thick_lens_both_ways(lam, direction):
    """Flat side first (+z) is R₂ = −51.5 at the exit; convex side first (−z)
    is R₁ = +51.5 at the entry. Both must equal the thick-lens ABCD with the
    dispersive N-BK7 index, and lose 0.25 % per face."""
    from app.optical.surfaces.materials import ISOTROPIC

    n = ISOTROPIC["N-BK7"].n(lam)
    d, R = 3.59, 51.5
    ray = make_beam_ray(origin=Vec3(0, 0, -50.0 * direction), direction=Vec3(0, 0, direction),
                        wavelength_nm=lam, waist_radius_mm=1.0)
    out = only_exit(trace_element(la1509_b_step(), ray))
    if direction > 0:
        a, b, c, dd = _thick_lens_abcd(None, -R, n, d)
        q_front, exit_z = ray.qx + 50.0, d
    else:
        a, b, c, dd = _thick_lens_abcd(R, None, n, d)
        q_front, exit_z = ray.qx + 50.0 - d, 0.0
    assert out.origin.z == pytest.approx(exit_z, abs=1e-12)
    assert out.qx == pytest.approx(_q_after_abcd(q_front, a, b, c, dd), rel=1e-12)
    assert out.power_mw == pytest.approx(0.9975 ** 2, abs=1e-14)
