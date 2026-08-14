/**
 * PPG attachment record + the graph edge it contributes.
 *
 * Invariants:
 *   A1. A well-formed `properties.ppgAttachment` parses; a partial one is
 *       rejected outright (a half-written record must never fabricate an
 *       edge — see the backend parity test of the same name).
 *   A2. `ppgsAttachedTo` finds the PPGs plugged into a doomed instrument.
 *       This drives the delete cascade, so a miss means an orphan PPG
 *       survives its host.
 *   A3. The attachment feeds the RF BFS as the edge a zero-length cable
 *       used to supply: a PPG on a switch's ttl_in gates the throw with
 *       no rf_cable anywhere in the scene.
 */

import { describe, expect, it } from "vitest";

import { ppgAttachmentOf, ppgAttachments, ppgsAttachedTo } from "../ppgAttachment";
import { buildRfPropagation, portKey } from "../rfPropagation";
import type {
  Anchor,
  Asset3D,
  ComponentItem,
  PhysicsElement,
  SceneObject,
} from "../../types/digitalTwin";

const ATT = {
  targetObjectId: "host",
  targetAnchorId: "ttl_in",
  targetAnchorName: "TTL",
};

function obj(id: string, properties: Record<string, unknown> = {}): SceneObject {
  return {
    id, name: `obj-${id}`, componentId: `comp-${id}`,
    xMm: 0, yMm: 0, zMm: 0, rxDeg: 0, ryDeg: 0, rzDeg: 0,
    visible: true, locked: false, properties,
  } as SceneObject;
}

function pe(objectId: string, elementKind: string, kindParams: Record<string, unknown> = {}): PhysicsElement {
  return { id: `pe-${objectId}`, objectId, elementKind, kindParams } as unknown as PhysicsElement;
}

describe("ppgAttachmentOf (A1)", () => {
  it("parses a well-formed record", () => {
    expect(ppgAttachmentOf(obj("p", { ppgAttachment: ATT }))).toEqual(ATT);
  });

  it("rejects partial / malformed records", () => {
    expect(ppgAttachmentOf(obj("p", { ppgAttachment: { targetObjectId: "host" } }))).toBeNull();
    expect(ppgAttachmentOf(obj("p", { ppgAttachment: { ...ATT, targetAnchorName: "" } }))).toBeNull();
    expect(ppgAttachmentOf(obj("p", { ppgAttachment: "nope" }))).toBeNull();
    expect(ppgAttachmentOf(obj("p"))).toBeNull();
    expect(ppgAttachmentOf(null)).toBeNull();
  });

  it("only reports objects that are actually PPGs", () => {
    const objects = [obj("p", { ppgAttachment: ATT }), obj("c", { ppgAttachment: ATT })];
    const pes = [pe("p", "programmable_pulse_generator"), pe("c", "rf_cable")];
    expect(ppgAttachments(objects, pes).map((x) => x.ppgObjectId)).toEqual(["p"]);
  });
});

describe("ppgsAttachedTo (A2)", () => {
  const objects = [
    obj("p1", { ppgAttachment: ATT }),
    obj("p2", { ppgAttachment: { ...ATT, targetObjectId: "other" } }),
    obj("host"),
  ];
  const pes = [
    pe("p1", "programmable_pulse_generator"),
    pe("p2", "programmable_pulse_generator"),
    pe("host", "rf_switch"),
  ];

  it("finds PPGs plugged into a doomed instrument", () => {
    expect(ppgsAttachedTo(objects, pes, new Set(["host"]))).toEqual(["p1"]);
  });

  it("leaves PPGs attached elsewhere alone", () => {
    expect(ppgsAttachedTo(objects, pes, new Set(["unrelated"]))).toEqual([]);
  });
});

describe("attachment as an RF graph edge (A3)", () => {
  function anchor(id: string, name: string): Anchor {
    return {
      id, name,
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      directionBodyLocal: { x: 1, y: 0, z: 0 },
    } as Anchor;
  }
  function asset(id: string, anchors: Anchor[]): Asset3D {
    return {
      id, name: `asset-${id}`, assetType: "stl", filePath: "",
      unit: "mm", scaleFactor: 1.0, anchors,
    } as Asset3D;
  }
  function component(id: string, assetId: string): ComponentItem {
    return { id, name: `comp-${id}`, asset3dId: assetId, properties: {} } as unknown as ComponentItem;
  }

  /** DDS ─cable─► switch.rf_in ; PPG plugged straight into switch.TTL. */
  function build(programHigh: boolean) {
    const srcAsset = asset("a-src", [anchor("rf_out", "CH0")]);
    const swAsset = asset("a-sw", [
      anchor("rf_in", "rf_in"), anchor("rf_out", "RF1"),
      anchor("rf_out", "RF2"), anchor("ttl_in", "TTL"),
    ]);
    const ppgAsset = asset("a-ppg", [anchor("rf_out", "rf_out")]);
    const cableAsset = asset("a-cab", []);

    const src = { ...obj("src"), componentId: "c-src" } as SceneObject;
    const sw = { ...obj("host"), componentId: "c-sw" } as SceneObject;
    const ppg = { ...obj("ppg", { ppgAttachment: ATT }), componentId: "c-ppg" } as SceneObject;
    const cable = {
      ...obj("cab", {
        rfCableEndpoints: {
          A: { targetObjectId: "src", targetAnchorId: "rf_out", targetAnchorName: "CH0" },
          B: { targetObjectId: "host", targetAnchorId: "rf_in", targetAnchorName: "rf_in" },
        },
      }),
      componentId: "c-cab",
    } as SceneObject;

    return buildRfPropagation({
      objects: [src, sw, ppg, cable],
      components: [
        component("c-src", srcAsset.id), component("c-sw", swAsset.id),
        component("c-ppg", ppgAsset.id), component("c-cab", cableAsset.id),
      ],
      assets: [srcAsset, swAsset, ppgAsset, cableAsset],
      physicsElements: [
        pe("src", "rf_source", { channels: [{ anchorName: "CH0", frequencyMhz: 80, amplitudeScale: 1 }] }),
        pe("host", "rf_switch", { throwCount: 2, insertionLossDb: 1.0 }),
        pe("ppg", "programmable_pulse_generator", { timingProgramId: "prog" }),
        pe("cab", "rf_cable", { lengthMm: 100 }),
      ],
      timingPrograms: [
        { id: "prog", name: "CH0", intervals: [{ spinCoreStartNs: 1000, spinCoreEndNs: 2000 }] },
      ] as unknown as Parameters<typeof buildRfPropagation>[0]["timingPrograms"],
      scrubTimeNs: programHigh ? 1500 : 0,
    });
  }

  it("routes to the TTL-high throw when the PPG's program is HIGH", () => {
    const r = build(true);
    expect(r.signalAtPort.get(portKey("host", "RF2"))).toBeDefined();
    expect(r.signalAtPort.get(portKey("host", "RF1"))).toBeUndefined();
  });

  it("routes to the other throw when the program is LOW", () => {
    const r = build(false);
    expect(r.signalAtPort.get(portKey("host", "RF1"))).toBeDefined();
    expect(r.signalAtPort.get(portKey("host", "RF2"))).toBeUndefined();
  });
});
