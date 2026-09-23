"""POST /api/v3/surfaces/fit and /sheets (docs/surface-optics.md, Phase 4).

Synthetic, closed, outward-wound meshes whose vertices lie exactly on their
analytic surfaces (as a CAD tessellator's do): a plano-convex lens shaped like
the LA1509-B (flat at z = 0, a R = 51.5 cap with its apex at z = 3.59, a
12.7 mm rim) and a 10 × 6 × 4 box.
"""

from __future__ import annotations

import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.optical.surfaces.fit import fit_at_triangle, surface_from_fit

R, CT, A = 51.5, 3.59, 12.7
Z_EDGE = CT - (R - math.sqrt(R * R - A * A))


def lens_soup(rings=12, segments=48):
    """Triangles of: the flat face (normal −z), the cap (normal +z-ish), the
    rim (normal radial), each wound outward — checked by
    test_the_synthetic_lens_is_wound_outward."""
    tris = []
    ang = [2 * math.pi * j / segments for j in range(segments)]
    cap_z = lambda r: CT - (R - math.sqrt(R * R - r * r))          # noqa: E731

    def ring(r, z_of):
        return [(r * math.cos(t), r * math.sin(t), z_of(r)) for t in ang]
    flat = [ring(A * i / rings, lambda r: 0.0) for i in range(1, rings + 1)]
    cap = [ring(A * i / rings, cap_z) for i in range(1, rings + 1)]
    for j in range(segments):
        j2 = (j + 1) % segments
        tris.append(((0, 0, 0), flat[0][j2], flat[0][j]))               # facing −z
        tris.append(((0, 0, CT), cap[0][j], cap[0][j2]))                # facing +z
        for i in range(rings - 1):
            # (tangential, radial) turns clockwise seen from +z: that faces −z
            a, b, c, d = flat[i][j], flat[i][j2], flat[i + 1][j2], flat[i + 1][j]
            tris += [(a, b, c), (a, c, d)]
            a, b, c, d = cap[i][j], cap[i][j2], cap[i + 1][j2], cap[i + 1][j]
            tris += [(a, c, b), (a, d, c)]
        lo, lo2 = flat[-1][j], flat[-1][j2]
        hi, hi2 = cap[-1][j], cap[-1][j2]
        tris += [(lo, lo2, hi2), (lo, hi2, hi)]                         # rim, radial out
    return [c for t in tris for p in t for c in p], len(tris)


def box_soup(w=10.0, h=6.0, d=4.0):
    x, y, z = w / 2, h / 2, d / 2
    v = [(-x, -y, -z), (x, -y, -z), (x, y, -z), (-x, y, -z), (-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z)]
    quads = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (1, 2, 6, 5), (0, 4, 7, 3)]
    tris = []
    for a, b, c, d in quads:
        tris += [(v[a], v[b], v[c]), (v[a], v[c], v[d])]
    return [c for t in tris for p in t for c in p]


def seed_where(soup, pred):
    tri = np.asarray(soup).reshape(-1, 3, 3)
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    n /= np.linalg.norm(n, axis=1)[:, None]
    c = tri.mean(1)
    return next(i for i in range(len(tri)) if pred(c[i], n[i]))


def xyz(d):
    return np.array([d["x"], d["y"], d["z"]])


def test_the_cap_is_a_sphere_with_its_vertex_on_the_axis():
    soup, _ = lens_soup()
    seed = seed_where(soup, lambda c, n: n[2] > 0.99 and math.hypot(c[0], c[1]) > 5)   # clicked off-axis
    fit = fit_at_triangle(soup, seed)
    assert fit.shape == "sphere"
    assert fit.radius == pytest.approx(R, rel=1e-9)
    assert fit.rms < 1e-9
    np.testing.assert_allclose(fit.position, [0, 0, CT], atol=1e-9)
    np.testing.assert_allclose(fit.normal, [0, 0, 1], atol=1e-12)
    s = surface_from_fit(fit)
    # axisX = +z (out, into air), centre on −z → R < 0: the LA1509's own convention
    assert s["shape"] == {"type": "sphere", "radiusMm": pytest.approx(-R, rel=1e-9)}
    assert s["apertureCircle"]["radiusMm"] == pytest.approx(A, rel=1e-9)
    assert s["shapeGuess"] == "circle"


