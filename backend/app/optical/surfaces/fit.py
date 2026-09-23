"""Fit a plane, sphere or cylinder to the smooth mesh region around a clicked
triangle, and turn it into a surface-model surface (docs/surface-optics.md,
Phase 4). Served by ``POST /api/v3/surfaces/fit`` so every client — the web
PHY Editor, the Blender add-on — gets one answer (qmem-blender
ARCHITECTURE.md rule 2: no third implementation).

The algorithm follows the web's anchor auto-pick
(``frontend/src/utils/surfaceFit.ts``): weld the triangle soup, grow the
region across edges bending less than ``GROW_ANGLE_DEG``, fit each model
robustly (cut at 3 × the median residual, never below ``FIT_TOL_MM``, keep
what stays connected to the seed, refit until stable), keep the models that
account for at least half the region, and pick the plane when it is flat to
tolerance, else among the models on tolerance the one whose facet normals
agree best, else the closest. CAD tessellators put vertices on the analytic
surface, so the right model fits to the float32 rounding of the mesh.

Input is a triangle soup (9 numbers per triangle) in the asset frame.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Optional

import numpy as np

GROW_ANGLE_DEG = 30.0
FIT_TOL_MM = 1e-4


@dataclass
class Mesh:
    normal: np.ndarray       # (T, 3) unit
    area: np.ndarray         # (T,)
    centroid: np.ndarray     # (T, 3)
    corner: np.ndarray       # (T, 3) welded vertex ids
    vertex: np.ndarray       # (V, 3)
    neighbours: list[list[int]]


@dataclass
class Model:
    distance: Callable[[np.ndarray], np.ndarray]     # signed, per point (N, 3)
    normal_at: Callable[[np.ndarray], np.ndarray]    # unit, either sign, per point
    pose: Callable[[np.ndarray, np.ndarray], tuple[np.ndarray, np.ndarray]]
    radius: Optional[float]
    centre: Optional[np.ndarray] = None              # sphere centre / a point on the cylinder axis
    axis: Optional[np.ndarray] = None                # cylinder axis


@dataclass
class Fit:
    shape: str
    position: np.ndarray     # anchor / surface vertex
    normal: np.ndarray       # unit, out of the part (the mesh winding)
    radius: Optional[float]
    rms: float
    triangles: list[int]
    centre: Optional[np.ndarray]
    axis: Optional[np.ndarray]
    vertices: np.ndarray     # the kept vertices, for the aperture
    projected_area: float    # of the kept triangles on the tangent plane


def build_mesh(soup) -> Mesh:
    tri = np.asarray(soup, dtype=float).reshape(-1, 3, 3)
    extent = float(np.abs(tri).max()) if tri.size else 0.0
    eps = max(extent * 1e-6, 1e-9)
    keys = np.round(tri.reshape(-1, 3) / eps).astype(np.int64)
    _, first, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    vertex = tri.reshape(-1, 3)[first]
    corner = inverse.reshape(-1, 3)
    c = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    length = np.linalg.norm(c, axis=1)
    area = length / 2
    normal = np.divide(c, length[:, None], out=np.zeros_like(c), where=length[:, None] > 0)
    centroid = tri.mean(axis=1)
    by_edge: dict[tuple[int, int], list[int]] = {}
    for t in np.nonzero(area > 0)[0]:
        for k in range(3):
            a, b = int(corner[t, k]), int(corner[t, (k + 1) % 3])
            by_edge.setdefault((min(a, b), max(a, b)), []).append(int(t))
    neighbours: list[list[int]] = [[] for _ in range(len(tri))]
    for tris in by_edge.values():
        for a in tris:
            neighbours[a].extend(b for b in tris if b != a)
    return Mesh(normal, area, centroid, corner, vertex, neighbours)


def _grow(mesh: Mesh, seed: int, accept: Callable[[int], bool]) -> list[int]:
    cos_max = math.cos(math.radians(GROW_ANGLE_DEG))
    seen = {seed}
    stack = [seed]
    while stack:
        t = stack.pop()
        for nb in mesh.neighbours[t]:
            if nb in seen or not accept(nb):
                continue
            if float(mesh.normal[t] @ mesh.normal[nb]) < cos_max:
                continue
            seen.add(nb)
            stack.append(nb)
    return sorted(seen)


def _unit(v: np.ndarray) -> np.ndarray:
    return v / np.linalg.norm(v)


def _fit_plane(mesh: Mesh, tris: list[int]) -> Optional[Model]:
    a = mesh.area[tris]
    n = (a[:, None] * mesh.normal[tris]).sum(0)
    total = a.sum()
    if total == 0 or np.linalg.norm(n) == 0:
        return None
    nu = _unit(n)
    cc = (a[:, None] * mesh.centroid[tris]).sum(0) / total

    def pose(g, m):
        return g - nu * float((g - cc) @ nu), nu
    return Model(lambda p: (p - cc) @ nu, lambda p: np.broadcast_to(nu, p.shape), pose, None)


def _verts(mesh: Mesh, tris: list[int]) -> np.ndarray:
    return mesh.vertex[np.unique(mesh.corner[tris])]


def _fit_sphere(mesh: Mesh, tris: list[int]) -> Optional[Model]:
    pts = _verts(mesh, tris)
    if len(pts) < 4:
        return None
    o = pts.mean(0)
    p = pts - o
    sol, *_ = np.linalg.lstsq(np.c_[2 * p, np.ones(len(p))], (p * p).sum(1), rcond=None)
    c, r = sol[:3], math.sqrt(max(sol[3] + sol[:3] @ sol[:3], 0.0))
    for _ in range(20):                              # Gauss-Newton on |p − c| − r
        d = p - c
        ln = np.linalg.norm(d, axis=1)
        jac = np.c_[-d / ln[:, None], -np.ones(len(p))]
        step, *_ = np.linalg.lstsq(jac, -(ln - r), rcond=None)
        c, r = c + step[:3], r + step[3]
        if np.linalg.norm(step) < 1e-12 * max(1.0, r):
            break
    if not (0 < r < 1e6):
        return None
    centre = c + o

    def pose(g, m):
        to_g = g - centre
        d = _unit(to_g) if np.linalg.norm(to_g) > 1e-9 * r else m
        return centre + d * r, (-d if d @ m < 0 else d)
    return Model(lambda q: np.linalg.norm(q - centre, axis=1) - r,
                 lambda q: (q - centre) / np.linalg.norm(q - centre, axis=1)[:, None],
                 pose, float(r), centre=centre)


def _fit_cylinder(mesh: Mesh, tris: list[int]) -> Optional[Model]:
    a = mesh.area[tris]
    n = mesh.normal[tris]
    s = (a[:, None, None] * n[:, :, None] * n[:, None, :]).sum(0)
    values, vectors = np.linalg.eigh(s)              # ascending
    if values[1] < 1e-9 * values[2]:                 # a plane: no defined axis
        return None
    axis = vectors[:, 0]
    e1 = _unit(np.cross(axis, [1.0, 0, 0]) if abs(axis[0]) < 0.9 else np.cross(axis, [0, 1.0, 0]))
    e2 = np.cross(axis, e1)
    pts = _verts(mesh, tris)
    if len(pts) < 3:
        return None
    o = pts.mean(0)
    uv = np.c_[(pts - o) @ e1, (pts - o) @ e2]
    sol, *_ = np.linalg.lstsq(np.c_[2 * uv, np.ones(len(uv))], (uv * uv).sum(1), rcond=None)
    cu, cv = sol[0], sol[1]
    r = math.sqrt(max(sol[2] + cu * cu + cv * cv, 0.0))
    for _ in range(20):
        d = uv - [cu, cv]
        ln = np.linalg.norm(d, axis=1)
        jac = np.c_[-d / ln[:, None], -np.ones(len(uv))]
        step, *_ = np.linalg.lstsq(jac, -(ln - r), rcond=None)
        cu, cv, r = cu + step[0], cv + step[1], r + step[2]
        if np.linalg.norm(step) < 1e-12 * max(1.0, r):
            break
    if not (0 < r < 1e6):
        return None
    on_axis = o + e1 * cu + e2 * cv

    def radial(q):
        d = q - on_axis
        return d - np.outer(d @ axis, axis) if d.ndim == 2 else d - axis * (d @ axis)

    def pose(g, m):
        to_g = radial(g)
        d = _unit(to_g) if np.linalg.norm(to_g) > 1e-9 * r else m
        foot = on_axis + axis * float((g - on_axis) @ axis)
        return foot + d * r, (-d if d @ m < 0 else d)
    return Model(lambda q: np.linalg.norm(radial(q), axis=1) - r,
                 lambda q: radial(q) / np.linalg.norm(radial(q), axis=1)[:, None],
                 pose, float(r), centre=on_axis, axis=axis)


def _robust(mesh: Mesh, region: list[int], seed: int, fit) -> Optional[tuple[Model, list[int], float, float, float]]:
    region_set = set(region)
    tris = region
    for _ in range(8):
        model = fit(mesh, tris)
        if model is None:
            return None
        ids = np.unique(mesh.corner[tris])
        dist = dict(zip(ids.tolist(), np.abs(model.distance(mesh.vertex[ids])).tolist()))
        cut = max(FIT_TOL_MM, 3 * float(np.sort(list(dist.values()))[len(dist) // 2]))

        def on_model(t: int) -> bool:
            out = []
            for v in mesh.corner[t]:
                v = int(v)
                if v not in dist:
                    dist[v] = float(abs(model.distance(mesh.vertex[v][None])[0]))
                out.append(dist[v] <= cut)
            return all(out)
        if not on_model(seed):
            return None
        kept = _grow(mesh, seed, lambda t: t in region_set and on_model(t))
        converged = len(kept) == len(tris)
        tris = kept
        if converged:
            break
    model = fit(mesh, tris)
    if model is None:
        return None
    pts = _verts(mesh, tris)
    rms = float(np.sqrt(np.mean(model.distance(pts) ** 2)))
    a = mesh.area[tris]
    cos = np.clip(np.abs((mesh.normal[tris] * model.normal_at(mesh.centroid[tris])).sum(1)), 0.0, 1.0)
    rms_normal = float(np.sqrt((a * np.arccos(cos) ** 2).sum() / a.sum()))
    return model, tris, rms, rms_normal, float(a.sum())


def fit_at_triangle(soup, seed: int) -> Optional[Fit]:
    mesh = build_mesh(soup)
    if not (0 <= seed < len(mesh.area)) or mesh.area[seed] == 0:
        return None
    region = _grow(mesh, seed, lambda t: True)
    region_area = float(mesh.area[region].sum())
    cands = []
    for shape, fit in (("plane", _fit_plane), ("sphere", _fit_sphere), ("cylinder", _fit_cylinder)):
        got = _robust(mesh, region, seed, fit)
        if got is not None and got[4] >= 0.5 * region_area:
            cands.append((shape, *got))
    if not cands:
        return None
    plane = next((c for c in cands if c[0] == "plane"), None)
    on_tol = [c for c in cands if c[3] <= FIT_TOL_MM]
    if plane is not None and plane[3] <= FIT_TOL_MM:
        best = plane
    elif on_tol:
        best = min(on_tol, key=lambda c: c[4])
    else:
        best = min(cands, key=lambda c: c[3])
    shape, model, tris, rms, _, area = best
    a = mesh.area[tris]
    g = (a[:, None] * mesh.centroid[tris]).sum(0) / area
    m = _unit((a[:, None] * mesh.normal[tris]).sum(0))
    position, normal = model.pose(g, m)
    normal = _unit(normal)
    projected = float((a * np.abs(mesh.normal[tris] @ normal)).sum())
    return Fit(shape, position, normal, model.radius, rms, list(tris),
               model.centre, model.axis, _verts(mesh, tris), projected)


def surface_from_fit(fit: Fit) -> dict:
    """The fit as a surface-model surface (camelCase, SurfaceV3 keys) with
    axisX = the outward normal, so ``front`` is the air side. Leaves id,
    front / back and coating to the caller. The radius is signed by the
    model convention: > 0 when the centre of curvature lies on +axisX.
    A cylinder's axisY is its curvature direction (axisZ its axis). The
    aperture is the smallest centred circle, and the smallest centred
    rectangle, holding every kept vertex in the tangent plane — ``shapeGuess``
    picks the one the region's projected area fills better (a disc fills its
    circle, π/4 of its square; a square the reverse)."""
    x = fit.normal
    if fit.shape == "cylinder":
        y = _unit(np.cross(fit.axis, x))
    else:
        ref = np.eye(3)[int(np.argmin(np.abs(x)))]
        y = _unit(ref - x * (ref @ x))
    z = np.cross(x, y)
    if fit.shape == "plane":
        shape = {"type": "plane"}
    else:
        side = float((fit.centre - fit.position) @ x)
        if fit.shape == "cylinder":
            side = float(((fit.centre - fit.position) - fit.axis * ((fit.centre - fit.position) @ fit.axis)) @ x)
        shape = {"type": fit.shape, "radiusMm": fit.radius if side > 0 else -fit.radius}
    rel = fit.vertices - fit.position
    u, v = rel @ y, rel @ z
    r_max = float(np.hypot(u, v).max())
    w, h = 2 * float(np.abs(u).max()), 2 * float(np.abs(v).max())
    circle_fill = fit.projected_area / (math.pi * r_max * r_max) if r_max > 0 else 0.0
    rect_fill = fit.projected_area / (w * h) if w * h > 0 else 0.0
    return {
        "positionMmBodyLocal": {"x": float(fit.position[0]), "y": float(fit.position[1]), "z": float(fit.position[2])},
        "axisXBodyLocal": {"x": float(x[0]), "y": float(x[1]), "z": float(x[2])},
        "axisYBodyLocal": {"x": float(y[0]), "y": float(y[1]), "z": float(y[2])},
        "shape": shape,
        "apertureCircle": {"shape": "circle", "radiusMm": r_max},
        "apertureRectangle": {"shape": "rectangle", "widthMm": w, "heightMm": h},
        "shapeGuess": "circle" if circle_fill >= rect_fill else "rectangle",
    }


def surface_sheet(surface, rings: int = 16, segments: int = 48) -> tuple[list[list[float]], list[list[int]]]:
    """A display mesh of one surface over its aperture, from ``geometry.sag``
    — so every client draws the surface the tracer uses. Circles and
    ellipses are sampled on a polar grid, rectangles on a square one; a point
    past a sphere's rim (no sag) drops its triangles."""
    from app.optical.surfaces.geometry import sag

    uv: list[tuple[float, float]] = []
    faces: list[list[int]] = []
    if surface.aperture == "rectangle":
        hw, hh = surface.aperture_width_mm / 2, surface.aperture_height_mm / 2
        n = max(rings, 2)
        for i in range(n + 1):
            for j in range(n + 1):
                uv.append((-hw + 2 * hw * j / n, -hh + 2 * hh * i / n))
        for i in range(n):
            for j in range(n):
                a = i * (n + 1) + j
                faces += [[a, a + 1, a + n + 2], [a, a + n + 2, a + n + 1]]
    else:
        ru, rv = ((surface.aperture_radius_mm,) * 2 if surface.aperture == "circle"
                  else (surface.aperture_width_mm / 2, surface.aperture_height_mm / 2))
        uv.append((0.0, 0.0))
        for i in range(1, rings + 1):
            for j in range(segments):
                t = 2 * math.pi * j / segments
                uv.append((ru * i / rings * math.cos(t), rv * i / rings * math.sin(t)))
        for j in range(segments):
            faces.append([0, 1 + j, 1 + (j + 1) % segments])
        for i in range(1, rings):
            base, nxt = 1 + (i - 1) * segments, 1 + i * segments
            for j in range(segments):
                j2 = (j + 1) % segments
                faces += [[base + j, nxt + j, nxt + j2], [base + j, nxt + j2, base + j2]]
    verts: list[Optional[list[float]]] = []
    o, x, y, z = surface.vertex, surface.x, surface.y, surface.z
    for u, v in uv:
        s = sag(surface, u, v)
        if s is None:
            verts.append(None)
            continue
        p = o + y * u + z * v + x * s.w
        verts.append([p.x, p.y, p.z])
    keep = [i for i, p in enumerate(verts) if p is not None]
    index = {old: new for new, old in enumerate(keep)}
    faces = [[index[k] for k in f] for f in faces if all(verts[k] is not None for k in f)]
    return [verts[i] for i in keep], faces
