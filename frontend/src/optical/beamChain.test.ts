import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { buildBeamChainGroup, type LinkTraceSegment } from "./beamChain";

/**
 * The transverse basis the beam tube is drawn in.
 *
 * The backend carries the beam's transverse state in `jones.beam_local_sp`'s
 * frame: **+s is the world UP direction projected perpendicular to the
 * propagation axis**, +p = d x s. `waistAtStartUm` comes from qx and therefore
 * belongs on +s; `waistAtStartUmY` from qy on +p.
 *
 * The three.js scene shares the LAB frame's axes — both Z-up, see
 * optical/frames.ts — so "world up" is +z on this side too. The tube used to
 * derive its transverse basis from +y instead, which put every astigmatic
 * beam's ellipse a quarter-turn out. These tests pin the corrected mapping,
 * and in particular that a beam along +x has its rx axis on +z.
 */

function segment(over: Partial<LinkTraceSegment> = {}): LinkTraceSegment {
  return {
    startThree: { x: 0, y: 0, z: 0 },
    endThree: { x: 10, y: 0, z: 0 },      // propagating along scene +x
    emitterObjectId: "emitter",
    sourceObjectId: "source",
    sourceComponentId: "component",
    hitObjectId: null,
    wavelengthNm: 852.347,
    pathLengthFromSourceMmAtStart: 0,
    lengthMm: 100,
    waistAtStartUm: 4000,                 // rx: WIDE  (the qx / +s axis)
    waistAtEndUm: 4000,
    waistAtStartUmY: 500,                 // ry: NARROW (the qy / +p axis)
    waistAtEndUmY: 500,
    powerFactorAtStart: 1,
    polarizationAtStart: [1, 0, 0, 0],
    ...over,
  };
}

function tubeOf(seg: LinkTraceSegment): THREE.Mesh {
  const group = buildBeamChainGroup([seg], new Map());
  const tube = group.children.find(
    (child): child is THREE.Mesh =>
      child instanceof THREE.Mesh && child.userData.beamSegment !== undefined,
  );
  expect(tube).toBeDefined();
  return tube as THREE.Mesh;
}

/** World direction the tube's local +X (the rx axis) ends up pointing along. */
function rxAxisWorld(tube: THREE.Mesh): THREE.Vector3 {
  return new THREE.Vector3(1, 0, 0).applyQuaternion(tube.quaternion).normalize();
}

describe("beam tube transverse basis", () => {
  it("puts the rx (qx) axis along the projected world up, not perpendicular to it", () => {
    const rx = rxAxisWorld(tubeOf(segment()));
    // d = +x, up = +z  =>  the (d, up)-plane transverse direction is +/-z.
    expect(Math.abs(rx.z)).toBeCloseTo(1, 6);
    expect(Math.abs(rx.y)).toBeCloseTo(0, 6);
  });

  it("uses the fallback reference axis for a beam running along up", () => {
    // d = +z triggers beam_local_sp's |d.z| > 0.999 branch (up -> +x), so the
    // rx axis lands on +x. Getting this wrong is invisible for table-plane
    // beams and only shows on a vertical one.
    const rx = rxAxisWorld(tubeOf(segment({ endThree: { x: 0, y: 0, z: 10 } })));
    expect(Math.abs(rx.x)).toBeCloseTo(1, 6);
  });

  it("keeps the basis right-handed so the tube's normals are not inverted", () => {
    const tube = tubeOf(segment());
    const m = new THREE.Matrix4().makeRotationFromQuaternion(tube.quaternion);
    expect(m.determinant()).toBeCloseTo(1, 6);
  });

  it("orients the rx axis on +z for a beam along scene +y too", () => {
    const rx = rxAxisWorld(tubeOf(segment({ endThree: { x: 0, y: 10, z: 0 } })));
    expect(rx.dot(new THREE.Vector3(0, 1, 0))).toBeCloseTo(0, 6);
    expect(Math.abs(rx.z)).toBeCloseTo(1, 6);
  });

  it("leaves a circular beam's orientation immaterial", () => {
    const round = segment({ waistAtStartUmY: 4000, waistAtEndUmY: 4000 });
    const tube = tubeOf(round);
    const geom = tube.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute("position");
    // every ring vertex sits at the same radius from the tube axis (local Y)
    const radii: number[] = [];
    for (let i = 0; i < pos.count; i += 1) {
      radii.push(Math.hypot(pos.getX(i), pos.getZ(i)));
    }
    const max = Math.max(...radii);
    const min = Math.min(...radii);
    expect(max - min).toBeLessThan(1e-6 * Math.max(max, 1));
  });
});


describe("beam tube principal-axis roll", () => {
  const mode = (azimuthRad: number) => ({
    x: { waist0Um: 4000, waistZUm: 0, mSquared: 1 },
    y: { waist0Um: 500, waistZUm: 0, mSquared: 1 },
    wavelengthNm: 852.347,
    azimuthRad,
  });

  it("leaves the basis untouched at zero azimuth", () => {
    const a = rxAxisWorld(tubeOf(segment()));
    const b = rxAxisWorld(tubeOf(segment({ beamMode: mode(0) })));
    expect(b.x).toBeCloseTo(a.x, 12);
    expect(b.y).toBeCloseTo(a.y, 12);
    expect(b.z).toBeCloseTo(a.z, 12);
  });

  it("rolls the rx axis by the azimuth about the propagation direction", () => {
    const base = rxAxisWorld(tubeOf(segment({ beamMode: mode(0) })));
    for (const deg of [30, 45, 90, -60]) {
      const rolled = rxAxisWorld(tubeOf(segment({ beamMode: mode((deg * Math.PI) / 180) })));
      // still transverse
      expect(rolled.dot(new THREE.Vector3(1, 0, 0))).toBeCloseTo(0, 6);
      // and turned by exactly the azimuth
      const cos = Math.abs(rolled.dot(base));
      expect(cos).toBeCloseTo(Math.abs(Math.cos((deg * Math.PI) / 180)), 6);
    }
  });

  it("keeps the basis right-handed at every azimuth", () => {
    for (const deg of [0, 17, 45, 123]) {
      const tube = tubeOf(segment({ beamMode: mode((deg * Math.PI) / 180) }));
      const m = new THREE.Matrix4().makeRotationFromQuaternion(tube.quaternion);
      expect(m.determinant()).toBeCloseTo(1, 6);
    }
  });
});
