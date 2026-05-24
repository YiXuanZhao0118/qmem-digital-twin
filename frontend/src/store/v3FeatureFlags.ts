/**
 * v3 feature flags — opt-in gate for the new Asset-Physics-Model tracer.
 *
 * Sources (in priority order):
 *   1. URL query param  `?useV3RayTracer=1`  / `=0`
 *   2. localStorage     `qmem.flag.useV3RayTracer`  = `"true"` / `"false"`
 *   3. Default          false (v2 stays default while Phase 3d is the
 *                       only consumer; Phase 4+ will flip after ops
 *                       converge)
 *
 * The flag is a plain Zustand atom — no React hooks needed in non-UI
 * code. UI components subscribe via `useV3FeatureFlags(s => s.useV3RayTracer)`.
 */

import { create } from "zustand";

const STORAGE_KEY = "qmem.flag.useV3RayTracer";

function readInitial(): boolean {
  // SSR / non-browser safety.
  if (typeof window === "undefined") return false;

  // URL param wins (explicit override during a session).
  try {
    const param = new URLSearchParams(window.location.search).get("useV3RayTracer");
    if (param === "1" || param === "true") return true;
    if (param === "0" || param === "false") return false;
  } catch {
    // ignore — bad URL parse shouldn't take down the app
  }

  // localStorage persistence.
  try {
    const stored = window.localStorage?.getItem(STORAGE_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {
    // localStorage may be disabled / unavailable
  }

  return false;
}

function persist(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(STORAGE_KEY, value ? "true" : "false");
  } catch {
    // ignore
  }
}

type V3Flags = {
  useV3RayTracer: boolean;
  setUseV3RayTracer: (value: boolean) => void;
};

export const useV3FeatureFlags = create<V3Flags>((set) => ({
  useV3RayTracer: readInitial(),
  setUseV3RayTracer: (value) => {
    persist(value);
    set({ useV3RayTracer: value });
  },
}));

/** Non-React getter — useful inside pure functions (e.g. inside a
 *  ray-tracing dispatcher that decides v2 vs v3). */
export function isV3RayTracerEnabled(): boolean {
  return useV3FeatureFlags.getState().useV3RayTracer;
}
