"""The surface models written to the catalog's remaining free-space parts
(2026-09-23, docs/surface-optics.md "Converted so far"), rebuilt here from the
same geometry so the repo pins what the dev DB holds, and each checked for
the physics it must show.

Geometry: LD2297, the waveplates, the mirror and the cubes from their GLBs;
the Glan-laser prisms (procedural, no mesh) and the TGG rods (the GLB is
only the housing) from their params and anchors.
"""

from __future__ import annotations

import cmath
import math

import pytest

from app.optical.anchor_ops.lens import _q_after_abcd, _thick_lens_abcd
from app.optical.beam_ray import Vec3, make_beam_ray
from app.optical.surfaces import parse_surface_model, trace_element
from app.optical.surfaces.materials import ISOTROPIC, UNIAXIAL

LAM = 852.0
AR = {"type": "ar", "reflectance": 0.0025}
PLANE = {"type": "plane"}
S2 = math.sqrt(0.5)


def v(x, y, z):
    return {"x": float(x), "y": float(y), "z": float(z)}


def surf(sid, pos, normal, axis_y, shape, aperture, front, back, coating):
    return {"id": sid, "positionMmBodyLocal": pos, "axisXBodyLocal": normal, "axisYBodyLocal": axis_y,
            "shape": shape, "aperture": aperture, "front": front, "back": back, "coating": coating}


def circle(r):
    return {"shape": "circle", "radiusMm": r}


def rect(w, h):
    return {"shape": "rectangle", "widthMm": w, "heightMm": h}


def ld2297():
    z, y = v(0, 0, 1), v(0, 1, 0)
    return {"media": {"glass": {"material": "N-BK7"}}, "surfaces": [
        surf("A", v(0, 0, -1.5), z, y, {"type": "sphere", "radiusMm": -39.57}, circle(12.7), "glass", "air", AR),
        surf("B", v(0, 0, 1.5), z, y, {"type": "sphere", "radiusMm": 39.57}, circle(12.7), "air", "glass", AR),
    ]}


def zowp(waves):
    o, e = UNIAXIAL["crystal_quartz"]
    l1 = (2.1 + waves * LAM * 1e-6 / (e.n(LAM) - o.n(LAM))) / 2
    z, y = v(0, 0, 1), v(0, 1, 0)
    return {"media": {"q1": {"material": "crystal_quartz", "opticAxis": v(0, 1, 0)},
                      "q2": {"material": "crystal_quartz", "opticAxis": v(1, 0, 0)}},
            "surfaces": [
                surf("A", v(0, 0, -1.05), z, y, PLANE, circle(11.43), "q1", "air", AR),
                surf("C", v(0, 0, -1.05 + l1), z, y, PLANE, circle(11.43), "q2", "q1", {"type": "uncoated"}),
                surf("B", v(0, 0, 1.05), z, y, PLANE, circle(11.43), "air", "q2", AR),
            ]}


def bb1_e03():
    return {"surfaces": [surf("M", v(0, 0, 0), v(0, 0, 1), v(0, 1, 0), PLANE, circle(12.7), "air", "opaque",
                              {"type": "hr", "reflectance": 0.99})]}


def cube(half, normal, glass, coat):
    nx, ny = normal
    faces = []
    for sid, pos, nrm in (("px", (half, 0, 0), (1, 0, 0)), ("mx", (-half, 0, 0), (-1, 0, 0)),
                          ("py", (0, half, 0), (0, 1, 0)), ("my", (0, -half, 0), (0, -1, 0))):
        side = "g1" if (pos[0] * nx + pos[1] * ny) > 0 else "g2"
        faces.append(surf(sid, v(*pos), v(*nrm), v(0, 0, 1), PLANE, rect(2 * half, 2 * half), "air", side, AR))
    faces.append(surf("hyp", v(0, 0, 0), v(nx, ny, 0), v(0, 0, 1), PLANE,
                      rect(2 * half, 2 * half * math.sqrt(2)), "g1", "g2", coat))
    return {"media": {"g1": glass, "g2": dict(glass)}, "surfaces": faces}


