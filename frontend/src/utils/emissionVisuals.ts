import type { SceneObject } from "../types/digitalTwin";

export type EmissionKey = "main" | "forward" | "backward";

export type ResolvedEmissionVisual = {
  colorHex: string | null;
  visible: boolean;
};

const DEFAULT: ResolvedEmissionVisual = { colorHex: null, visible: true };

export function getEmissionVisual(
  obj: SceneObject | undefined | null,
  key: EmissionKey,
): ResolvedEmissionVisual {
  if (!obj) return DEFAULT;
  const map = obj.properties?.emissionVisuals;
  const entry = map?.[key];
  if (!entry) return DEFAULT;
  return {
    colorHex: typeof entry.colorHex === "string" ? entry.colorHex : null,
    visible: entry.visible !== false,
  };
}

/** Build a properties object suitable for `updateSceneObject({ properties })`
 *  that merges the patch into the named emission entry. The backend replaces
 *  the entire properties dict on update, so we must spread the existing
 *  properties to avoid wiping anchorBindings / opticalSources / fiberNodes /
 *  etc. Pass a partial: only the fields you set are updated; existing fields
 *  on the same emission entry are preserved. */
export function setEmissionVisualPatch(
  obj: SceneObject,
  key: EmissionKey,
  patch: Partial<ResolvedEmissionVisual>,
): SceneObject["properties"] {
  const currentMap = obj.properties?.emissionVisuals ?? {};
  const currentEntry = currentMap[key] ?? {};
  const nextEntry: { colorHex?: string | null; visible?: boolean } = { ...currentEntry };
  if ("colorHex" in patch) nextEntry.colorHex = patch.colorHex;
  if ("visible" in patch) nextEntry.visible = patch.visible;
  return {
    ...obj.properties,
    emissionVisuals: { ...currentMap, [key]: nextEntry },
  };
}
