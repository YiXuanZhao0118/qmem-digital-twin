/**
 * OpticalKindsEditor — read-only viewer for the optical-kind contracts
 * that live in `src/optical/kinds/_registry.ts`.
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

import { useMemo, useState } from "react";

import { KIND_REGISTRY } from "../optical/kinds/_registry";
import type { KindContract } from "../optical/kinds/_registry";
import { useSceneStore } from "../store/sceneStore";
import type { ElementKind } from "../types/digitalTwin";
import { componentTypeToOpticalKind } from "../utils/opticalDefaults";

const VARIANT_LABELS: Record<KindContract["alignVariant"], string> = {
  translate_anchor_to_beam:
    "Translate anchor → beam axis (no rotation)",
  translate_and_bragg_rotate:
    "Translate face → beam, rotate body to satisfy Bragg",
  translate_anti_parallel:
    "Translate input → beam (anti-parallel direction required)",
  none: "No generic align (emitter or custom action)",
};

const VARIANT_COLOURS: Record<KindContract["alignVariant"], string> = {
  translate_anchor_to_beam: "#3b82f6",
  translate_and_bragg_rotate: "#a855f7",
  translate_anti_parallel: "#22c55e",
  none: "#64748b",
};

export function OpticalKindsEditor() {
  const allKinds = Object.keys(KIND_REGISTRY) as ElementKind[];
  const components = useSceneStore((s) => s.scene.components);
  const [showAll, setShowAll] = useState(false);

  // Phase 7.4 follow-up: filter the read-only contract grid down to kinds
  // that are actually instantiated in the current scene. This keeps the
  // PHY Editor focused on what the user is working with — previously the
  // 20-kind grid contained ~13 kinds with no instances. Toggle to see
  // every kind in the registry (useful when scaffolding a new component).
  const usedKinds = useMemo(() => {
    const set = new Set<ElementKind>();
    for (const c of components) {
      const k = componentTypeToOpticalKind(c.componentType);
      if (k) set.add(k);
    }
    return set;
  }, [components]);

  const kinds = showAll ? allKinds : allKinds.filter((k) => usedKinds.has(k));
  const hiddenCount = allKinds.length - kinds.length;

  return (
    <div className="kinds-editor">
      <div className="component-editor-subbar">
        <div className="component-editor-title">
          <strong>Optical → Kinds</strong>
          <span style={{ opacity: 0.7, marginLeft: 8 }}>
            · contract for {kinds.length} of {allKinds.length} optical-element kinds
          </span>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <label style={{ fontSize: 13, opacity: 0.85, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              style={{ marginRight: 4, verticalAlign: "middle" }}
            />
            Show all (incl. {hiddenCount > 0 ? `${hiddenCount} unused` : "no extra"})
          </label>
        </div>
      </div>

      <div className="kinds-editor-banner">
        Read-only. Kind contracts live in
        <code style={{ marginLeft: 4, marginRight: 4 }}>
          src/optical/kinds/_registry.ts
        </code>
        — edit via PR. UI editing will land when the
        <code style={{ marginLeft: 4 }}>optical_kinds</code> DB table
        is added.
        {!showAll && hiddenCount > 0 && (
          <span style={{ marginLeft: 8, opacity: 0.7 }}>
            · Hiding {hiddenCount} kind{hiddenCount === 1 ? "" : "s"} with no
            scene instance — toggle "Show all" to reveal.
          </span>
        )}
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