CUBES = {
    "bs041_step": lambda: cube(6.35, (S2, S2), {"material": "N-BK7"}, {"type": "partial", "reflectance": 0.1}),
    "pbs055": lambda: cube(2.5, (S2, -S2), {"n": 1.693}, {"type": "polarizing", "extinctionRatioPpDb": 30,
                                                          "extinctionRatioSpDb": 30}),
    "pbs122_step": lambda: cube(6.35, (S2, S2), {"n": 1.693}, {"type": "polarizing", "extinctionRatioPpDb": 50,
                                                               "extinctionRatioSpDb": 30}),
    "pbs252_step": lambda: cube(12.7, (S2, -S2), {"n": 1.693}, {"type": "polarizing", "extinctionRatioPpDb": 30,
                                                                "extinctionRatioSpDb": 30}),
}


def glan_laser(length):
    nxg, nzg = 0.6225096458616945, -0.7826121266688548
    a = length * abs(nzg / nxg)
    gap = 0.02
    n, ay = v(nxg, 0, nzg), v(0, 1, 0)
    cc = {"material": "calcite", "opticAxis": v(1, 0, 0)}
    unc = {"type": "uncoated"}
    return {"media": {"p1": cc, "p2": dict(cc)}, "surfaces": [
        surf("in", v(0, 0, -length / 2), v(0, 0, 1), ay, PLANE, rect(a, a), "p1", "air", AR),
        surf("gap1", v(0, 0, 0), n, ay, PLANE, rect(a, math.hypot(a, length)), "p1", "air", unc),
        surf("gap2", v(-nxg * gap, 0, -nzg * gap), n, ay, PLANE, rect(a, math.hypot(a, length)), "air", "p2", unc),
        surf("out", v(0, 0, length / 2), v(0, 0, 1), ay, PLANE, rect(a, a), "air", "p2", AR),
        surf("escape1", v(a / 2, 0, 0), v(1, 0, 0), ay, PLANE, rect(a, length), "air", "p1", unc),
        surf("escape2", v(-a / 2, 0, 0), v(-1, 0, 0), ay, PLANE, rect(a, length), "air", "p2", unc),
    ]}


def tgg_rod(centre, axis, radius, ar_r):
    medium = {"n": 1.95, "faradayRotationDegPerMm": 45.0 / 18.0, "magneticAxis": v(*axis)}
    at = lambda t: v(*(c + a * t for c, a in zip(centre, axis)))    # noqa: E731
    ay = v(0, 1, 0)
    coat = {"type": "ar", "reflectance": ar_r}
    return {"media": {"tgg": medium}, "surfaces": [
        surf("A", at(-9.0), v(*axis), ay, PLANE, circle(radius), "tgg", "air", coat),
        surf("B", at(9.0), v(*axis), ay, PLANE, circle(radius), "air", "tgg", coat),
    ]}


def ray(origin, direction, jones=(1 + 0j, 0j), waist=0.5):
    return make_beam_ray(origin=Vec3(*origin), direction=Vec3(*direction), wavelength_nm=LAM,
                         waist_radius_mm=waist, jones=jones)


def exits(model, r):
    return trace_element(parse_surface_model(model), r).exits


# ---------------------------------------------------------------------------

def test_ld2297_is_a_38_mm_negative_lens_not_25():
    """The CAD (R = 39.57 both sides, 3.0 thick) makes f ≈ −37.8 mm at n_d;
    the asset's focalLengthMm says −25. The model follows the CAD."""
    n = ISOTROPIC["N-BK7"].n(LAM)
    r = ray((0, 0, -30), (0, 0, 1), waist=1.0)
    (out,) = exits(ld2297(), r)
    a, b, c, d = _thick_lens_abcd(-39.57, 39.57, n, 3.0)
    assert out.qx == pytest.approx(_q_after_abcd(r.qx + 28.5, a, b, c, d), rel=1e-12)
    assert -1 / c == pytest.approx(-38.3, abs=0.2)


