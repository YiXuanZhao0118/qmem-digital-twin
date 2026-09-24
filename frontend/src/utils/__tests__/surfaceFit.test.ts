import { describe, expect, it } from "vitest";

import { fitSurfaceAtTriangle, type Vec3 } from "../surfaceFit";

type Tri = [Vec3, Vec3, Vec3];

/** Triangle soup wound to face away from `inside` (every test solid is convex). */
function soupOf(tris: Tri[], inside: Vec3): Float64Array {
  const out = new Float64Array(tris.length * 9);
  tris.forEach(([a, b, c], i) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const g = [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3 - inside[k]);
    const outward = n[0] * g[0] + n[1] * g[1] + n[2] * g[2] > 0;
    out.set([...a, ...(outward ? b : c), ...(outward ? c : b)], i * 9);
  });
  return out;
}

/** A plano-convex lens: flat face on z = 0, a side band up to z = edge, and a
 *  spherical dome of radius R whose vertex is returned. Tris are ordered
 *  flat face, side band, dome (pole first, rim last). */
function planoConvex(R: number, rim: number, edge: number, rings = 24, segs = 64) {
  const thetaMax = Math.asin(rim / R);
  const zc = edge - R * Math.cos(thetaMax);
  const dome = (j: number, i: number): Vec3 => {
    const t = (thetaMax * j) / rings;
    const p = (2 * Math.PI * i) / segs;
    return [R * Math.sin(t) * Math.cos(p), R * Math.sin(t) * Math.sin(p), zc + R * Math.cos(t)];
  };
  const ring = (i: number, z: number): Vec3 => {
    const p = (2 * Math.PI * i) / segs;
    return [rim * Math.cos(p), rim * Math.sin(p), z];
  };
  const flat: Tri[] = [];
  const side: Tri[] = [];
  const cap: Tri[] = [];
  for (let i = 0; i < segs; i += 1) {
    flat.push([[0, 0, 0], ring(i, 0), ring(i + 1, 0)]);
    side.push([ring(i, 0), ring(i + 1, 0), dome(rings, i + 1)], [ring(i, 0), dome(rings, i + 1), dome(rings, i)]);
    cap.push([dome(0, 0), dome(1, i), dome(1, i + 1)]);
    for (let j = 1; j < rings; j += 1) {
      cap.push([dome(j, i), dome(j + 1, i), dome(j + 1, i + 1)], [dome(j, i), dome(j + 1, i + 1), dome(j, i + 1)]);
    }
  }
  const tris = [...flat, ...side, ...cap];
  return {
    soup: soupOf(tris, [0, 0, edge / 2]),
    vertexZ: zc + R,
    flatTri: 3,
    sideTri: flat.length + 5,
    // a dome triangle near the rim, far from the vertex
    rimDomeTri: tris.length - 7,
  };
}

/** A plano-convex cylindrical lens: flat back on z = 0, curved along y
 *  (axis along x) with radius R, half-width w, half-length L, edge e. */
function cylindrical(R: number, w: number, L: number, e: number, nx = 12, nphi = 16) {
  const phiMax = Math.asin(w / R);
  const zc = e - R * Math.cos(phiMax);
  const curved = (i: number, j: number): Vec3 => {
    const phi = -phiMax + (2 * phiMax * j) / nphi;
    return [-L + (2 * L * i) / nx, R * Math.sin(phi), zc + R * Math.cos(phi)];
  };
  const tris: Tri[] = [
    [[-L, -w, 0], [L, -w, 0], [L, w, 0]],
    [[-L, -w, 0], [L, w, 0], [-L, w, 0]],
    [[-L, -w, 0], [L, -w, 0], [L, -w, e]],
    [[-L, -w, 0], [L, -w, e], [-L, -w, e]],
    [[-L, w, 0], [L, w, 0], [L, w, e]],
    [[-L, w, 0], [L, w, e], [-L, w, e]],
  ];
  const firstCurved = tris.length;
  for (let i = 0; i < nx; i += 1) {
    for (let j = 0; j < nphi; j += 1) {
      tris.push([curved(i, j), curved(i + 1, j), curved(i + 1, j + 1)], [curved(i, j), curved(i + 1, j + 1), curved(i, j + 1)]);
    }
  }
  return { soup: soupOf(tris, [0, 0, e / 2]), vertexZ: zc + R, cornerTri: firstCurved + 1 };
}

