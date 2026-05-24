/**
 * Vitest for v3 feature flag (Phase 3d).
 * Verifies URL → localStorage → default precedence and the
 * setter persists.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "qmem.flag.useV3RayTracer";

async function loadModuleWith(url: string, storageValue: string | null) {
  // Reset module + globals for each test.
  vi.resetModules();

  const localStorageMock = (() => {
    const store: Record<string, string> = {};
    if (storageValue !== null) store[STORAGE_KEY] = storageValue;
    return {
      getItem: (k: string) => (k in store ? store[k]! : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    };
  })();

  vi.stubGlobal("window", {
    location: { search: url },
    localStorage: localStorageMock,
  });

  return await import("../v3FeatureFlags");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("v3 feature flag / initial value", () => {
  it("defaults to false with no URL param + no storage", async () => {
    const m = await loadModuleWith("", null);
    expect(m.isV3RayTracerEnabled()).toBe(false);
  });

  it("URL ?useV3RayTracer=1 enables", async () => {
    const m = await loadModuleWith("?useV3RayTracer=1", null);
    expect(m.isV3RayTracerEnabled()).toBe(true);
  });

  it("URL ?useV3RayTracer=true enables", async () => {
    const m = await loadModuleWith("?useV3RayTracer=true", null);
    expect(m.isV3RayTracerEnabled()).toBe(true);
  });

  it("URL ?useV3RayTracer=0 explicitly disables (overrides storage)", async () => {
    const m = await loadModuleWith("?useV3RayTracer=0", "true");
    expect(m.isV3RayTracerEnabled()).toBe(false);
  });

  it("localStorage true persists across loads", async () => {
    const m = await loadModuleWith("", "true");
    expect(m.isV3RayTracerEnabled()).toBe(true);
  });
});

describe("v3 feature flag / setter", () => {
  it("setUseV3RayTracer(true) updates state", async () => {
    const m = await loadModuleWith("", null);
    expect(m.useV3FeatureFlags.getState().useV3RayTracer).toBe(false);
    m.useV3FeatureFlags.getState().setUseV3RayTracer(true);
    expect(m.useV3FeatureFlags.getState().useV3RayTracer).toBe(true);
    expect(m.isV3RayTracerEnabled()).toBe(true);
  });
});
