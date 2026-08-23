/**
 * Pins the pigtail-end align geometry against the one piece of ground truth
 * that exists: the hand-authored EOSpace AZ-0S5-20-PFA-PFA-850/900 port
 * bindings and the `30126A9-Step` FC/APC connector anchors, both taken from
 * the live rows.
 *
 * The load-bearing pin is `pigtailNodesFollowingConnector`: feeding it the
 * authored `port_out` pose as BOTH old and new must reproduce the authored
 * template's last node to the micron, which is what proves the "last node is
 * welded to `connect_out`" rule this module leans on.
 */
import { describe, expect, it } from "vitest";

import {
  bindingPoseDelta,
  computeConnectorAlignPose,
  connectorPortLab,
  findPigtailBeamCandidates,
  findPigtailPortCandidates,
  pigtailNodesFollowingConnector,
  type ConnectorPlacement,
} from "../pigtailAlignment";
import type { AnchorFrameLike, BindingPose } from "../portConnectorPlacement";
import type { V3Pose } from "../../optical/pose";

/** `30126A9-Step`.connect_in — the ferrule end face, 8° APC tilt off +Z. */
const CONNECT_IN: AnchorFrameLike = {
  positionMmBodyLocal: { x: 0.0, y: -0.0398994676147898, z: 11.210308583577474 },
  axisXBodyLocal: {
    x: 2.686006310088765e-7,
    y: -0.1391728997450958,
    z: 0.9902680970204327,
  },
  axisYBodyLocal: {
    x: 3.7749301227963455e-8,
    y: 0.9902680970204691,
    z: 0.13917289974509064,
  },
  axisZBodyLocal: { x: -1.0, y: 0.0, z: 0.0 },
};

/** `30126A9-Step`.connect_out — the wire junction the pigtail welds to. */
const CONNECT_OUT_POS: [number, number, number] = [0, 9.56499836600135e-16, -25.000499725341797];

/** The authored `port_out` ComponentBinding of `Opt EOM EOSpace 20GHz`. */
const PORT_OUT_POSE: BindingPose = {
  localXMm: 221.2362,
  localYMm: 0,
  localZMm: 0,
  localRxDeg: 0,
  localRyDeg: 82.000011642,
  localRzDeg: 89.99988942,
};

/** …and the pigtail run that binding carries in `properties.fiberNodes`. */
const PORT_OUT_NODES = [
  { posMm: [130, 0, 0] as [number, number, number], handleOutMm: [17.6413, 0, -10.1852] as [number, number, number] },
  {
    posMm: [163.2395013562146, 0, -13.322874806339092] as [number, number, number],
    handleInMm: [-8.85380907159749, 0, 0] as [number, number, number],
    handleOutMm: [8.85380907159749, 0, 0] as [number, number, number],
  },
  {
    posMm: [196.47900271242915, 0, -3.479392041881746] as [number, number, number],
    handleInMm: [-17.641299355907716, 0, -10.185208931988088] as [number, number, number],
  },
];

const IDENTITY_OBJECT: V3Pose = {
  xMm: 0, yMm: 0, zMm: 0, rxDeg: 0, ryDeg: 0, rzDeg: 0,
};
/** EOM0's real pose in the live scene — flipped 180° about Z. */
const EOM0_POSE: V3Pose = {
  xMm: -1100, yMm: -308.228629, zMm: 992.988832, rxDeg: 0, ryDeg: 0, rzDeg: 180,
};

const placement = (pose: BindingPose): ConnectorPlacement => ({
  pose,
  parentPose: null,
  connectIn: CONNECT_IN,
});

const near = (got: readonly number[], want: readonly number[], tol = 1e-6): void => {
  expect(got.length).toBe(want.length);
  got.forEach((v, i) => expect(v).toBeCloseTo(want[i], -Math.log10(tol)));
};

