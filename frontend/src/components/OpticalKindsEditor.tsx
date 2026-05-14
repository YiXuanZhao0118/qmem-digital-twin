/**
 * OpticalKindsEditor — read-only viewer for the optical-kind contracts
 * that live in `src/kinds/_registry.ts`.
 *
 * Each row represents one ElementKind (mirror, AOM, PBS, ...) and shows
 * what every component of that kind is expected to provide:
 *    - required anchors  (the model is non-functional without them)
 *    - optional anchors  (improve behaviour when present)
 *    - align variant     (which alignAlgorithm dispatch is used)
 *    - tolerance         (snap-to-beam radius in mm)
 *    - align summary     (one-line plain-English description)
 *
 * Phase 7.1 / MVP: contract definitions are TypeScript code, not data.
 * Editing requires a code change + PR + redeploy. When the
 * `optical_kinds` DB table arrives (P8/P9), this editor will get a real
 * edit form. For now it's a transparency surface so users editing
 * Components know exactly what each kind expects from them.
 */

import { useMemo } from "react";

import { KIND_REGISTRY } from "../kinds/_registry";
import type { KindContract } from "../kinds/_registry";
import { useSceneStore } from "../store/sceneStore";
import type { ElementKind } from "../types/digitalTwin";
import {
  componentTypeToElementKind,
  domainForElementKind,
} from "../utils/elementDefaults";

const VARIANT_LABELS: Record<KindContract["alignVariant"], string> = {
  translate_anchor_to_beam:
    "Translate anchor → beam axis (no rotation)",
  translate_and_bragg_rotate:
    "Translate face → beam, rotate body to satisfy Bragg",
  translate_anti_parallel:
    "Rotate + translate body so beam passes through intercept_in and intercept_out",
  none: "No generic align (emitter or custom action)",
};

const VARIANT_COLOURS: Record<KindContract["alignVariant"], string> = {
  translate_anchor_to_beam: "#3b82f6",
  translate_and_bragg_rotate: "#a855f7",
  translate_anti_parallel: "#22c55e",
  none: "#64748b",
};

// Use the centralized RF / Optical split from elementDefaults.ts so any
// new RF kind (rf_amplifier, rf_cable, rf_switch, …) shows up under the
// RF rail tab automatically. Previously this file had its own hardcoded
// 2-entry set that went stale every time a new RF kind landed.
function isRfKind(k: ElementKind): boolean {
  return domainForElementKind(k) === "rf";
}

// Optical-tab allowlist: kinds that ALWAYS appear under Optical → Kinds
// even when no SceneObject of that kind is in the current scene. The
// rest of the Optical kinds are auto-hidden when the scene has no
// instance (keeps the grid focused). RF kinds are never hidden — every
// RF kind always renders so newly-added RF gear is immediately
// inspectable.
const OPTICAL_ALWAYS_SHOW: ReadonlySet<ElementKind> = new Set<ElementKind>([
  "dichroic_mirror",
  "lens_cylindrical",
  "polarizer",
  "detector",
  "camera",
]);

export function OpticalKindsEditor({ domain = "optical" }: { domain?: "optical" | "rf" } = {}) {
  const allKindsRaw = Object.keys(KIND_REGISTRY) as ElementKind[];
  // Filter to the domain the rail tab represents. RF tab shows every
  // kind whose domainForElementKind() == "rf" (currently rf_source,
  // horn_antenna, rf_cable, rf_amplifier, rf_switch); Optical tab shows
  // everything else. Hybrid kinds like AOM (intercept_in/out + rf_in)
  // are classified by the canonical set in elementDefaults.ts — see
  // RF_DOMAIN_KINDS there.
  const allKinds = domain === "rf"
    ? allKindsRaw.filter(isRfKind)
    : allKindsRaw.filter((k) => !isRfKind(k));
  const components = useSceneStore((s) => s.scene.components);

  // Which ElementKinds have at least one Component in the current scene.
  // Used to keep the Optical grid focused on "kinds the user is actually
  // working with" instead of the full 22-entry registry — combined with
  // OPTICAL_ALWAYS_SHOW so a handful of canonical kinds always render
  // even before any instance is placed.
  const usedKinds = useMemo(() => {
    const set = new Set<ElementKind>();
    for (const c of components) {
      const k = componentTypeToElementKind(c.componentType);
      if (k) set.add(k);
    }
    return set;
  }, [components]);

  // Final visible list:
  //   - RF tab:      every RF kind, always.
  //   - Optical tab: kinds in OPTICAL_ALWAYS_SHOW ∪ kinds with at least
  //                  one scene instance.
  const kinds = domain === "rf"
    ? allKinds
    : allKinds.filter((k) => OPTICAL_ALWAYS_SHOW.has(k) || usedKinds.has(k));
  const domainLabel = domain === "rf" ? "RF" : "Optical";

  return (
    <div className="kinds-editor">
      <div className="component-editor-subbar">
        <div className="component-editor-title">
          <strong>{domainLabel} → Kinds</strong>
          <span style={{ opacity: 0.7, marginLeft: 8 }}>
            · contract for {kinds.length} {domain}-element kind{kinds.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      <div className="kinds-editor-banner">
        Read-only. Kind contracts live in
        <code style={{ marginLeft: 4, marginRight: 4 }}>
          src/kinds/_registry.ts
        </code>
        — edit via PR. UI editing will land when the
        <code style={{ marginLeft: 4 }}>optical_kinds</code> DB table
        is added.
      </div>

      <div className="kinds-editor-grid">
        {kinds.map((kind) => {
          const c = KIND_REGISTRY[kind];
          return (
            <div key={kind} className="kinds-editor-card">
              <div className="kinds-editor-card-head">
                <strong>{c.displayName}</strong>
                <code className="kinds-editor-pill">{kind}</code>
              </div>
              <div
                className="kinds-editor-variant"
                style={{
                  borderLeftColor: VARIANT_COLOURS[c.alignVariant],
                }}
              >
                <span style={{ color: VARIANT_COLOURS[c.alignVariant] }}>
                  ▎
                </span>
                <strong style={{ marginRight: 6 }}>
                  {VARIANT_LABELS[c.alignVariant]}
                </strong>
                {c.alignVariant !== "none" && (
                  <span style={{ opacity: 0.7 }}>
                    · {c.alignToleranceMm} mm tolerance
                  </span>
                )}
              </div>
              <div className="kinds-editor-summary">{c.alignSummary}</div>
              <div className="kinds-editor-anchors">
                <div>
                  <span className="kinds-editor-anchor-label">required:</span>
                  {c.requiredAnchors.length === 0 ? (
                    <span style={{ opacity: 0.5, marginLeft: 4 }}>(none)</span>
                  ) : (
                    c.requiredAnchors.map((a) => (
                      <code key={a} className="kinds-editor-anchor-pill required">
                        {a}
                      </code>
                    ))
                  )}
                </div>
                <div>
                  <span className="kinds-editor-anchor-label">optional:</span>
                  {c.optionalAnchors.length === 0 ? (
                    <span style={{ opacity: 0.5, marginLeft: 4 }}>(none)</span>
                  ) : (
                    c.optionalAnchors.map((a) => (
                      <code key={a} className="kinds-editor-anchor-pill optional">
                        {a}
                      </code>
                    ))
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