@pytest.mark.parametrize("waves, retardance", [(0.5, math.pi), (0.25, math.pi / 2)])
def test_casix_compound_plates_retard_exactly_at_852(waves, retardance):
    """Fast axis x (the anchor's axisY), so s = x for a +z beam: a 45°
    input comes out with the y component delayed by the design retardance."""
    j = (complex(S2), complex(S2))
    (out,) = exits(zowp(waves), ray((0, 0, -20), (0, 0, 1), j))
    got = cmath.phase(out.jones[1] / out.jones[0]) % (2 * math.pi)
    # canonical p for +z is d × s = z × x = +y
    assert got == pytest.approx(retardance, abs=1e-9)
    # The cemented interface is crossed: o in one plate is e in the other, so
    # both polarizations meet an n_o ↔ n_e step there.
    o, e = UNIAXIAL["crystal_quartz"]
    r_int = ((e.n(LAM) - o.n(LAM)) / (e.n(LAM) + o.n(LAM))) ** 2
    assert out.power_mw == pytest.approx(0.9975 ** 2 * (1 - r_int), rel=1e-9)


def test_bb1_e03_reflects_like_the_mirror_op():
    r = ray((-20 * S2, 0, 20 * S2), (S2, 0, -S2), (complex(0.6, 0.2), complex(0.5, -0.59)))
    (out,) = exits(bb1_e03(), r)
    assert out.direction.dot(Vec3(S2, 0, S2)) == pytest.approx(1.0, abs=1e-15)
    assert out.power_mw == pytest.approx(0.99, abs=1e-12)


@pytest.mark.parametrize("cid", sorted(CUBES))
def test_catalog_cubes_split_like_their_op(cid):
    """A +x beam: transmitted straight on, reflected ±y; the polarizing
    cubes leak 10^(−ER/10), BS041 splits 10:90; the AR faces cost 0.25 %
    each on the way in and out."""
    model = CUBES[cid]()
    for jones in ((1 + 0j, 0j), (0j, 1 + 0j)):
        out = exits(model, ray((-30, 0.2, 0.1), (1, 0, 0), jones))
        assert len(out) == 2
        total = sum(o.power_mw for o in out)
        assert total == pytest.approx(0.9975 ** 2, rel=1e-9)
        straight = next(o for o in out if o.direction.x > 0.99)
        assert straight.direction.dot(Vec3(1, 0, 0)) == pytest.approx(1.0, abs=1e-14)
        if cid == "bs041_step":
            assert straight.power_mw == pytest.approx(0.9 * 0.9975 ** 2, rel=1e-9)


@pytest.mark.parametrize("length", [5.0, 7.5])
def test_glan_laser_passes_x_and_ejects_y(length):
    """x (the optic axis; the e ray, p-polarized at the gap) goes straight
    through, losing only its two AR faces and the p Fresnel of the gap; y
    (the o ray) is totally reflected out of the escape face."""
    (e_out,) = exits(glan_laser(length), ray((0, 0, -20), (0, 0, 1), (1 + 0j, 0j)))
    assert e_out.direction.z == pytest.approx(1.0, abs=1e-12)
    n_e = UNIAXIAL["calcite"][1].n(LAM)
    ci = 0.7826121266688548
    ct = math.sqrt(1 - (n_e * math.sqrt(1 - ci * ci)) ** 2)
    r_p = (ci - n_e * ct) / (ci + n_e * ct)
    assert e_out.power_mw == pytest.approx(0.9975 ** 2 * (1 - r_p ** 2) ** 2, rel=1e-9)
    (o_out,) = exits(glan_laser(length), ray((0, 0, -20), (0, 0, 1), (0j, 1 + 0j)))
    assert o_out.direction.x > 0.9


