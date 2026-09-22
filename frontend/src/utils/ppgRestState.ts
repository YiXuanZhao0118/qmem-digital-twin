/**
 * A PPG's rest level — the level its line sits at OUTSIDE the drawn blocks
 * (`level = inInterval XOR restState === "HIGH"`, see
 * `ProgrammablePulseGeneratorParams.restState`) — read and written through
 * the parameter-ownership chain.
 *
 * Both RF resolvers read it through that chain: per-instance
 * `SceneObject.dynamicSources` wins, then the primary Asset's `defaultParams`,
 * then the PhysicsElement's legacy `kindParams` (frontend
 * `rfPropagation.resolveElementParams`, backend `rf_resolve._resolved_params`).
 * The Pulse & Timing pill used to read and write `kindParams` alone, so a
 * value on either higher tier shadowed it: the pill flipped and the gate did
 * not. Per-instance runtime values belong in `dynamicSources`
 * (docs/introduce/object.md), so that is where the pill writes.
 *
 * `restState` does not need to be in the asset's `tunable_params` for this to
 * work: neither RF resolver filters `dynamicSources` by tunability (only the
 * optical loader does, and it never reads `restState`).
 */
import type {
  Asset3D,
  ComponentBinding,
  ComponentItem,
  PhysicsElement,
  SceneObject,
} from "../types/digitalTwin";
import { primaryAsset } from "./componentBindings";

export type PpgRestState = "HIGH" | "LOW";

type SceneSlice = {
  components: readonly ComponentItem[];
  assets: readonly Asset3D[];
  componentBindings?: readonly ComponentBinding[];
};

/** The rest level the RF BFS gates on for this PPG: the same
 *  `{...kindParams, ...asset defaultParams, ...dynamicSources}` merge as
 *  `rfPropagation.resolveElementParams`, asset picked by `primaryAsset` as
 *  `buildAssetParamsByObject` does. Anything but `"HIGH"` reads as LOW. */
export function resolvePpgRestState(
  sceneObject: SceneObject | undefined,
  physicsElement: PhysicsElement | undefined,
  scene: SceneSlice,
): PpgRestState {
  const component = sceneObject
    ? scene.components.find((c) => c.id === sceneObject.componentId)
    : undefined;
  const asset = component
    ? primaryAsset(component, {
        componentBindings: scene.componentBindings ?? [],
        assets: scene.assets,
      })
    : null;
  const merged: Record<string, unknown> = {
    ...((physicsElement?.kindParams ?? {}) as Record<string, unknown>),
    ...((asset?.defaultParams ?? {}) as Record<string, unknown>),
    ...((sceneObject?.dynamicSources ?? {}) as Record<string, unknown>),
  };
  return merged.restState === "HIGH" ? "HIGH" : "LOW";
}

/** The `updateSceneObject` patch that sets the rest level: the object's
 *  `dynamicSources` with `restState` replaced and every other key kept (the
 *  PATCH replaces the whole column). */
export function ppgRestStatePatch(
  sceneObject: SceneObject,
  next: PpgRestState,
): { dynamicSources: Record<string, unknown> } {
  return {
    dynamicSources: {
      ...((sceneObject.dynamicSources ?? {}) as Record<string, unknown>),
      restState: next,
    },
  };
}
