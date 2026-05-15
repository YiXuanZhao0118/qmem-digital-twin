/**
 * RF propagation tests — guard the multi-hop graph traversal that the
 * RF link panel + AOM Bragg solver depend on.
 *
 * Topology under test:
 *
 *     AD9959.CH0 ──cable A──► ZHL-1-2W.rf_in │ rf_out ──cable B──► AOM.rf_in
 *
 * Expected invariants:
 *   I1. The signal at AD9959.CH0 carries the raw source state.
 *   I2. The signal at ZHL-1-2W.rf_in equals the source (no cable loss yet).
 *   I3. The signal at ZHL-1-2W.rf_out has Vpp = source_vpp · 10^(gainDb/20).
 *   I4. The signal at AOM.rf_in equals the amplifier output (final answer
 *       for the Bragg solver).
 *   I5. When the amplifier's outputPowerMaxDbm caps the output, `saturated`
 *       flips to true and Vpp clamps at the dBm-derived ceiling.
 *   I6. A direct source → AOM chain (no amplifier) still works (regression).
 */

import { describe, expect, it } from "vitest";

import {
  AD9959_VPP_FULL_SCALE,
  buildRfPropagation,
  powerWToVpp,
  portKey,
} from "../rfPropagation";
import type {
  Anchor,
  Asset3D,
  ComponentItem,
  PhysicsElement,
  SceneObject,
} from "../../types/digitalTwin";

// =============================================================================
// Builders — keep the chain construction declarative so the test reads as a
// schematic. Each builder returns the objects/components/assets/elements
// quartet for one device, ready to be spread into the propagation input.
// =============================================================================

function makeAnchor(id: string, name: string): Anchor {
  return {
    id,
    name,
    positionMmBodyLocal: { x: 0, y: 0, z: 0 },
    directionBodyLocal: { x: 1, y: 0, z: 0 },
  };
}

function makeAsset(id: string, anchors: Anchor[]): Asset3D {
  return {
    id,
    name: `asset-${id}`,
    assetType: "stl",
    filePath: "",
    unit: "mm",
    scaleFactor: 1.0,
    anchors,
  };
}

function makeComponent(id: string, assetId: string, componentType: string): ComponentItem {
  return {
    id,
    name: `comp-${id}`,
    componentType,
    description: null,
    propertiesSchema: {},
    properties: {},
    asset3dId: assetId,
    createdAt: null,
    updatedAt: null,
  } as unknown as ComponentItem;
}

function makeObject(
  id: string,
  componentId: string,
  properties: Record<string, unknown> = {},
): SceneObject {
  return {
    id,
    name: `obj-${id}`,
    componentId,
    xMm: 0,
    yMm: 0,
    zMm: 0,
    rxDeg: 0,
    ryDeg: 0,
    rzDeg: 0,
    visible: true,
    locked: false,
    properties,
  } as SceneObject;
}

function makePe(
  objectId: string,
  elementKind: string,
  kindParams: Record<string, unknown>,
): PhysicsElement {
  return {
    id: `pe-${objectId}`,
    objectId,
    elementKind,
    kindParams,
    inputPorts: [],
    outputPorts: [],
    createdAt: null,
    updatedAt: null,
  } as unknown as PhysicsElement;
}

function makeAd9959(objectId: string, freqMhz: number, ampScale: number) {
  const anchors = [makeAnchor("rf_out", "CH0")];
  const asset = makeAsset(`asset-${objectId}`, anchors);
  const comp = makeComponent(`comp-${objectId}`, asset.id, "rf_source");
  const obj = makeObject(objectId, comp.id);
  const pe = makePe(objectId, "rf_source", {
    channels: [
      {
        channelIndex: 0,
        anchorName: "CH0",
        mode: "single_tone",
        channelEnabled: true,
        frequencyMhz: freqMhz,
        phaseDeg: 0,
        amplitudeScale: ampScale,
        sweep: null,
        modulationLevels: 4,
        profiles: null,
      },
    ],
  });
  return { obj, comp, asset, pe };
}

