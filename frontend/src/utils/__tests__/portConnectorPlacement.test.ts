/**
 * Pins `computePortConnectorPose` against the ONE piece of ground truth that
 * exists for it: the hand-authored EOSpace AZ-0S5-20-PFA-PFA-850/900 port
 * bindings, whose numbers were derived by a human placing real geometry.
 *
 * The reference values below are the live rows (`component_bindings` for
 * `Opt EOM EOSpace 20GHz`) and the `pm_apc_780` / EOM asset anchors. The
 * authored connectors sit 150 mm out from their anchors — that is the pigtail
 * run the user dragged them into — so the poses are NOT reproduced verbatim.
 * What IS pinned:
 *
 *   - the ROTATION, which the pigtail drag never changed, matches the
 *     authored `localR*Deg` exactly;
 *   - the seeded translation puts `connect_in` back ON the anchor, i.e. the
 *     zero-pigtail bulkhead the port defaults to;
 *   - a non-identity device binding composes correctly.
 */

import { describe, expect, it } from "vitest";
import * as THREE from "three";

import {
  anchorPositionInComponentFrame,
  buildPigtailNodes,
  computePortConnectorPose,
  type AnchorFrameLike,
  type BindingPose,
} from "../portConnectorPlacement";

/** `pm_apc_780`.connect_in — the ferrule end face. */
const CONNECT_IN: AnchorFrameLike = {
  positionMmBodyLocal: { x: 0.009, y: -0.051, z: 59.333 },
  axisXBodyLocal: { x: 0.0, y: -0.13904025798287284, z: 0.9902867295183028 },
  axisYBodyLocal: { x: 0.0, y: 0.9902867295183028, z: 0.13904025798287284 },
  axisZBodyLocal: { x: -1.0, y: 0.0, z: 0.0 },
};

/** `eospace_az_0s5_20_pfa_pfa_850_900`.intercept_in / intercept_out. */
const INTERCEPT_IN: AnchorFrameLike = {
  positionMmBodyLocal: { x: 0, y: 0, z: 0 },
  axisXBodyLocal: { x: -1, y: 0, z: 0 },
  axisYBodyLocal: { x: 0, y: 0, z: 1 },
  axisZBodyLocal: { x: 0, y: 1, z: 0 },
};
const INTERCEPT_OUT: AnchorFrameLike = {
  positionMmBodyLocal: { x: 130, y: 0, z: 0 },
  axisXBodyLocal: { x: 1, y: 0, z: 0 },
  axisYBodyLocal: { x: 0, y: 0, z: 1 },
  axisZBodyLocal: { x: 0, y: -1, z: 0 },
};

/** Rotations of the two authored bindings (translations differ — see above). */
const AUTHORED_IN = { rx: 0, ry: -82.007686, rz: -90 };
const AUTHORED_OUT = { rx: 0, ry: 82.007686, rz: 90 };

function connectInWorld(pose: BindingPose): THREE.Vector3 {
  const m = new THREE.Matrix4()
    .makeRotationFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(pose.localRxDeg),
        THREE.MathUtils.degToRad(pose.localRyDeg),
        THREE.MathUtils.degToRad(pose.localRzDeg),
        "XYZ",
      ),
    )
    .setPosition(pose.localXMm, pose.localYMm, pose.localZMm);
  const p = CONNECT_IN.positionMmBodyLocal!;
  return new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(m);
}

function connectInAxisX(pose: BindingPose): THREE.Vector3 {
  const r = new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(pose.localRxDeg),
      THREE.MathUtils.degToRad(pose.localRyDeg),
      THREE.MathUtils.degToRad(pose.localRzDeg),
      "XYZ",
    ),
  );
  const a = CONNECT_IN.axisXBodyLocal!;
  return new THREE.Vector3(a.x, a.y, a.z).applyMatrix4(r);
}

