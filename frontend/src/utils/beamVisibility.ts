/**
 * Per-beam show/hide — the DISPLAY-only half.
 *
 * A "beam" here is one emission: the (emitter SceneObject, emissionKey)
 * pair that every traced lab segment carries (`emitterSceneObjectId` +
 * `emissionKey`, stable down the whole chain — see anchor_tracer.py). So
 * "LASER_SOURCE1" is (that object, "main") and the TA's two facets are
 * (TA, "forward") = output and (TA, "backward") = input side.
 *
 * Hiding here suppresses the DRAW only (the renderer skips those segments,
 * so they also stop being pickable). Physics is untouched — power, coupling
 * and downstream optics behave exactly as before. The other, physical
 * "Show" switch is `SceneObject.properties.emissionVisuals[key].visible`
 * (utils/emissionVisuals.ts), which makes the backend skip the emission
 * altogether and needs a re-solve.
 *
 * Two states drive the draw filter, mirroring the object-level pair in
 * SessionVisibilityState: a `hidden` deny-list and a `solo` ALLOW-list that
 * wins outright while it is non-null (`isBeamVisible`).
 */
import type { EmissionKey } from "./emissionVisuals";
import type { PhysicsElement, SceneObject } from "../types/digitalTwin";

const STORAGE_KEY = "qmem.hiddenBeamKeys.v1";
const SOLO_STORAGE_KEY = "qmem.soloBeamKeys.v1";

/** Stable id of one emission: `<sceneObjectId>:<emissionKey>`. */
export function beamKey(objectId: string, emissionKey: EmissionKey): string {
  return `${objectId}:${emissionKey}`;
}

export type SceneBeam = {
  key: string;
  objectId: string;
  objectName: string;
  emissionKey: EmissionKey;
  /** Short label for the emission itself ("Beam" / "Output" / "Input"). */
  emissionLabel: string;
  /** Tooltip for the physical emission switch, or null when the backend
   *  doesn't gate this emission at all (then no switch is offered). Only the
   *  emissions emit_laser_source.py checks are gated: the laser's "main" and
   *  the TA's ASE facets. A seeded TA's amplified output is a re-emission the
   *  tracer never gates, so a switch there would silently do nothing. */
  physicsHint: string | null;
};

/** Every emission in the scene, in object-name order. Derived from the
 *  physics elements (not from a trace result) so the list is stable even
 *  when a beam is currently hidden or the solver hasn't run yet. */
export function listSceneBeams(scene: {
  objects: SceneObject[];
  physicsElements: PhysicsElement[];
}): SceneBeam[] {
  const objectById = new Map(scene.objects.map((o) => [o.id, o]));
  const beams: SceneBeam[] = [];
  for (const element of scene.physicsElements) {
    const obj = objectById.get(element.objectId);
    if (!obj) continue;
    const push = (
      emissionKey: EmissionKey,
      emissionLabel: string,
      physicsHint: string | null,
    ) => {
      beams.push({
        key: beamKey(obj.id, emissionKey),
        objectId: obj.id,
        objectName: obj.name,
        emissionKey,
        emissionLabel,
        physicsHint,
      });
    };
    if (element.elementKind === "laser_source") {
      push(
        "main", "Beam",
        "Emit at all — off makes the solver skip this laser, so downstream "
        + "optics stop seeing the beam (re-solves).",
      );
    } else if (element.elementKind === "tapered_amplifier") {
      push("forward", "Output", null);
      push(
        "backward", "Input",
        "Emit at all — off skips the TA's backward ASE. A SEEDED TA still "
        + "re-emits backward, so this only clears the unseeded-ASE case "
        + "(re-solves).",
      );
    }
  }
  beams.sort(
    (a, b) =>
      a.objectName.localeCompare(b.objectName) ||
      a.emissionLabel.localeCompare(b.emissionLabel),
  );
  return beams;
}

export function loadHiddenBeamKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is string => typeof k === "string"));
  } catch {
    return new Set();
  }
}

export function saveHiddenBeamKeys(keys: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // localStorage full or Safari private mode
  }
}

/** The one place the two states are combined. Solo is an ALLOW-list: while it
 *  is non-null it decides on its own, so a beam the user hid earlier still
 *  shows when it is the one being soloed (and vice versa — exiting solo
 *  restores the hidden set exactly as it was). `null` solo = not soloing;
 *  an EMPTY solo set never occurs (the store drops it back to null). */
export function isBeamVisible(
  key: string,
  hidden: ReadonlySet<string>,
  solo: ReadonlySet<string> | null,
): boolean {
  if (solo) return solo.has(key);
  return !hidden.has(key);
}

export function loadSoloBeamKeys(): Set<string> | null {
  try {
    const raw = localStorage.getItem(SOLO_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const keys = parsed.filter((k): k is string => typeof k === "string");
    return keys.length > 0 ? new Set(keys) : null;
  } catch {
    return null;
  }
}

export function saveSoloBeamKeys(keys: Set<string> | null): void {
  try {
    if (!keys || keys.size === 0) localStorage.removeItem(SOLO_STORAGE_KEY);
    else localStorage.setItem(SOLO_STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // localStorage full or Safari private mode
  }
}