@pytest.mark.parametrize("centre, axis, radius, ar_r", [
    ((0, 0, -47.752), (0, 0, -1), 12.5, 0.005),       # io_5_850_hp_middle_piece
    ((0, 0, 0), (1, 0, 0), 4.0, 0.0025),               # tornos_isolator_middle_piece
])
def test_tgg_rods_rotate_45_degrees(centre, axis, radius, ar_r):
    d = Vec3(*axis)
    start = tuple(c - a * 30 for c, a in zip(centre, axis))
    (out,) = exits(tgg_rod(centre, axis, radius, ar_r), ray(start, axis, (1 + 0j, 0j)))
    assert out.direction.dot(d) == pytest.approx(1.0, abs=1e-15)
    angle = math.degrees(math.atan2(abs(out.jones[1]), abs(out.jones[0])))
    assert angle == pytest.approx(45.0, abs=1e-9)
    assert out.power_mw == pytest.approx((1 - ar_r) ** 2, abs=1e-12)


# ---------------------------------------------------------------------------
# A230TM-B — from Thorlabs' Zemax prescription (A230TM-B-Zemax, 2026-09-23)
# ---------------------------------------------------------------------------

# Zemax surface 2 (EVENASPH, S-NPH1_MOLD, 2.94 thick) then a flat, then
# 1.991392 air + 0.25 BK7 diode window + 0.6686117 air to the emitter at the
# design wavelength 780 nm. Zemax z runs collimated side → diode = −z here.
A230_CURV = 2.874629639903769e-01
A230_CONIC = -1.263039e-01
A230_ALPHA = (-1.2606e-3, -1.09e-4, 3.2255631e-7, -7.8343862e-7)    # r⁴ … r¹⁰


def a230tm_b():
    z, y = v(0, 0, 1), v(0, 1, 0)
    return {"media": {"glass": {"material": "S-NPH1_MOLD"}}, "surfaces": [
        surf("flat", v(0, 0, 0), z, y, PLANE, circle(3.17), "glass", "air", AR),
        surf("asphere", v(0, 0, 2.94), z, y,
             {"type": "conic", "radiusMm": -1 / A230_CURV, "conic": A230_CONIC,
              "asphericCoeffs": [-a for a in A230_ALPHA]},
             circle(2.475), "air", "glass", AR),
    ]}


def test_a230_reproduces_the_zemax_design_focus():
    """A collimated beam entering the asphere focuses behind the flat at the
    Zemax design's air-equivalent emitter distance (through its BK7 window)
    to 1 µm at 780 nm."""
    n_bk7 = ISOTROPIC["N-BK7"].n(780.0)
    design = 1.991392 + 0.25 / n_bk7 + 6.686116513083e-1
    col = make_beam_ray(origin=Vec3(0, 0, 20), direction=Vec3(0, 0, -1), wavelength_nm=780.0,
                        waist_radius_mm=1.0).replaced(qx=complex(0, 1e9), qy=complex(0, 1e9))
    (out,) = exits(a230tm_b(), col)
    assert -out.qx.real == pytest.approx(design, abs=1e-3)


def test_a230_efl_is_4_51_at_852():
    from app.optical.surfaces.trace import effective_focal_length

    r = make_beam_ray(origin=Vec3(0, 0, -10), direction=Vec3(0, 0, 1), wavelength_nm=852.347)
    assert effective_focal_length(parse_surface_model(a230tm_b()), r, h=1e-4) == pytest.approx(4.508, abs=1e-3)


@pytest.mark.parametrize("r, z_mesh", [(0.5, 2.90353), (1.0, 2.79411), (1.5, 2.60953), (2.0, 2.34353)])
def test_a230_asphere_matches_the_cad_dome(r, z_mesh):
    """The Zemax sag against the asset's own GLB dome, inside the 2.475 mm
    clear aperture: within 1 µm (the CAD's vertex is 0.6 µm lower)."""
    from app.optical.surfaces.geometry import sag

    asph = parse_surface_model(a230tm_b()).surfaces[1]
    assert 2.94 + sag(asph, r, 0.0).w == pytest.approx(z_mesh, abs=1e-3)