function makeAd9959FourCh(objectId: string) {
  // 4-channel DDS with NO persisted channels[] — exercises the
  // "per-anchor seed from asset rf_out anchors" fallback path that
  // the dds_ad9959_pcb auto-create flow ends up in before the user
  // commits any edit.
  const anchors = [
    makeAnchor("rf_out", "CH0"),
    makeAnchor("rf_out", "CH1"),
    makeAnchor("rf_out", "CH2"),
    makeAnchor("rf_out", "CH3"),
  ];
  const asset = makeAsset(`asset-${objectId}`, anchors);
  const comp = makeComponent(`comp-${objectId}`, asset.id, "rf_source");
  const obj = makeObject(objectId, comp.id);
  // kindParams = {} — channels is missing (matches what the
  // auto_create_physics_element_for_object flow leaves on the row).
  const pe = makePe(objectId, "rf_source", {});
  return { obj, comp, asset, pe };
}

function makeAmp(objectId: string, gainDb: number, outputMaxDbm?: number) {
  const anchors = [makeAnchor("rf_in", "rf_in"), makeAnchor("rf_out", "rf_out")];
  const asset = makeAsset(`asset-${objectId}`, anchors);
  const comp = makeComponent(`comp-${objectId}`, asset.id, "rf_amplifier");
  const obj = makeObject(objectId, comp.id);
  const pe = makePe(objectId, "rf_amplifier", {
    gainDb,
    ...(outputMaxDbm != null ? { outputPowerMaxDbm: outputMaxDbm } : {}),
  });
  return { obj, comp, asset, pe };
}

function makeAom(objectId: string) {
  const anchors = [makeAnchor("rf_in", "rf_in")];
  const asset = makeAsset(`asset-${objectId}`, anchors);
  const comp = makeComponent(`comp-${objectId}`, asset.id, "aom");
  const obj = makeObject(objectId, comp.id);
  const pe = makePe(objectId, "aom", {});
  return { obj, comp, asset, pe };
}

function makeCable(
  cableObjectId: string,
  a: { objectId: string; anchorName: string },
  b: { objectId: string; anchorName: string },
) {
  const asset = makeAsset(`asset-${cableObjectId}`, []);
  const comp = makeComponent(`comp-${cableObjectId}`, asset.id, "rf_cable");
  const obj = makeObject(cableObjectId, comp.id, {
    rfCableEndpoints: {
      A: { targetObjectId: a.objectId, targetAnchorId: "rf_out", targetAnchorName: a.anchorName },
      B: { targetObjectId: b.objectId, targetAnchorId: "rf_in", targetAnchorName: b.anchorName },
    },
  });
  const pe = makePe(cableObjectId, "rf_cable", { lengthMm: 100 });
  return { obj, comp, asset, pe };
}

// =============================================================================
// Tests
// =============================================================================