function expectVec(actual: Vec3, expected: Vec3, digits: number) {
  actual.forEach((v, k) => expect(v).toBeCloseTo(expected[k], digits));
}

describe("fitSurfaceAtTriangle", () => {
  it("puts a clicked lens dome's anchor on its vertex, not where the click was", () => {
    // LA1509-B-like: R 51.5, Ø25.4, 2 mm edge.
    const lens = planoConvex(51.5, 12.7, 2.0);
    const fit = fitSurfaceAtTriangle(lens.soup, lens.rimDomeTri)!;
    expect(fit.shape).toBe("sphere");
    expect(fit.radiusMm).toBeCloseTo(51.5, 9);
    expectVec(fit.position, [0, 0, lens.vertexZ], 9);
    expectVec(fit.normal, [0, 0, 1], 9);
    expect(fit.rmsMm).toBeLessThan(1e-9);
  });

  it("puts a clicked flat face's anchor on its centre, normal out of the part", () => {
    const lens = planoConvex(51.5, 12.7, 2.0);
    const fit = fitSurfaceAtTriangle(lens.soup, lens.flatTri)!;
    expect(fit.shape).toBe("plane");
    expectVec(fit.position, [0, 0, 0], 9);
    expectVec(fit.normal, [0, 0, -1], 9);
    expect(fit.triangles).toHaveLength(64);
  });

  it("keeps a near-hemisphere's dome apart from the side band it meets at 14°", () => {
    // LA1951-B-like: R 13.08 on Ø25.4 — the rim sits 76° off axis, so the
    // grown region leaks into the side band and the fit has to cut it off.
    const lens = planoConvex(13.08, 12.7, 1.79);
    const fit = fitSurfaceAtTriangle(lens.soup, lens.rimDomeTri)!;
    expect(fit.shape).toBe("sphere");
    expect(fit.radiusMm).toBeCloseTo(13.08, 9);
    expectVec(fit.position, [0, 0, lens.vertexZ], 9);
    expect(fit.triangles).not.toContain(lens.sideTri);
    expect(fit.triangles).toHaveLength(64 * (2 * 24 - 1));
  });

  it("fits a cylindrical face and anchors the middle of its vertex line", () => {
    // LJ1402L1-B-like: R 20.67, 10 × 12 mm.
    const lens = cylindrical(20.67, 5, 6, 1.99);
    const fit = fitSurfaceAtTriangle(lens.soup, lens.cornerTri)!;
    expect(fit.shape).toBe("cylinder");
    expect(fit.radiusMm).toBeCloseTo(20.67, 9);
    expectVec(fit.position, [0, 0, lens.vertexZ], 9);
    expectVec(fit.normal, [0, 0, 1], 9);
  });

  it("tells a cylinder meshed only at its two end arcs from the sphere through them", () => {
    // LK1426L1-B's GLB: every vertex sits on one of two coaxial circles, which
    // a sphere passes through exactly; only the facet normals say "cylinder".
    const lens = cylindrical(12.86, 5, 6, 0.95, 1, 16);
    const fit = fitSurfaceAtTriangle(lens.soup, lens.cornerTri)!;
    expect(fit.shape).toBe("cylinder");
    expect(fit.radiusMm).toBeCloseTo(12.86, 9);
    expectVec(fit.position, [0, 0, lens.vertexZ], 9);
  });

  it("returns null for a seed outside the soup", () => {
    const lens = planoConvex(51.5, 12.7, 2.0);
    expect(fitSurfaceAtTriangle(lens.soup, 1e6)).toBeNull();
  });
});
