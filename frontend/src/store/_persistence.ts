/**
 * Sub-module of sceneStore — localStorage adapters. Each load/save
 * pair is wrapped in try/catch so storage-quota / SSR / private-mode
 * failures degrade silently to sensible defaults rather than crashing
 * the store on init.
 *
 * Imported by sceneStore.ts; consumers don't reference this file
 * directly.
 */
import {
  ACTIVE_COLLECTION_STORAGE_KEY,
  TRANSFORM_CURSOR_HIDDEN_STORAGE_KEY,
  TRANSFORM_CURSOR_STORAGE_KEY,
  TRANSFORM_CURSOR_STORAGE_KEY_V1,
} from "./_constants";

type LabPointLite = { x: number; y: number; z: number };

function sanitizeLabPoint(p: Partial<LabPointLite> | null | undefined): LabPointLite {
  return {
    x: typeof p?.x === "number" && Number.isFinite(p.x) ? p.x : 0,
    y: typeof p?.y === "number" && Number.isFinite(p.y) ? p.y : 0,
    z: typeof p?.z === "number" && Number.isFinite(p.z) ? p.z : 0,
  };
}

export function loadTransformCursorMm(): {
  left: LabPointLite;
  right: LabPointLite;
} {
  if (typeof window === "undefined")
    return { left: { x: 0, y: 0, z: 0 }, right: { x: 0, y: 0, z: 0 } };
  try {
    const rawV2 = window.localStorage.getItem(TRANSFORM_CURSOR_STORAGE_KEY);
    if (rawV2) {
      const parsed = JSON.parse(rawV2) as Partial<{ left: LabPointLite; right: LabPointLite }>;
      return { left: sanitizeLabPoint(parsed.left), right: sanitizeLabPoint(parsed.right) };
    }
    // Fallback to legacy single-cursor key — seed both panels with the
    // same value so existing sessions don't lose their pinned pivot.
    const rawV1 = window.localStorage.getItem(TRANSFORM_CURSOR_STORAGE_KEY_V1);
    if (rawV1) {
      const seed = sanitizeLabPoint(JSON.parse(rawV1) as Partial<LabPointLite>);
      return { left: seed, right: seed };
    }
  } catch {
    // ignore parse errors — fall through to defaults
  }
  return { left: { x: 0, y: 0, z: 0 }, right: { x: 0, y: 0, z: 0 } };
}

export function saveTransformCursorMm(value: {
  left: LabPointLite;
  right: LabPointLite;
}): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TRANSFORM_CURSOR_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // ignore quota / availability errors
  }
}

export function loadTransformCursorHidden(): { left: boolean; right: boolean } {
  if (typeof window === "undefined") return { left: false, right: false };
  try {
    const raw = window.localStorage.getItem(TRANSFORM_CURSOR_HIDDEN_STORAGE_KEY);
    if (!raw) return { left: false, right: false };
    const parsed = JSON.parse(raw) as Partial<{ left: boolean; right: boolean }>;
    return { left: parsed.left === true, right: parsed.right === true };
  } catch {
    return { left: false, right: false };
  }
}

export function saveTransformCursorHidden(value: {
  left: boolean;
  right: boolean;
}): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      TRANSFORM_CURSOR_HIDDEN_STORAGE_KEY,
      JSON.stringify(value),
    );
  } catch {
    // ignore quota / availability errors
  }
}

export function loadActiveCollectionId(): string | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(ACTIVE_COLLECTION_STORAGE_KEY);
  return value && value.length > 0 ? value : null;
}

export function saveActiveCollectionId(value: string | null): void {
  if (typeof window === "undefined") return;
  if (value) window.localStorage.setItem(ACTIVE_COLLECTION_STORAGE_KEY, value);
  else window.localStorage.removeItem(ACTIVE_COLLECTION_STORAGE_KEY);
}