describe("computePortConnectorPose", () => {
  it("reproduces the authored rotation of the EOSpace input port", () => {
    const pose = computePortConnectorPose(INTERCEPT_IN, CONNECT_IN, null)!;
    expect(pose.localRxDeg).toBeCloseTo(AUTHORED_IN.rx, 6);
    expect(pose.localRyDeg).toBeCloseTo(AUTHORED_IN.ry, 6);
    expect(pose.localRzDeg).toBeCloseTo(AUTHORED_IN.rz, 6);
  });

  it("reproduces the authored rotation of the EOSpace output port", () => {
    const pose = computePortConnectorPose(INTERCEPT_OUT, CONNECT_IN, null)!;
    expect(pose.localRxDeg).toBeCloseTo(AUTHORED_OUT.rx, 6);
    expect(pose.localRyDeg).toBeCloseTo(AUTHORED_OUT.ry, 6);
    expect(pose.localRzDeg).toBeCloseTo(AUTHORED_OUT.rz, 6);
  });

  it("lands connect_in exactly on the anchor it replaces (zero-change default)", () => {
    for (const anchor of [INTERCEPT_IN, INTERCEPT_OUT]) {
      const pose = computePortConnectorPose(anchor, CONNECT_IN, null)!;
      const p = anchor.positionMmBodyLocal!;
      const got = connectInWorld(pose);
      expect(got.x).toBeCloseTo(p.x, 6);
      expect(got.y).toBeCloseTo(p.y, 6);
      expect(got.z).toBeCloseTo(p.z, 6);
    }
  });

  it("points connect_in's axisX ALONG the anchor's axisX, not against it", () => {
    for (const anchor of [INTERCEPT_IN, INTERCEPT_OUT]) {
      const pose = computePortConnectorPose(anchor, CONNECT_IN, null)!;
      const a = anchor.axisXBodyLocal!;
      const dot = connectInAxisX(pose).dot(new THREE.Vector3(a.x, a.y, a.z));
      expect(dot).toBeCloseTo(1, 6);
    }
  });

  it("composes a non-identity device binding into the connector pose", () => {
    const devicePose: BindingPose = {
      localXMm: 40,
      localYMm: -12,
      localZMm: 7,
      localRxDeg: 0,
      localRyDeg: 0,
      localRzDeg: 90,
    };
    const pose = computePortConnectorPose(INTERCEPT_OUT, CONNECT_IN, devicePose)!;
    // intercept_out sits at (130,0,0); rz=90 sends it to (0,130,0), then the
    // device translation lands it at (40, 118, 7).
    const got = connectInWorld(pose);
    expect(got.x).toBeCloseTo(40, 6);
    expect(got.y).toBeCloseTo(118, 6);
    expect(got.z).toBeCloseTo(7, 6);
  });

  it("returns null when an anchor carries no usable axis triad", () => {
    const bare: AnchorFrameLike = { positionMmBodyLocal: { x: 1, y: 2, z: 3 } };
    expect(computePortConnectorPose(bare, CONNECT_IN, null)).toBeNull();
    expect(computePortConnectorPose(INTERCEPT_IN, bare, null)).toBeNull();
  });
});

/**
 * `buildPigtailNodes` — the jacket seeded between a device's fibre exit and
 * the back of its port connector.
 *
 * The shape constants were read back off the hand-authored EOSpace jacket
 * (span 91.6 mm, end handles 28.07 mm at 30° below horizontal, mid node
 * sagging 15.9 mm under the chord), so the first test re-derives exactly
 * those numbers from that run's real endpoints. The rest pin the structural
 * contract the node-edit gizmo relies on: endpoint 0 welded to the device
 * exit, the last to `connect_out`.
 */
describe("buildPigtailNodes", () => {
  // The authored EOSpace port_in run, endpoints only.
  const EXIT: [number, number, number] = [0, 0, 0];
  const CONNECT_OUT: [number, number, number] = [-91.236, 0.009, -8.198];

  it("reproduces the authored jacket's handle length, tilt and sag", () => {
    const nodes = buildPigtailNodes(EXIT, CONNECT_OUT)!;
    expect(nodes).toHaveLength(3);

    const h0 = new THREE.Vector3(...nodes[0].handleOutMm!);
    expect(h0.length()).toBeCloseTo(28.07, 1); // authored 28.070
    // 30° below horizontal, running toward −X. The authored handle sat at
    // 30.05° (−0.8667, −0.4988); the constant rounds that to a flat 30°, a
    // 0.04° difference with no physical meaning.
    expect(h0.clone().normalize().x).toBeCloseTo(-Math.cos(Math.PI / 6), 6);
    expect(h0.clone().normalize().z).toBeCloseTo(-0.5, 6);

    // Mid node sags below the chord midpoint by the authored 15.9 mm.
    const chordMidZ = (EXIT[2] + CONNECT_OUT[2]) / 2;
    expect(chordMidZ - nodes[1].posMm[2]).toBeCloseTo(15.9, 1);
  });

  it("welds node 0 to the device exit and the last node to connect_out", () => {
    const nodes = buildPigtailNodes(EXIT, CONNECT_OUT)!;
    expect(nodes[0].posMm).toEqual(EXIT);
    expect(nodes[nodes.length - 1].posMm).toEqual(CONNECT_OUT);
  });

  it("gives the middle node opposed horizontal handles (a smooth pass-through)", () => {
    const nodes = buildPigtailNodes(EXIT, CONNECT_OUT)!;
    const hIn = new THREE.Vector3(...nodes[1].handleInMm!);
    const hOut = new THREE.Vector3(...nodes[1].handleOutMm!);
    expect(hIn.clone().add(hOut).length()).toBeCloseTo(0, 9);
    expect(hIn.z).toBeCloseTo(0, 9);
  });

  it("returns null for a connector seated on the face — that is a bulkhead", () => {
    expect(buildPigtailNodes([0, 0, 0], [0, 0, 0])).toBeNull();
    expect(buildPigtailNodes([0, 0, 0], [2, 0, 0])).toBeNull();
  });

  it("falls back to a straight 2-node run when the span is purely vertical", () => {
    const nodes = buildPigtailNodes([0, 0, 0], [0, 0, -60])!;
    expect(nodes).toHaveLength(2);
    expect(nodes[1].posMm).toEqual([0, 0, -60]);
  });
});

