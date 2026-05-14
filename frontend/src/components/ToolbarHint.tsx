// Contextual hint strip rendered inside the viewer at the top, below the
// scene toolbar. Text changes based on selection state + the most recent
// snap result so the user always sees what they can do next without
// hovering tooltips.
//
// Tips marked with `tipKey` are shown only the first N times — once the
// user has seen one M times, it's auto-suppressed (localStorage).

import { useEffect, useState } from "react";

import { useSceneStore, TOUCH_OP_BY_ID, type FeatureKind } from "../store/sceneStore";

const KIND_LABEL_LOWER: Record<FeatureKind, string> = {
  vertex: "vertex",
  edge: "edge",
  face: "face",
};
const KIND_HOVER_HINT: Record<FeatureKind, string> = {
  vertex: "Yellow ball under the cursor = the vertex that will be picked.",
  edge: "Yellow line under the cursor = the edge that will be picked.",
  face: "Yellow triangle outline + disc under the cursor = the face that will be picked.",
};

const TIP_SEEN_KEY = "qmem.hintbar.seenCounts.v1";
const TIP_REPEAT_LIMIT = 5; // show the same one-shot tip up to N times

function loadSeenCounts(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(TIP_SEEN_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function bumpSeenCount(key: string): number {
  if (typeof window === "undefined") return 0;
  const counts = loadSeenCounts();
  counts[key] = (counts[key] ?? 0) + 1;
  try {
    window.localStorage.setItem(TIP_SEEN_KEY, JSON.stringify(counts));
  } catch {
    // ignore quota errors
  }
  return counts[key];
}

type ToolbarHintProps = {
  // displayMode + gizmoMode are supplied by the parent viewer instance —
  // each panel in dual-view holds its own values, so the hint text
  // ("Drag X/Y/Z arrows…" vs "Drag rings…") stays accurate per panel.
  displayMode?: "wireframe" | "rendered" | "node-edit";
  gizmoMode?: "translate" | "rotate" | "scale";
};

export function ToolbarHint({ displayMode = "rendered", gizmoMode = "translate" }: ToolbarHintProps) {
  const selectedObjectIds = useSceneStore((state) => state.selectedObjectIds);
  const activeTool = useSceneStore((state) => state.activeTool);
  const faceTouchOp = useSceneStore((state) => state.faceTouchOp);
  const faceTouchPending = useSceneStore((state) => state.faceTouchPending);
  const faceTouchError = useSceneStore((state) => state.faceTouchError);

  // Render tip + optional one-shot extra tip.
  const { primary, tipKey, extra, tone } = (() => {
    // Touch tool (one of 6 ops) — highest priority when active.
    if (activeTool === "face-touch") {
      const op = TOUCH_OP_BY_ID[faceTouchOp];
      if (faceTouchError) {
        return {
          primary: `⚠ ${faceTouchError}`,
          tipKey: null as string | null,
          extra: null as string | null,
          tone: "warn" as const,
        };
      }
      if (!faceTouchPending) {
        return {
          primary: `${op.label} · hover to preview (yellow), click the FIRST ${KIND_LABEL_LOWER[op.firstKind].toUpperCase()} on any wireframe (Esc to cancel)`,
          tipKey: `face-touch-step1-${op.id}`,
          extra: KIND_HOVER_HINT[op.firstKind],
          tone: "tool" as const,
        };
      }
      // Step 2 — picking the second feature.
      const constraintExtra = (() => {
        switch (op.id) {
          case "vv":
            return "Two vertices coincide. No alignment constraint.";
          case "ve":
            return "Vertex coincides with edge midpoint. No alignment constraint.";
          case "vf":
            return "Vertex coincides with face click point. No alignment constraint.";
          case "ee":
            return "Edge midpoints coincide. Edges must be parallel (~10°).";
          case "ef":
            return "Edge midpoint coincides with face click point. Edge must lie in face plane (~10°).";
          case "ff":
            return "Face lands on the first face's plane along normal. Faces must be parallel (~4°).";
        }
      })();
      return {
        primary: `${op.label} · now click the SECOND ${KIND_LABEL_LOWER[op.secondKind].toUpperCase()} on a different object`,
        tipKey: `face-touch-step2-${op.id}`,
        extra: constraintExtra,
        tone: "tool" as const,
      };
    }
    if (selectedObjectIds.length > 1) {
      return {
        primary: `${selectedObjectIds.length} objects selected — gizmo translates all by the same delta. Edit absolute values in 'Group centre' panel.`,
        tipKey: "multiselect-translate",
        extra: "Tip: switch active object inside the selection to change which one's pose anchors the gizmo.",
        tone: "default" as const,
      };
    }
    if (selectedObjectIds.length === 1) {
      const modeText = gizmoMode === "translate" ? "Drag X/Y/Z arrows to move" : gizmoMode === "rotate" ? "Drag rings to rotate" : "Drag handles to scale";
      const wireText = displayMode === "wireframe" ? "  ·  Touch tool available in toolbar" : "";
      return {
        primary: `${modeText}${wireText}`,
        tipKey: "single-select",
        extra: "Tip: type expressions in N-panel — '+=50', '*2', 'mid(A, B)'.",
        tone: "default" as const,
      };
    }
    return {
      primary: "Click an object in the 3D viewer or outliner to start. Shift+S in the viewer = cursor commands.",
      tipKey: null,
      extra: null,
      tone: "default" as const,
    };
  })();

  const [extraVisible, setExtraVisible] = useState(false);
  useEffect(() => {
    if (!tipKey) {
      setExtraVisible(false);
      return;
    }
    const count = bumpSeenCount(tipKey);
    setExtraVisible(count <= TIP_REPEAT_LIMIT);
  }, [tipKey]);

  return (
    <div className={`toolbar-hint toolbar-hint-${tone}`} role="status">
      <span className="toolbar-hint-primary">{primary}</span>
      {extra && extraVisible && (
        <span className="toolbar-hint-extra">{extra}</span>
      )}
    </div>
  );
}
