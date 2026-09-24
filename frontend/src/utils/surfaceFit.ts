/**
 * Anchor auto-pick: fit a plane, sphere or cylinder to the smooth mesh region
 * around a clicked triangle and return where a face anchor goes — the vertex
 * on the surface's symmetry axis, and the normal there.
 *
 * It replaces "the boundary centre of the triangles within 4° of the clicked
 * one", which on a curved face grabbed only the patch around the click, so
 * the anchor landed wherever the user happened to click. CAD tessellators put
 * vertices exactly on the analytic surface, so the right model fits to the
 * float32 rounding of the mesh (~1e-6 mm) — the same fits that sized the
 * surface-optics lens conversions (docs/surface-optics.md).
 *
 * Input is a triangle soup (9 numbers per triangle) in the frame the anchor
 * lives in; the triangle index is the soup index.
 *
 * `backend/app/optical/surfaces/fit.py` is the same algorithm in Python,
 * served as `POST /api/v3/surfaces/fit` for the Blender add-on. The web keeps
 * this copy so a click never ships the mesh to the server; a change to one
 * belongs in the other.
 */

export type Vec3 = [number, number, number];

export type SurfaceFit = {
  shape: "plane" | "sphere" | "cylinder";
  /** Where a face anchor goes: the area centre of a plane, the vertex of a
   *  sphere cap, the middle of a cylindrical face's vertex line. */
  position: Vec3;
  /** Unit surface normal at `position`, on the side the mesh winding faces
   *  (out of the part). The caller chooses the propagation sign. */
  normal: Vec3;
  /** Sphere / cylinder radius in mm (unsigned); null for a plane. */
  radiusMm: number | null;
  /** RMS distance (mm) of the kept vertices from the fitted surface. */
  rmsMm: number;
  /** The triangles the fit kept: smooth, on the surface, connected to the seed. */
  triangles: number[];
};

/** Max bend between two edge-adjacent triangles of one face. Loose on
 *  purpose: a leak across a shallow edge is removed by the fit's outlier
 *  rejection, a region cut short is not recoverable. */
const GROW_ANGLE_DEG = 30;
/** A vertex this close to the model is on it (float32 rounding is ~1e-6 mm). */
export const FIT_TOL_MM = 1e-4;

type Mesh = {
  count: number;
  normal: Float64Array; // unit, 3 per triangle
  area: Float64Array;
  centroid: Float64Array; // 3 per triangle
  corner: Int32Array; // unique-vertex id per corner, 3 per triangle
  vertex: Float64Array; // 3 per unique vertex
  neighbours: number[][]; // edge-adjacent triangles
};

type Model = {
  /** Signed distance of a point from the surface. */
  distance: (x: number, y: number, z: number) => number;
  /** Unit surface normal (either sign) at a point near the surface. */
  normalAt: (p: Vec3) => Vec3;
  /** Anchor pose for a region with area centroid g and mean normal m. */
  pose: (g: Vec3, m: Vec3) => { position: Vec3; normal: Vec3 };
  radiusMm: number | null;
};

type Candidate = {
  shape: SurfaceFit["shape"];
  model: Model;
  triangles: number[];
  rmsMm: number;
  /** Area-weighted RMS angle (rad) between the facets' normals and the model's. */
  rmsNormalRad: number;
  area: number;
};