describe("anchorPositionInComponentFrame", () => {
  it("leaves a body-local position alone when the device is at the identity", () => {
    expect(anchorPositionInComponentFrame(INTERCEPT_OUT, null)).toEqual([130, 0, 0]);
  });

  it("applies the device binding's own pose", () => {
    const got = anchorPositionInComponentFrame(INTERCEPT_OUT, {
      localXMm: 40, localYMm: -12, localZMm: 7,
      localRxDeg: 0, localRyDeg: 0, localRzDeg: 90,
    });
    expect(got[0]).toBeCloseTo(40, 6);
    expect(got[1]).toBeCloseTo(118, 6);
    expect(got[2]).toBeCloseTo(7, 6);
  });
});

/**
 * The one invariant nothing else pins: on a pigtailed device, `intercept_in` /
 * `intercept_out` has TWO values, and which one you get depends on who reads
 * it.
 *
 *   - the AUTHORED value on the Asset3D row is the point where the fibre
 *     leaves the package — the pigtail's root. `buildPigtailNodes` welds node
 *     0 to it (`ComponentsEditor.setPortJacket`).
 *   - the EFFECTIVE value the tracer sees is re-seated onto the bound
 *     connector's mating face by `db_scene_loader._port_connector_anchors`,
 *     which for the authored EOSpace run is ~91 mm off the body.
 *
 * That is deliberate, not a bug: for a pigtailed part the optical face and the
 * fibre exit ARE the same point on the package, so one anchor holds one
 * physical meaning and the re-seat models the fibre carrying the light out to
 * the connector. Splitting them into two anchors would mean authoring the same
 * coordinates twice with an invisible "these must stay equal" rule between
 * them. See the pigtail-vs-bulkhead section of docs/introduce/component.md.
 *
 * The trap it leaves — and the reason this is a test and not a comment —
 * is that editing `intercept_in` in the ASSET3D editor looks like it moves the
 * coupling face, when what it actually moves is the pigtail root; the coupling
 * face is overwritten from the connector at load time.
 */
describe("a pigtail port's device anchor has two readings", () => {
  // The authored EOSpace port_in binding sits 91.236 mm out from the body —
  // the pigtail run the user dragged it into (component_bindings, live row).
  const AUTHORED_CONNECTOR_ROOT: [number, number, number] = [-91.236, 0.009, -8.198];

  it("reading 1 — the authored anchor is where the pigtail is rooted", () => {
    const exit = anchorPositionInComponentFrame(INTERCEPT_IN, null);
    expect(exit).toEqual([0, 0, 0]);
    const nodes = buildPigtailNodes(exit, AUTHORED_CONNECTOR_ROOT)!;
    expect(nodes[0].posMm).toEqual(exit);
  });

  it("reading 2 — the coupling face is the connector's, ~91 mm off the body", () => {
    // Seed the port, then drag it out along −X the way the authored run was.
    const seeded = computePortConnectorPose(INTERCEPT_IN, CONNECT_IN, null)!;
    const dragged = { ...seeded, localXMm: seeded.localXMm - 91.236 };
    const face = connectInWorld(dragged);

    // The seeded (zero-pigtail) face is ON the anchor; the dragged one is not.
    expect(connectInWorld(seeded).length()).toBeCloseTo(0, 6);
    expect(face.x).toBeCloseTo(-91.236, 6);

    // Which is the whole point: root and traced face are 91 mm apart, so a
    // reader that confuses them is wrong by the length of the pigtail.
    const root = anchorPositionInComponentFrame(INTERCEPT_IN, null);
    expect(face.distanceTo(new THREE.Vector3(...root))).toBeCloseTo(91.236, 6);
  });
});