describe("connectorPortLab", () => {
  it("puts the EOSpace out-port face where the authored binding does", () => {
    const lab = connectorPortLab(placement(PORT_OUT_POSE), IDENTITY_OBJECT);
    // Hand-derived from T(221.2362,0,0)·Ry(82°)·Rz(90°)·connect_in.
    near(lab!.posMm, [232.3430, 0, 1.5206], 1e-3);
    // axisX is the 8° APC tilt carried through the same rotation.
    expect(Math.hypot(...lab!.axisXMm)).toBeCloseTo(1, 12);
  });

  it("carries the SceneObject pose (EOM0 is flipped 180° about Z)", () => {
    const local = connectorPortLab(placement(PORT_OUT_POSE), IDENTITY_OBJECT)!;
    const lab = connectorPortLab(placement(PORT_OUT_POSE), EOM0_POSE)!;
    near(
      lab.posMm,
      [EOM0_POSE.xMm - local.posMm[0], EOM0_POSE.yMm - local.posMm[1], EOM0_POSE.zMm + local.posMm[2]],
      1e-6,
    );
  });

  it("returns null when connect_in has no axis triad", () => {
    const broken = { positionMmBodyLocal: { x: 0, y: 0, z: 0 } };
    expect(connectorPortLab({ ...placement(PORT_OUT_POSE), connectIn: broken }, IDENTITY_OBJECT))
      .toBeNull();
  });
});

describe("computeConnectorAlignPose", () => {
  it("is a no-op when the target is where the face already is", () => {
    const before = connectorPortLab(placement(PORT_OUT_POSE), EOM0_POSE)!;
    const pose = computeConnectorAlignPose({
      placement: placement(PORT_OUT_POSE),
      objectPose: EOM0_POSE,
      targetPosLab: before.posMm,
      targetAxisXLab: before.axisXMm,
    })!;
    near(
      [pose.localXMm, pose.localYMm, pose.localZMm],
      [PORT_OUT_POSE.localXMm, PORT_OUT_POSE.localYMm, PORT_OUT_POSE.localZMm],
      1e-6,
    );
    // Same rotation — compare through the resulting face, not the Euler
    // triple, which has more than one representation.
    const after = connectorPortLab(placement(pose), EOM0_POSE)!;
    near(after.axisXMm, before.axisXMm, 1e-9);
  });

  it("lands the face exactly on an arbitrary target pos + direction", () => {
    const targetPosLab: [number, number, number] = [-1234.5, -300.25, 1010.75];
    const targetAxisXLab: [number, number, number] = [0.6, 0, 0.8];
    const pose = computeConnectorAlignPose({
      placement: placement(PORT_OUT_POSE),
      objectPose: EOM0_POSE,
      targetPosLab,
      targetAxisXLab,
    })!;
    const after = connectorPortLab(placement(pose), EOM0_POSE)!;
    near(after.posMm, targetPosLab, 1e-9);
    near(after.axisXMm, targetAxisXLab, 1e-9);
  });

  it("keeps the PM key axis in the plane it started in (shortest arc)", () => {
    const before = connectorPortLab(placement(PORT_OUT_POSE), EOM0_POSE)!;
    const target: [number, number, number] = [1, 0, 0];
    const pose = computeConnectorAlignPose({
      placement: placement(PORT_OUT_POSE),
      objectPose: EOM0_POSE,
      targetPosLab: before.posMm,
      targetAxisXLab: target,
    })!;
    // A shortest-arc fix rotates about axisX_before × axisX_target, so the
    // component of any body axis along that rotation axis is preserved.
    const after = connectorPortLab(placement(pose), EOM0_POSE)!;
    near(after.axisXMm, target, 1e-9);
    // …and it is genuinely a rotation, not a mirror.
    expect(Math.hypot(...after.axisXMm)).toBeCloseTo(1, 12);
  });

  it("bindingPoseDelta added to the baseline reproduces the target pose", () => {
    const target = computeConnectorAlignPose({
      placement: placement(PORT_OUT_POSE),
      objectPose: EOM0_POSE,
      targetPosLab: [-1200, -320, 1000],
      targetAxisXLab: [0, 1, 0],
    })!;
    const delta = bindingPoseDelta(target, PORT_OUT_POSE);
    const effective: BindingPose = {
      localXMm: PORT_OUT_POSE.localXMm + delta.localXMmDelta,
      localYMm: PORT_OUT_POSE.localYMm + delta.localYMmDelta,
      localZMm: PORT_OUT_POSE.localZMm + delta.localZMmDelta,
      localRxDeg: PORT_OUT_POSE.localRxDeg + delta.localRxDegDelta,
      localRyDeg: PORT_OUT_POSE.localRyDeg + delta.localRyDegDelta,
      localRzDeg: PORT_OUT_POSE.localRzDeg + delta.localRzDegDelta,
    };
    const viaDelta = connectorPortLab(placement(effective), EOM0_POSE)!;
    near(viaDelta.posMm, [-1200, -320, 1000], 1e-6);
    near(viaDelta.axisXMm, [0, 1, 0], 1e-9);
  });
});