export function fitSurfaceAtTriangle(soup: ArrayLike<number>, seed: number): SurfaceFit | null {
  const mesh = buildMesh(soup);
  if (seed < 0 || seed >= mesh.count || mesh.area[seed] === 0) return null;
  const region = grow(mesh, seed, () => true);
  const regionArea = sum(region.map((t) => mesh.area[t]));

  const fits: Array<[SurfaceFit["shape"], (tris: number[]) => Model | null]> = [
    ["plane", (tris) => fitPlane(mesh, tris)],
    ["sphere", (tris) => fitSphere(mesh, tris)],
    ["cylinder", (tris) => fitCylinder(mesh, tris)],
  ];
  // A model must account for most of the smooth region; one that only fits
  // a sliver around the click is the wrong model.
  const candidates = fits
    .map(([shape, fit]) => robustFit(mesh, region, seed, shape, fit))
    .filter((c): c is Candidate => c !== null && c.area >= 0.5 * regionArea);
  if (candidates.length === 0) return null;

  // A plane is the limit of both curved models (R → ∞), which then fit it
  // just as well; take the plane whenever it is flat to tolerance. Two curved
  // models can both pass through every vertex — a cylinder meshed only at its
  // two end arcs lies on a sphere too — so among those that do, the facet
  // normals decide. Nothing fits to tolerance: the closest model, flagged by
  // its rms.
  const plane = candidates.find((c) => c.shape === "plane");
  const onTolerance = candidates.filter((c) => c.rmsMm <= FIT_TOL_MM);
  const best = plane && plane.rmsMm <= FIT_TOL_MM
    ? plane
    : onTolerance.length > 0
      ? onTolerance.reduce((a, b) => (b.rmsNormalRad < a.rmsNormalRad ? b : a))
      : candidates.reduce((a, b) => (b.rmsMm < a.rmsMm ? b : a));

  const g: Vec3 = [0, 0, 0];
  const m: Vec3 = [0, 0, 0];
  for (const t of best.triangles) {
    const a = mesh.area[t];
    for (let k = 0; k < 3; k += 1) {
      g[k] += a * mesh.centroid[3 * t + k];
      m[k] += a * mesh.normal[3 * t + k];
    }
  }
  const { position, normal } = best.model.pose(scale(g, 1 / best.area), unit(m));
  return { shape: best.shape, position, normal, radiusMm: best.model.radiusMm, rmsMm: best.rmsMm, triangles: best.triangles };
}

// ---------------------------------------------------------------------------
// Mesh + region growing
// ---------------------------------------------------------------------------

