import { describe, expect, it } from "vitest";
import * as THREE from "three";

import type { ResolvedBindingNode } from "../componentBindings";
import type { SceneObject } from "../../types/digitalTwin";
import {
  cadToLab,
  collectRoleCentres,
  computeIsolatorAlignPose,
  computePointDirAlignPose,
  pickPolariserCentre,
  type RoleCentre,
  type Vec3,
} from "../isolatorAlign";

// ---- tiny vector helpers (test-local) --------------------------------------
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const unit = (a: Vec3): Vec3 => {
  const n = norm(a);
  return { x: a.x / n, y: a.y / n, z: a.z / n };
};
/** Perpendicular distance from a point to the infinite line (ref, dir). */
const perpDist = (p: Vec3, ref: Vec3, dir: Vec3): number => {
  const d = unit(dir);
  const w = sub(p, ref);
  const t = dot(w, d);
  const foot = { x: ref.x + d.x * t, y: ref.y + d.y * t, z: ref.z + d.z * t };
  return norm(sub(p, foot));
};

/** Minimal ResolvedBindingNode for the walker (only the fields
 *  collectRoleCentres reads). */
function node(opts: {
  role?: string;
  isSub?: boolean;
  pos?: [number, number, number];
  rot?: [number, number, number];
  children?: ResolvedBindingNode[];
}): ResolvedBindingNode {
  const [x, y, z] = opts.pos ?? [0, 0, 0];
  const [rx, ry, rz] = opts.rot ?? [0, 0, 0];
  return {
    binding: { properties: opts.role ? { role_label: opts.role } : {} },
    target: { kind: opts.isSub ? "subcomponent" : "empty" },
    localTransform: { xMm: x, yMm: y, zMm: z, rxDeg: rx, ryDeg: ry, rzDeg: rz },
    children: opts.children ?? [],
  } as unknown as ResolvedBindingNode;
}

function sceneObject(pose: Partial<SceneObject>): SceneObject {
  return {
    id: "iso-1",
    componentId: "comp-1",
    xMm: 0,
    yMm: 0,
    zMm: 0,
    rxDeg: 0,
    ryDeg: 0,
    rzDeg: 0,
    ...pose,
  } as unknown as SceneObject;
}

describe("collectRoleCentres", () => {
  it("accumulates child origins in the parent CAD frame (identity root)", () => {
    const tree = [
      node({
        children: [
          node({ role: "front_pbs", isSub: true, pos: [0, 0, -13] }),
          node({ role: "back_pbs", isSub: true, pos: [0, 0, 13] }),
        ],
      }),
    ];
    const out: RoleCentre[] = [];
    collectRoleCentres(tree, new THREE.Vector3(), new THREE.Quaternion(), out);
    const front = out.find((c) => c.role === "front_pbs")!.posMm;
    const back = out.find((c) => c.role === "back_pbs")!.posMm;
    expect(front.toArray()).toEqual([0, 0, -13]);
    expect(back.toArray()).toEqual([0, 0, 13]);
  });

  it("composes a parent rotation into child positions (mount → glan)", () => {
    // front_mount rotated +90° about Y, with a glan child offset +10 along
    // local Z; the child world position is the rotated offset.
    const tree = [
      node({
        children: [
          node({
            role: "front_mount",
            pos: [0, 5, 0],
            rot: [0, 90, 0],
            children: [node({ role: "front_glan_laser", isSub: true, pos: [0, 0, 10] })],
          }),
        ],
      }),
    ];
    const out: RoleCentre[] = [];
    collectRoleCentres(tree, new THREE.Vector3(), new THREE.Quaternion(), out);
    const glan = out.find((c) => c.role === "front_glan_laser")!.posMm;
    // +90° about Y maps local +Z → world +X, so (0,0,10) → (10,0,0); plus
    // the mount's own (0,5,0) translation.
    expect(glan.x).toBeCloseTo(10, 6);
    expect(glan.y).toBeCloseTo(5, 6);
    expect(glan.z).toBeCloseTo(0, 6);
  });
});

describe("pickPolariserCentre", () => {
  it("prefers the subcomponent node over a same-side mount", () => {
    const mount = new THREE.Vector3(0, 5, 0);
    const glan = new THREE.Vector3(0, 5, 13);
    const centres: RoleCentre[] = [
      { role: "front_mount", isSub: false, posMm: mount },
      { role: "front_glan_laser", isSub: true, posMm: glan },
    ];
    expect(pickPolariserCentre(centres, "front")).toBe(glan);
  });

  it("returns null when no side match", () => {
    const centres: RoleCentre[] = [
      { role: "back_pbs", isSub: true, posMm: new THREE.Vector3(0, 0, 13) },
    ];
    expect(pickPolariserCentre(centres, "front")).toBeNull();
  });

  it("picks the polariser, not the housing piece, when both contain the side", () => {
    // IO-3-850-HP shape: bare "front" polariser at (0,0,-12) plus a
    // "io_3_850_hp_front_piece" housing at the body origin — both asset
    // bindings (no sub-component). Must pick the polariser.
    const piece = new THREE.Vector3(0, 0, 0);
    const polariser = new THREE.Vector3(0, 0, -12);
    const centres: RoleCentre[] = [
      { role: "io_3_850_hp_front_piece", isSub: false, posMm: piece },
      { role: "front", isSub: false, posMm: polariser },
    ];
    expect(pickPolariserCentre(centres, "front")).toBe(polariser);
  });
});

