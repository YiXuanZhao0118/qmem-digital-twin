/**
 * Per-beam show/hide — the beam list the Display popover renders.
 *
 * The list is derived from the physics elements, not from a trace result, so
 * a beam stays listed (and re-showable) while it is hidden. The two things
 * worth pinning: one row per EMISSION (a TA has two, a laser one), and the
 * physics-gate hint present only where the backend actually honours the
 * emission gate — a seeded TA's forward output is a re-emission the tracer
 * never checks, so no "On" switch is offered there.
 */
import { describe, expect, it } from "vitest";

import type { PhysicsElement, SceneObject } from "../../types/digitalTwin";
import { beamKey, isBeamVisible, listSceneBeams } from "../beamVisibility";

function obj(id: string, name: string): SceneObject {
  return { id, name, properties: {} } as unknown as SceneObject;
}

function element(objectId: string, elementKind: string): PhysicsElement {
  return { id: `pe-${objectId}`, objectId, elementKind, kindParams: {} } as unknown as PhysicsElement;
}

describe("listSceneBeams", () => {
  const scene = {
    objects: [obj("ta", "TAPERED_AMPLIFIER0"), obj("l1", "LASER_SOURCE1"), obj("m", "MIRROR5")],
    physicsElements: [
      element("ta", "tapered_amplifier"),
      element("l1", "laser_source"),
      element("m", "mirror"),
    ],
  };

  it("lists one row per emission, emitters only, in object-name order", () => {
    expect(listSceneBeams(scene).map((b) => `${b.objectName} ${b.emissionLabel}`)).toEqual([
      "LASER_SOURCE1 Beam",
      "TAPERED_AMPLIFIER0 Input",
      "TAPERED_AMPLIFIER0 Output",
    ]);
  });

  it("keys each beam on emitter + emission, matching the traced segments", () => {
    expect(listSceneBeams(scene).map((b) => b.key)).toEqual([
      beamKey("l1", "main"),
      beamKey("ta", "backward"),
      beamKey("ta", "forward"),
    ]);
  });

  it("offers the physical emission switch only where the backend gates it", () => {
    const gated = Object.fromEntries(
      listSceneBeams(scene).map((b) => [b.key, b.physicsHint !== null]),
    );
    expect(gated).toEqual({
      [beamKey("l1", "main")]: true,
      [beamKey("ta", "backward")]: true,
      // Seeded-TA re-emission — anchor_tracer never consults emissionVisuals.
      [beamKey("ta", "forward")]: false,
    });
  });

  it("skips elements whose SceneObject is missing", () => {
    expect(
      listSceneBeams({ objects: [], physicsElements: [element("l1", "laser_source")] }),
    ).toEqual([]);
  });
});

describe("isBeamVisible", () => {
  const a = beamKey("l1", "main");
  const b = beamKey("ta", "forward");

  it("hides only what the hidden set names when not soloing", () => {
    expect(isBeamVisible(a, new Set([a]), null)).toBe(false);
    expect(isBeamVisible(b, new Set([a]), null)).toBe(true);
  });

  it("lets solo decide on its own — a soloed beam shows even if it was hidden", () => {
    expect(isBeamVisible(a, new Set([a]), new Set([a]))).toBe(true);
    expect(isBeamVisible(b, new Set(), new Set([a]))).toBe(false);
  });
});