describe("buildRfPropagation", () => {
  it("propagates source → amplifier → AOM through the cable chain (I1–I4)", () => {
    const src = makeAd9959("src1", 80.0, 0.5); // 0.5 Vpp at source
    const amp = makeAmp("amp1", 20.0); // 20 dB gain → ×10
    const aom = makeAom("aom1");
    const cableA = makeCable("cableA", { objectId: "src1", anchorName: "CH0" }, { objectId: "amp1", anchorName: "rf_in" });
    const cableB = makeCable("cableB", { objectId: "amp1", anchorName: "rf_out" }, { objectId: "aom1", anchorName: "rf_in" });

    const result = buildRfPropagation({
      objects: [src.obj, amp.obj, aom.obj, cableA.obj, cableB.obj],
      components: [src.comp, amp.comp, aom.comp, cableA.comp, cableB.comp],
      assets: [src.asset, amp.asset, aom.asset, cableA.asset, cableB.asset],
      physicsElements: [src.pe, amp.pe, aom.pe, cableA.pe, cableB.pe],
    });

    const srcVpp = 0.5 * AD9959_VPP_FULL_SCALE;

    // I1 — source port carries raw state.
    const atSource = result.signalAtPort.get(portKey("src1", "CH0"));
    expect(atSource).toBeDefined();
    expect(atSource!.frequencyMhz).toBe(80.0);
    expect(atSource!.vpp).toBeCloseTo(srcVpp, 6);
    expect(atSource!.cumulativeGainDb).toBe(0);

    // I2 — amp input mirrors source (lossless cable for now).
    const atAmpIn = result.signalAtPort.get(portKey("amp1", "rf_in"));
    expect(atAmpIn).toBeDefined();
    expect(atAmpIn!.vpp).toBeCloseTo(srcVpp, 6);
    expect(atAmpIn!.cumulativeGainDb).toBe(0);

    // I3 — amp output applies +20 dB → Vpp ×10.
    const atAmpOut = result.signalAtPort.get(portKey("amp1", "rf_out"));
    expect(atAmpOut).toBeDefined();
    expect(atAmpOut!.vpp).toBeCloseTo(srcVpp * 10, 5);
    expect(atAmpOut!.cumulativeGainDb).toBeCloseTo(20, 6);
    expect(atAmpOut!.saturated).toBe(false);

    // I4 — AOM rf_in receives the amplifier output.
    const atAom = result.signalAtPort.get(portKey("aom1", "rf_in"));
    expect(atAom).toBeDefined();
    expect(atAom!.vpp).toBeCloseTo(srcVpp * 10, 5);
    expect(atAom!.frequencyMhz).toBe(80.0);
    expect(atAom!.passthroughObjectIds).toEqual(["amp1"]);
    expect(atAom!.sourceObjectId).toBe("src1");
  });

  it("clamps Vpp at outputPowerMaxDbm and flags saturated (I5)", () => {
    // Source 1.0 Vpp · 30 dB gain → would be 31.6 Vpp ≈ +37 dBm, but cap at +30 dBm.
    const src = makeAd9959("src1", 80.0, 1.0);
    const amp = makeAmp("amp1", 30.0, 30.0); // gain 30 dB, max +30 dBm = 1 W
    const aom = makeAom("aom1");
    const cableA = makeCable("cA", { objectId: "src1", anchorName: "CH0" }, { objectId: "amp1", anchorName: "rf_in" });
    const cableB = makeCable("cB", { objectId: "amp1", anchorName: "rf_out" }, { objectId: "aom1", anchorName: "rf_in" });

    const result = buildRfPropagation({
      objects: [src.obj, amp.obj, aom.obj, cableA.obj, cableB.obj],
      components: [src.comp, amp.comp, aom.comp, cableA.comp, cableB.comp],
      assets: [src.asset, amp.asset, aom.asset, cableA.asset, cableB.asset],
      physicsElements: [src.pe, amp.pe, aom.pe, cableA.pe, cableB.pe],
    });

    const expectedClampVpp = powerWToVpp(1.0); // 1 W = +30 dBm
    const atAom = result.signalAtPort.get(portKey("aom1", "rf_in"));
    expect(atAom).toBeDefined();
    expect(atAom!.vpp).toBeCloseTo(expectedClampVpp, 5);
    expect(atAom!.saturated).toBe(true);
  });

  it("uses the rf_amplifier plugin's declared rfTransfer (Phase 5 pattern)", () => {
    // Sanity: rfAmplifierTransfer was moved from the central registry into
    // `kinds/rf_amplifier/transfer.ts` and re-declared on the plugin as
    // `physics.rfTransfer`. The walker should pick it up via the plugin
    // lookup, not the legacy hardcoded map. Verify by exercising the
    // exact gain math with an unusual gain value the legacy implementation
    // doesn't know about specially — same code path proves the dispatch
    // went through the plugin, not a stale duplicate.
    const src = makeAd9959("src1", 80.0, 0.1);
    const amp = makeAmp("amp1", 13.5); // odd gain so no test fixture aliases it
    const aom = makeAom("aom1");
    const cA = makeCable("ca", { objectId: "src1", anchorName: "CH0" }, { objectId: "amp1", anchorName: "rf_in" });
    const cB = makeCable("cb", { objectId: "amp1", anchorName: "rf_out" }, { objectId: "aom1", anchorName: "rf_in" });
    const result = buildRfPropagation({
      objects: [src.obj, amp.obj, aom.obj, cA.obj, cB.obj],
      components: [src.comp, amp.comp, aom.comp, cA.comp, cB.comp],
      assets: [src.asset, amp.asset, aom.asset, cA.asset, cB.asset],
      physicsElements: [src.pe, amp.pe, aom.pe, cA.pe, cB.pe],
    });
    const expected = 0.1 * AD9959_VPP_FULL_SCALE * Math.pow(10, 13.5 / 20);
    const atAom = result.signalAtPort.get(portKey("aom1", "rf_in"))!;
    expect(atAom.vpp).toBeCloseTo(expected, 5);
    expect(atAom.cumulativeGainDb).toBeCloseTo(13.5, 6);
  });

  it("seeds CH1..CH3 with defaults even when only CH0 has a persisted channel entry", () => {
    // Bug repro: editing only CH0 used to short-circuit the fallback,
    // leaving CH1..CH3 unseeded. Cables hanging off CH1 saw "no upstream"
    // even though the DDS clearly drives that anchor.
    const src = makeAd9959FourCh("src1");
    // Inject ONE persisted channel for CH0 only (mirrors what
    // commitChannelEdit does after the first edit). CH1..CH3 stay absent.
    src.pe.kindParams = {
      channels: [
        {
          channelIndex: 0,
          anchorName: "CH0",
          mode: "single_tone",
          channelEnabled: true,
          frequencyMhz: 120.0, // user-typed value
          phaseDeg: 0,
          amplitudeScale: 0.4,
          sweep: null,
          modulationLevels: 4,
          profiles: null,
        },
      ],
    };
    const aom = makeAom("aom1");
    // Cable goes from CH1, not CH0 — exercises the fallback for an
    // anchor that the user never touched.
    const cable = makeCable("c", { objectId: "src1", anchorName: "CH1" }, { objectId: "aom1", anchorName: "rf_in" });
    const result = buildRfPropagation({
      objects: [src.obj, aom.obj, cable.obj],
      components: [src.comp, aom.comp, cable.comp],
      assets: [src.asset, aom.asset, cable.asset],
      physicsElements: [src.pe, aom.pe, cable.pe],
    });
    // CH0 carries the persisted state.
    const ch0 = result.signalAtPort.get(portKey("src1", "CH0"))!;
    expect(ch0.frequencyMhz).toBe(120.0);
    expect(ch0.vpp).toBeCloseTo(0.4 * AD9959_VPP_FULL_SCALE, 6);
    // CH1 falls back to defaults — and DRIVES the AOM via the cable.
    const ch1 = result.signalAtPort.get(portKey("src1", "CH1"))!;
    expect(ch1.frequencyMhz).toBe(80.0);
    expect(ch1.vpp).toBeCloseTo(AD9959_VPP_FULL_SCALE, 6);
    const atAom = result.signalAtPort.get(portKey("aom1", "rf_in"))!;
    expect(atAom.frequencyMhz).toBe(80.0);
    expect(atAom.sourceAnchorName).toBe("CH1");
  });

  it("synthesises default channels from asset rf_out anchors when channels[] is null", () => {
    // The dds_ad9959_pcb auto-create path leaves the PhysicsElement with
    // channels: null. The propagation walker must still emit a signal so
    // the AOM rf_in shows live readings on first load (before the user
    // edits any channel). Defaults are 80 MHz at amp=1.0.
    const src = makeAd9959("src1", 80.0, 0.5);
    src.pe.kindParams = {}; // strip the channels[] the builder seeded
    const aom = makeAom("aom1");
    const cable = makeCable("c", { objectId: "src1", anchorName: "CH0" }, { objectId: "aom1", anchorName: "rf_in" });

    const result = buildRfPropagation({
      objects: [src.obj, aom.obj, cable.obj],
      components: [src.comp, aom.comp, cable.comp],
      assets: [src.asset, aom.asset, cable.asset],
      physicsElements: [src.pe, aom.pe, cable.pe],
    });

    const atAom = result.signalAtPort.get(portKey("aom1", "rf_in"));
    expect(atAom).toBeDefined();
    expect(atAom!.frequencyMhz).toBe(80.0);
    expect(atAom!.vpp).toBeCloseTo(AD9959_VPP_FULL_SCALE, 6);
    expect(atAom!.sourceAnchorName).toBe("CH0");
  });

  it("regression: direct source → AOM (no amplifier) still works (I6)", () => {
    const src = makeAd9959("src1", 80.0, 0.7);
    const aom = makeAom("aom1");
    const cable = makeCable("c", { objectId: "src1", anchorName: "CH0" }, { objectId: "aom1", anchorName: "rf_in" });

    const result = buildRfPropagation({
      objects: [src.obj, aom.obj, cable.obj],
      components: [src.comp, aom.comp, cable.comp],
      assets: [src.asset, aom.asset, cable.asset],
      physicsElements: [src.pe, aom.pe, cable.pe],
    });

    const atAom = result.signalAtPort.get(portKey("aom1", "rf_in"));
    expect(atAom).toBeDefined();
    expect(atAom!.vpp).toBeCloseTo(0.7 * AD9959_VPP_FULL_SCALE, 6);
    expect(atAom!.cumulativeGainDb).toBe(0);
    expect(atAom!.passthroughObjectIds).toEqual([]);
  });
});