def test_the_flat_is_a_plane_and_the_rim_a_cylinder():
    soup, _ = lens_soup()
    flat = fit_at_triangle(soup, seed_where(soup, lambda c, n: n[2] < -0.99))
    assert flat.shape == "plane" and flat.rms < 1e-12
    np.testing.assert_allclose(flat.normal, [0, 0, -1], atol=1e-12)
    np.testing.assert_allclose(flat.position, [0, 0, 0], atol=1e-9)
    rim = fit_at_triangle(soup, seed_where(soup, lambda c, n: abs(n[2]) < 0.2))
    assert rim.shape == "cylinder"
    assert rim.radius == pytest.approx(A, rel=1e-6)
    assert abs(abs(rim.axis[2]) - 1) < 1e-9
    s = surface_from_fit(rim)
    ax, ay = xyz(s["axisXBodyLocal"]), xyz(s["axisYBodyLocal"])
    assert abs(ax @ ay) < 1e-12
    assert abs(abs(np.cross(ax, ay)[2]) - 1) < 1e-9       # axisZ = the cylinder axis


def test_a_box_face_is_a_plane_with_a_rectangular_aperture():
    soup = box_soup()
    fit = fit_at_triangle(soup, seed_where(soup, lambda c, n: n[2] > 0.99))
    assert fit.shape == "plane"
    s = surface_from_fit(fit)
    assert s["shapeGuess"] == "rectangle"
    dims = sorted([s["apertureRectangle"]["widthMm"], s["apertureRectangle"]["heightMm"]])
    assert dims == pytest.approx([6.0, 10.0], abs=1e-9)


client = TestClient(app)


def test_fit_endpoint_round_trip():
    soup, _ = lens_soup()
    seed = seed_where(soup, lambda c, n: n[2] > 0.99)
    r = client.post("/api/v3/surfaces/fit", json={"triangles": soup, "seed": seed})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["shape"] == "sphere" and body["radiusMm"] == pytest.approx(R, rel=1e-9)
    assert body["surface"]["shape"]["radiusMm"] == pytest.approx(-R, rel=1e-9)
    assert seed in body["triangles"]


def test_fit_endpoint_rejects_a_bad_soup():
    assert client.post("/api/v3/surfaces/fit", json={"triangles": [0.0] * 10, "seed": 0}).status_code == 422
    assert client.post("/api/v3/surfaces/fit", json={"triangles": [0.0] * 9, "seed": 0}).status_code == 422


def test_sheets_lie_on_the_surface_the_tracer_uses():
    model = {"media": {"glass": {"n": 1.5}}, "surfaces": [
        {"id": "cap", "positionMmBodyLocal": {"x": 0, "y": 0, "z": CT},
         "axisXBodyLocal": {"x": 0, "y": 0, "z": 1}, "axisYBodyLocal": {"x": 0, "y": 1, "z": 0},
         "shape": {"type": "sphere", "radiusMm": -R}, "aperture": {"shape": "circle", "radiusMm": A},
         "front": "air", "back": "glass"},
        {"id": "face", "positionMmBodyLocal": {"x": 0, "y": 0, "z": 0},
         "axisXBodyLocal": {"x": 0, "y": 0, "z": -1}, "axisYBodyLocal": {"x": 0, "y": 1, "z": 0},
         "shape": {"type": "plane"}, "aperture": {"shape": "rectangle", "widthMm": 8, "heightMm": 4},
         "front": "air", "back": "glass"},
    ]}
    r = client.post("/api/v3/surfaces/sheets", json={"surfaceModel": model})
    assert r.status_code == 200, r.text
    cap, face = r.json()["surfaces"]
    v = np.array(cap["vertices"])
    np.testing.assert_allclose(np.linalg.norm(v - [0, 0, CT - R], axis=1), R, rtol=1e-12)
    assert np.hypot(v[:, 0], v[:, 1]).max() == pytest.approx(A, rel=1e-12)
    assert len(cap["faces"]) > 100 and max(max(f) for f in cap["faces"]) < len(v)
    f = np.array(face["vertices"])
    # axisX −z, axisY +y → axisZ = +x: width 8 along y, height 4 along x
    assert np.abs(f[:, 2]).max() == 0
    assert np.abs(f[:, 1]).max() == pytest.approx(4.0) and np.abs(f[:, 0]).max() == pytest.approx(2.0)


def test_the_synthetic_lens_is_wound_outward():
    soup, _ = lens_soup()
    tri = np.asarray(soup).reshape(-1, 3, 3)
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    c = tri.mean(1) - [0, 0, CT / 2]              # from a point inside the lens
    assert (np.einsum("ij,ij->i", n, c) > 0).all()