function buildMesh(soup: ArrayLike<number>): Mesh {
  const count = Math.floor(soup.length / 9);
  let extent = 0;
  for (let i = 0; i < count * 9; i += 1) extent = Math.max(extent, Math.abs(soup[i]));
  // Weld corners that differ by rounding only, so triangles of one face (and
  // of two faces meeting at an edge) share edges.
  const eps = Math.max(extent * 1e-6, 1e-9);
  const ids = new Map<string, number>();
  const vertex: number[] = [];
  const corner = new Int32Array(count * 3);
  const normal = new Float64Array(count * 3);
  const area = new Float64Array(count);
  const centroid = new Float64Array(count * 3);
  for (let t = 0; t < count; t += 1) {
    const o = 9 * t;
    for (let k = 0; k < 3; k += 1) {
      const x = soup[o + 3 * k];
      const y = soup[o + 3 * k + 1];
      const z = soup[o + 3 * k + 2];
      const key = `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = vertex.length / 3;
        ids.set(key, id);
        vertex.push(x, y, z);
      }
      corner[3 * t + k] = id;
      centroid[3 * t] += x / 3;
      centroid[3 * t + 1] += y / 3;
      centroid[3 * t + 2] += z / 3;
    }
    const e1: Vec3 = [soup[o + 3] - soup[o], soup[o + 4] - soup[o + 1], soup[o + 5] - soup[o + 2]];
    const e2: Vec3 = [soup[o + 6] - soup[o], soup[o + 7] - soup[o + 1], soup[o + 8] - soup[o + 2]];
    const c = cross(e1, e2);
    const len = Math.hypot(...c);
    area[t] = len / 2;
    if (len > 0) normal.set([c[0] / len, c[1] / len, c[2] / len], 3 * t);
  }

  const byEdge = new Map<number, number[]>();
  const nVerts = vertex.length / 3;
  for (let t = 0; t < count; t += 1) {
    if (area[t] === 0) continue;
    for (let k = 0; k < 3; k += 1) {
      const a = corner[3 * t + k];
      const b = corner[3 * t + ((k + 1) % 3)];
      const key = Math.min(a, b) * nVerts + Math.max(a, b);
      const list = byEdge.get(key);
      if (list) list.push(t);
      else byEdge.set(key, [t]);
    }
  }
  const neighbours: number[][] = Array.from({ length: count }, () => []);
  for (const tris of byEdge.values()) {
    for (const a of tris) for (const b of tris) if (a !== b) neighbours[a].push(b);
  }
  return { count, normal, area, centroid, corner, vertex: Float64Array.from(vertex), neighbours };
}

/** Triangles reachable from `seed` across smooth edges, through `accept`ed ones. */
function grow(mesh: Mesh, seed: number, accept: (t: number) => boolean): number[] {
  const cosMax = Math.cos((GROW_ANGLE_DEG * Math.PI) / 180);
  const seen = new Set([seed]);
  const queue = [seed];
  while (queue.length > 0) {
    const t = queue.pop()!;
    for (const nb of mesh.neighbours[t]) {
      if (seen.has(nb) || !accept(nb)) continue;
      const d = mesh.normal[3 * t] * mesh.normal[3 * nb]
        + mesh.normal[3 * t + 1] * mesh.normal[3 * nb + 1]
        + mesh.normal[3 * t + 2] * mesh.normal[3 * nb + 2];
      if (d < cosMax) continue;
      seen.add(nb);
      queue.push(nb);
    }
  }
  return [...seen];
}

/** Fit, drop the vertices far off the model, keep what is still connected to
 *  the seed, refit — until the kept set stops shrinking. The median residual
 *  sets the cut, so contamination is rejected as long as it is a minority. */
function robustFit(
  mesh: Mesh,
  region: number[],
  seed: number,
  shape: SurfaceFit["shape"],
  fit: (tris: number[]) => Model | null,
): Candidate | null {
  const regionSet = new Set(region);
  let tris = region;
  for (let iter = 0; iter < 8; iter += 1) {
    const model = fit(tris);
    if (!model) return null;
    const dist = new Map<number, number>();
    const distOf = (v: number) => {
      let d = dist.get(v);
      if (d === undefined) {
        d = Math.abs(model.distance(mesh.vertex[3 * v], mesh.vertex[3 * v + 1], mesh.vertex[3 * v + 2]));
        dist.set(v, d);
      }
      return d;
    };
    const current = new Set<number>();
    for (const t of tris) for (let k = 0; k < 3; k += 1) current.add(mesh.corner[3 * t + k]);
    const cut = Math.max(FIT_TOL_MM, 3 * median([...current].map(distOf)));
    const onModel = (t: number) => [0, 1, 2].every((k) => distOf(mesh.corner[3 * t + k]) <= cut);
    if (!onModel(seed)) return null;
    const kept = grow(mesh, seed, (t) => regionSet.has(t) && onModel(t));
    const converged = kept.length === tris.length;
    tris = kept;
    if (converged) break;
  }
  const model = fit(tris);
  if (!model) return null;
  const verts = new Set<number>();
  for (const t of tris) for (let k = 0; k < 3; k += 1) verts.add(mesh.corner[3 * t + k]);
  let ss = 0;
  for (const v of verts) ss += model.distance(mesh.vertex[3 * v], mesh.vertex[3 * v + 1], mesh.vertex[3 * v + 2]) ** 2;
  let area = 0;
  let ssAngle = 0;
  for (const t of tris) {
    const c: Vec3 = [mesh.centroid[3 * t], mesh.centroid[3 * t + 1], mesh.centroid[3 * t + 2]];
    const n: Vec3 = [mesh.normal[3 * t], mesh.normal[3 * t + 1], mesh.normal[3 * t + 2]];
    const cos = Math.min(1, Math.abs(dot(n, model.normalAt(c))));
    area += mesh.area[t];
    ssAngle += mesh.area[t] * Math.acos(cos) ** 2;
  }
  return {
    shape,
    model,
    triangles: tris,
    rmsMm: Math.sqrt(ss / verts.size),
    rmsNormalRad: Math.sqrt(ssAngle / area),
    area,
  };
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function fitPlane(mesh: Mesh, tris: number[]): Model | null {
  const n: Vec3 = [0, 0, 0];
  const c: Vec3 = [0, 0, 0];
  let total = 0;
  for (const t of tris) {
    const a = mesh.area[t];
    total += a;
    for (let k = 0; k < 3; k += 1) {
      n[k] += a * mesh.normal[3 * t + k];
      c[k] += a * mesh.centroid[3 * t + k];
    }
  }
  if (total === 0 || Math.hypot(...n) === 0) return null;
  const nu = unit(n);
  const cc = scale(c, 1 / total);
  return {
    distance: (x, y, z) => (x - cc[0]) * nu[0] + (y - cc[1]) * nu[1] + (z - cc[2]) * nu[2],
    normalAt: () => nu,
    pose: (g) => {
      const h = dot(sub(g, cc), nu);
      return { position: sub(g, scale(nu, h)), normal: nu };
    },
    radiusMm: null,
  };
}

function fitSphere(mesh: Mesh, tris: number[]): Model | null {
  const pts = uniqueVertices(mesh, tris);
  if (pts.length < 4) return null;
  const o = mean(pts);
  const local = pts.map((p) => sub(p, o));
  // Algebraic (Kåsa) fit: |p|² = 2c·p + k, then Gauss-Newton on |p − c| − R.
  const lin = leastSquares(local.map((p) => [2 * p[0], 2 * p[1], 2 * p[2], 1]), local.map((p) => dot(p, p)));
  if (!lin) return null;
  let c: Vec3 = [lin[0], lin[1], lin[2]];
  let r = Math.sqrt(lin[3] + dot(c, c));
  if (!Number.isFinite(r)) return null;
  for (let iter = 0; iter < 20; iter += 1) {
    const rows: number[][] = [];
    const res: number[] = [];
    for (const p of local) {
      const d = sub(p, c);
      const len = Math.hypot(...d);
      rows.push([-d[0] / len, -d[1] / len, -d[2] / len, -1]);
      res.push(-(len - r));
    }
    const step = leastSquares(rows, res);
    if (!step) return null;
    c = [c[0] + step[0], c[1] + step[1], c[2] + step[2]];
    r += step[3];
    if (Math.hypot(...step) < 1e-12 * Math.max(1, r)) break;
  }
  if (!(r > 0) || r > 1e6) return null;
  const centre = add(c, o);
  const radius = r;
  return {
    distance: (x, y, z) => Math.hypot(x - centre[0], y - centre[1], z - centre[2]) - radius,
    normalAt: (p) => unit(sub(p, centre)),
    pose: (g, m) => {
      // The cap's axis runs from the centre through its area centroid.
      const toG = sub(g, centre);
      const d = Math.hypot(...toG) > 1e-9 * radius ? unit(toG) : m;
      return { position: add(centre, scale(d, radius)), normal: dot(d, m) < 0 ? scale(d, -1) : d };
    },
    radiusMm: radius,
  };
}

function fitCylinder(mesh: Mesh, tris: number[]): Model | null {
  // Every normal of a cylinder is perpendicular to its axis.
  const s = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const t of tris) {
    const a = mesh.area[t];
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) {
      s[3 * i + j] += a * mesh.normal[3 * t + i] * mesh.normal[3 * t + j];
    }
  }
  const eig = symmetricEigen3(s);
  // A plane has two vanishing eigenvalues and no defined axis.
  if (eig.values[1] < 1e-9 * eig.values[2]) return null;
  const axis = eig.vectors[0];
  const e1 = unit(Math.abs(axis[0]) < 0.9 ? cross(axis, [1, 0, 0]) : cross(axis, [0, 1, 0]));
  const e2 = cross(axis, e1);
  const pts = uniqueVertices(mesh, tris);
  if (pts.length < 3) return null;
  const o = mean(pts);
  const uv = pts.map((p) => {
    const d = sub(p, o);
    return [dot(d, e1), dot(d, e2)];
  });
  const lin = leastSquares(uv.map(([u, v]) => [2 * u, 2 * v, 1]), uv.map(([u, v]) => u * u + v * v));
  if (!lin) return null;
  let cu = lin[0];
  let cv = lin[1];
  let r = Math.sqrt(lin[2] + cu * cu + cv * cv);
  if (!Number.isFinite(r)) return null;
  for (let iter = 0; iter < 20; iter += 1) {
    const rows: number[][] = [];
    const res: number[] = [];
    for (const [u, v] of uv) {
      const len = Math.hypot(u - cu, v - cv);
      rows.push([-(u - cu) / len, -(v - cv) / len, -1]);
      res.push(-(len - r));
    }
    const step = leastSquares(rows, res);
    if (!step) return null;
    cu += step[0];
    cv += step[1];
    r += step[2];
    if (Math.hypot(...step) < 1e-12 * Math.max(1, r)) break;
  }
  if (!(r > 0) || r > 1e6) return null;
  const onAxis = add(o, add(scale(e1, cu), scale(e2, cv)));
  const radius = r;
  const radial = (p: Vec3): Vec3 => {
    const d = sub(p, onAxis);
    return sub(d, scale(axis, dot(d, axis)));
  };
  return {
    distance: (x, y, z) => Math.hypot(...radial([x, y, z])) - radius,
    normalAt: (p) => unit(radial(p)),
    pose: (g, m) => {
      // Middle of the face's vertex line: on the axis level with the centroid,
      // out toward it.
      const toG = radial(g);
      const d = Math.hypot(...toG) > 1e-9 * radius ? unit(toG) : m;
      const foot = add(onAxis, scale(axis, dot(sub(g, onAxis), axis)));
      return { position: add(foot, scale(d, radius)), normal: dot(d, m) < 0 ? scale(d, -1) : d };
    },
    radiusMm: radius,
  };
}

// ---------------------------------------------------------------------------
// Small linear algebra
// ---------------------------------------------------------------------------

/** Least-squares solution of rows·x = rhs via the normal equations, or null
 *  when they are singular (the data do not pin the model down). */
function leastSquares(rows: number[][], rhs: number[]): number[] | null {
  const n = rows[0]?.length ?? 0;
  const a = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
  rows.forEach((row, r) => {
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) a[i][j] += row[i] * row[j];
      a[i][n] += row[i] * rhs[r];
    }
  });
  const scaleRef = Math.max(...a.map((row, i) => Math.abs(row[i])), 1e-300);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-14 * scaleRef) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let j = col; j <= n; j += 1) a[r][j] -= f * a[col][j];
    }
  }
  const x = a.map((row, i) => row[n] / row[i]);
  return x.every(Number.isFinite) ? x : null;
}

/** Eigen-decomposition of a symmetric 3×3 (row-major) by Jacobi rotations;
 *  values ascending, vectors[i] the unit eigenvector of values[i]. */
function symmetricEigen3(m: number[]): { values: number[]; vectors: Vec3[] } {
  const a = [[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep += 1) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-15 * (Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]) + 1e-300)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (a[p][q] === 0) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k += 1) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k += 1) {
        const apk = a[p][k];
        const aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k += 1) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return {
    values: order.map((i) => a[i][i]),
    vectors: order.map((i) => unit([v[0][i], v[1][i], v[2][i]])),
  };
}

function uniqueVertices(mesh: Mesh, tris: number[]): Vec3[] {
  const ids = new Set<number>();
  for (const t of tris) for (let k = 0; k < 3; k += 1) ids.add(mesh.corner[3 * t + k]);
  return [...ids].map((v) => [mesh.vertex[3 * v], mesh.vertex[3 * v + 1], mesh.vertex[3 * v + 2]]);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)];
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (ps: Vec3[]): Vec3 => scale(ps.reduce((a, p) => add(a, p), [0, 0, 0] as Vec3), 1 / ps.length);
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: Vec3): Vec3 => scale(a, 1 / (Math.hypot(...a) || 1));