describe("pigtailNodesFollowingConnector", () => {
  it("reproduces the authored last node — connect_out IS the weld", () => {
    const next = pigtailNodesFollowingConnector({
      nodes: PORT_OUT_NODES,
      oldPose: PORT_OUT_POSE,
      newPose: PORT_OUT_POSE,
      connectOutPosMm: CONNECT_OUT_POS,
    });
    near(next[2].posMm, PORT_OUT_NODES[2].posMm, 1e-3);
    near(next[2].handleInMm!, PORT_OUT_NODES[2].handleInMm!, 1e-9);
  });

  it("moves only the last node — the device end and interior stay put", () => {
    const moved: BindingPose = { ...PORT_OUT_POSE, localZMm: 40, localRyDeg: 60 };
    const next = pigtailNodesFollowingConnector({
      nodes: PORT_OUT_NODES,
      oldPose: PORT_OUT_POSE,
      newPose: moved,
      connectOutPosMm: CONNECT_OUT_POS,
    });
    expect(next[0]).toEqual(PORT_OUT_NODES[0]);
    expect(next[1]).toEqual(PORT_OUT_NODES[1]);
    expect(next[2].posMm).not.toEqual(PORT_OUT_NODES[2].posMm);
    // The boot angle relative to the connector is carried, so the handle
    // keeps its length and only turns with the connector.
    expect(Math.hypot(...next[2].handleInMm!)).toBeCloseTo(
      Math.hypot(...PORT_OUT_NODES[2].handleInMm!),
      9,
    );
  });

  it("leaves a degenerate run alone", () => {
    expect(
      pigtailNodesFollowingConnector({
        nodes: [PORT_OUT_NODES[0]],
        oldPose: PORT_OUT_POSE,
        newPose: { ...PORT_OUT_POSE, localZMm: 40 },
        connectOutPosMm: CONNECT_OUT_POS,
      }),
    ).toEqual([PORT_OUT_NODES[0]]);
  });
});

describe("candidate finders", () => {
  const portLab = { posMm: [0, 0, 0] as [number, number, number], axisXMm: [1, 0, 0] as [number, number, number] };

  it("projects onto a beam and takes its propagation direction", () => {
    const [c] = findPigtailBeamCandidates({
      portLab,
      beamSegmentsLab: [{ beamId: "trace:a", aMm: [-100, 5, 0], bMm: [100, 5, 0] }],
      toleranceMm: 25,
    });
    expect(c.distMm).toBeCloseTo(5, 9);
    near(c.targetPosLab, [0, 5, 0], 1e-9);
    near(c.targetAxisXLab, [1, 0, 0], 1e-9);
    expect(c.port).toBeUndefined();
  });

  it("drops beams beyond tolerance", () => {
    expect(
      findPigtailBeamCandidates({
        portLab,
        beamSegmentsLab: [{ beamId: "trace:a", aMm: [-100, 30, 0], bMm: [100, 30, 0] }],
        toleranceMm: 25,
      }),
    ).toHaveLength(0);
  });

  it("mates End A downstream of a receptacle and End B upstream", () => {
    const ports = [{
      labPosMm: [10, 0, 0] as [number, number, number],
      labAxisX: [1, 0, 0] as [number, number, number],
      targetName: "RXM15EF",
      targetObjectId: "obj-1",
      targetAnchorName: "fiber_in",
      targetAnchorId: "fiber_in",
    }];
    const [a] = findPigtailPortCandidates({ end: "A", portLab, ports, toleranceMm: 25 });
    const [b] = findPigtailPortCandidates({ end: "B", portLab, ports, toleranceMm: 25 });
    expect(a.targetPosLab[0]).toBeGreaterThan(10);
    expect(b.targetPosLab[0]).toBeLessThan(10);
    near(a.targetAxisXLab, [1, 0, 0], 1e-9);
    expect(a.port?.targetObjectId).toBe("obj-1");
    expect(a.distMm).toBeCloseTo(10, 9);
  });
});
