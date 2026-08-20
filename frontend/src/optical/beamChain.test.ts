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
 * The lab frame is Z-up and the three.js scene is Y-up, so "world up" here is
 * scene +y. The tube used to be oriented with `d x up` as its rx axis — which
 * is the backend's +p — so every astigmatic beam's ellipse was drawn rotated
 * by 90 degrees. These tests pin the corrected mapping.
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
    // d = +x, up = +y  =>  the (d, up)-plane transverse direction is +/-y.
    expect(Math.abs(rx.y)).toBeCloseTo(1, 6);
    expect(Math.abs(rx.z)).toBeCloseTo(0, 6);
  });

  it("keeps the basis right-handed so the tube's normals are not inverted", () => {
    const tube = tubeOf(segment());
    const m = new THREE.Matrix4().makeRotationFromQuaternion(tube.quaternion);
    expect(m.determinant()).toBeCloseTo(1, 6);
  });

  it("orients the rx axis consistently for a beam along scene +y", () => {
    // d parallel to up triggers the fallback reference axis; the rx axis must
    // still be transverse (perpendicular to the propagation direction).
    const rx = rxAxisWorld(tubeOf(segment({ endThree: { x: 0, y: 10, z: 0 } })));
    expect(rx.dot(new THREE.Vector3(0, 1, 0))).toBeCloseTo(0, 6);
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
