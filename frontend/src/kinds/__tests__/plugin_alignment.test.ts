/**
 * Plugin-vs-legacy alignment check.
 *
 * Each migrated ComponentPlugin in `PLUGINS` must agree with the
 * still-hand-maintained legacy tables (KIND_REGISTRY,
 * COMPONENT_TYPE_TO_KIND, KIND_LABELS, DEFAULT_KIND_PARAMS) on every
 * field we care about. If a plugin author drifts from the legacy data,
 * this test fails before the drift hits production.
 *
 * Once M2 finishes migrating every kind, the legacy tables become
 * derived from PLUGINS and this test becomes a fixed-point (legacy ===
 * derived). M3 deletes the legacy tables entirely.
 */
import { describe, it, expect } from "vitest";

import { PLUGINS, verifyAlignment } from "../_plugins";
import { KIND_REGISTRY } from "../_registry";
import {
  componentTypeToElementKind,
  DEFAULT_KIND_PARAMS,
  KIND_LABELS,
} from "../../utils/elementDefaults";

describe("ComponentPlugin alignment with legacy tables", () => {
  it("every migrated plugin matches the legacy KIND_REGISTRY entry", () => {
    const report = verifyAlignment(
      KIND_REGISTRY as unknown as Record<
        string,
        { kind: string; displayName: string; requiredAnchors: readonly string[] }
      >,
      KIND_LABELS as unknown as Record<string, string>,
      DEFAULT_KIND_PARAMS as unknown as Record<string, Record<string, unknown>>,
      componentTypeToElementKind,
    );
    if (!report.ok) {
      throw new Error(
        `Plugin/legacy alignment failures (${report.errors.length}):\n` +
          report.errors.map((e) => `  - ${e}`).join("\n"),
      );
    }
    expect(report.ok).toBe(true);
  });

  it("PLUGINS array contains the expected M1 sample set", () => {
    const ids = PLUGINS.map((p) => p.id).sort();
    expect(ids).toEqual(["aom", "fiber", "mirror", "mirror_mount", "rf_switch"]);
  });

  it("no two plugins claim the same componentType", () => {
    const seen = new Map<string, string>();
    for (const p of PLUGINS) {
      for (const ct of p.componentTypes) {
        const prior = seen.get(ct);
        if (prior) {
          throw new Error(`componentType "${ct}" claimed by both ${prior} and ${p.id}`);
        }
        seen.set(ct, p.id);
      }
    }
  });

  it("every physics plugin's id matches its physics.elementKind", () => {
    for (const p of PLUGINS) {
      if (p.physics) {
        expect(p.id).toBe(p.physics.elementKind);
      }
    }
  });
});