describe("computeIsolatorAlignPose", () => {
  // The invariant: after applying the returned pose (the SAME way the
  // renderer/cadToLab does), BOTH polariser centres lie on the beam line
  // and the front→back bore is parallel to and co-directional with the
  // beam (front upstream).
  const cases: Array<{ name: string; pose: Partial<SceneObject>; beamDir: Vec3; beamRef: Vec3; front: Vec3; back: Vec3 }> = [
    {
      name: "axis-aligned beam, untilted isolator",
      pose: { xMm: 10, yMm: 20, zMm: 5 },
      beamDir: { x: 1, y: 0, z: 0 },
      beamRef: { x: 100, y: 50, z: -7 },
      front: { x: 0, y: 0, z: -13 },
      back: { x: 0, y: 0, z: 13 },
    },
    {
      name: "oblique beam, tilted isolator, Y-axis bore",
      pose: { xMm: -30, yMm: 12, zMm: 40, rxDeg: 12, ryDeg: -30, rzDeg: 45 },
      beamDir: { x: 0.3, y: -0.5, z: 0.8 },
      beamRef: { x: 5, y: -2, z: 11 },
      front: { x: 0, y: 11, z: 0 },
      back: { x: 0, y: 84, z: 0 },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const so = sceneObject(c.pose);
      const pose = computeIsolatorAlignPose({
        frontCadMm: c.front,
        backCadMm: c.back,
        sceneObject: so,
        beamDir: c.beamDir,
        beamRef: c.beamRef,
      });
      expect(pose).not.toBeNull();
      const placed = sceneObject({ ...c.pose, ...pose! });
      const fLab = cadToLab(c.front, placed);
      const bLab = cadToLab(c.back, placed);

      // Both centres on the beam line.
      expect(perpDist(fLab, c.beamRef, c.beamDir)).toBeLessThan(1e-6);
      expect(perpDist(bLab, c.beamRef, c.beamDir)).toBeLessThan(1e-6);

      // Bore parallel + co-directional with beam (front upstream).
      const bore = unit(sub(bLab, fLab));
      expect(dot(bore, unit(c.beamDir))).toBeCloseTo(1, 6);
    });
  }

  it.each([
    { name: "forward (+beam)", reverse: false, expectedDot: 1 },
    { name: "reverse (−beam)", reverse: true, expectedDot: -1 },
  ])("aligns the direction parallel to the $name, point on beam", ({ reverse, expectedDot }) => {
    const so = sceneObject({ xMm: 5, yMm: -3, zMm: 2, rxDeg: 10, ryDeg: 20, rzDeg: -5 });
    const point: Vec3 = { x: 0, y: 0, z: -10 };
    const dir: Vec3 = { x: 0, y: 0, z: 30 };
    const beamDir = unit({ x: 1, y: 0.2, z: 0 });
    const beamRef: Vec3 = { x: 50, y: 10, z: 3 };
    const pose = computePointDirAlignPose({
      pointCadMm: point,
      dirCadMm: dir,
      sceneObject: so,
      beamDir,
      beamRef,
      reverse,
    });
    expect(pose).not.toBeNull();
    const placed = sceneObject(pose!);
    const pLab = cadToLab(point, placed);
    const dirLab = unit(sub(cadToLab({ x: point.x + dir.x, y: point.y + dir.y, z: point.z + dir.z }, placed), pLab));
    // Point lands on the beam line; direction ∥ ±beam per forward/reverse.
    expect(perpDist(pLab, beamRef, beamDir)).toBeLessThan(1e-6);
    expect(dot(dirLab, unit(beamDir))).toBeCloseTo(expectedDot, 6);
  });

  it("rolls the body about the beam axis by the given clockwise angle", () => {
    const so = sceneObject({ xMm: 0, yMm: 0, zMm: 0, rxDeg: 0, ryDeg: 0, rzDeg: 0 });
    const point: Vec3 = { x: 0, y: 0, z: 0 };
    const dir: Vec3 = { x: 0, y: 0, z: 1 }; // body optic axis = +z
    const vCad: Vec3 = { x: 1, y: 0, z: 0 }; // transverse reference ⊥ dir
    const beamDir = unit({ x: 1, y: 0, z: 0 });
    const beamRef: Vec3 = { x: 0, y: 0, z: 0 };
    const transverseLab = (rollDeg: number): Vec3 => {
      const pose = computePointDirAlignPose({
        pointCadMm: point, dirCadMm: dir, sceneObject: so, beamDir, beamRef, rollDeg,
      })!;
      const placed = sceneObject(pose);
      return unit(sub(cadToLab(vCad, placed), cadToLab(point, placed)));
    };
    const v0 = transverseLab(0);
    const v90 = transverseLab(90);
    const beamU = unit(beamDir);
    // Transverse stays ⊥ beam; a 90° roll rotates it 90° about the beam.
    expect(Math.abs(dot(v0, beamU))).toBeLessThan(1e-6);
    expect(Math.abs(dot(v90, beamU))).toBeLessThan(1e-6);
    const ang = (Math.acos(Math.min(1, Math.max(-1, dot(v0, v90)))) * 180) / Math.PI;
    expect(ang).toBeCloseTo(90, 4);
  });

  it("returns null when front/back coincide", () => {
    const so = sceneObject({});
    const pose = computeIsolatorAlignPose({
      frontCadMm: { x: 1, y: 2, z: 3 },
      backCadMm: { x: 1, y: 2, z: 3 },
      sceneObject: so,
      beamDir: { x: 1, y: 0, z: 0 },
      beamRef: { x: 0, y: 0, z: 0 },
    });
    expect(pose).toBeNull();
  });
});
