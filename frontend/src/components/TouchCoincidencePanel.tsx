// Touch coincidence panel — opens automatically after the user finishes the
// 2-step Touch tool flow (V·V / V·E / V·F / E·E / E·F / F·F). Each op has
// a fixed number of residual DOFs that AREN'T constrained by the picked
// geometry — this panel exposes those DOFs as number inputs so the user
// can slide the result before committing.
//
//   vv → 0 DOF  (just Apply)
//   ve → 1 DOF  along B's edge direction
//   vf → 2 DOF  in B's face plane (u, v)
//   ee → 1 DOF  along the parallel shared edge direction
//   ef → 2 DOF  in B's face plane (u, v)
//   ff → 2 DOF  in the shared plane (u, v)
//
// Live preview uses previewObjectTransform; Apply commits via
// updateSceneObject; Cancel just clears the preview.

import { useEffect, useState } from "react";
import { Check, Move3D, X } from "lucide-react";

import { useSceneStore, TOUCH_OP_BY_ID } from "../store/sceneStore";
import { FloatingPanel } from "./workspace/FloatingPanel";
import { useWorkspace } from "./workspace/WorkspaceProvider";

export function TouchCoincidencePanel() {
  const preview = useSceneStore((state) => state.faceTouchPreview);
  const setPreview = useSceneStore((state) => state.setFaceTouchPreview);
  const setPreviewDof = useSceneStore((state) => state.setFaceTouchPreviewDof);
  const previewObjectTransform = useSceneStore((state) => state.previewObjectTransform);
  const clearPreviewObjectTransform = useSceneStore((state) => state.clearPreviewObjectTransform);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  const setActiveTool = useSceneStore((state) => state.setActiveTool);
  const objects = useSceneStore((state) => state.scene.objects);
  const { togglePanelVisible, focusPanel } = useWorkspace();

  // Local string drafts for the two number inputs so users can type "-" or
  // backspace mid-edit without our parsed-number rejection clobbering them.
  const [duDraft, setDuDraft] = useState("0");
  const [dvDraft, setDvDraft] = useState("0");

  // When a fresh preview lands, reset drafts and pop the panel open.
  useEffect(() => {
    if (preview) {
      setDuDraft(String(preview.du));
      setDvDraft(String(preview.dv));
      togglePanelVisible("touch-coincidence", true);
      focusPanel("touch-coincidence");
    } else {
      togglePanelVisible("touch-coincidence", false);
    }
  }, [preview?.op, preview?.drivenObjectId, togglePanelVisible, focusPanel]);

  // Push the previewed pose into the 3D viewer whenever du/dv change.
  useEffect(() => {
    if (!preview) return;
    const finalPos = computeFinalPos(preview);
    previewObjectTransform(preview.drivenObjectId, finalPos);
    return () => {
      // Cleanup: clear preview when the effect re-runs (du/dv change) so
      // we don't leak ghost poses across renders.
      // The "real" cleanup on commit/cancel happens explicitly below.
    };
  }, [preview, previewObjectTransform]);

  if (!preview) return null;

  const op = TOUCH_OP_BY_ID[preview.op];
  const dofCount = dofCountForOp(op.id);
  const drivenObj = objects.find((o) => o.id === preview.drivenObjectId);
  const refObj = objects.find((o) => o.id === preview.a.objectId);

  const onApply = async () => {
    const finalPos = computeFinalPos(preview);
    clearPreviewObjectTransform(preview.drivenObjectId);
    if (drivenObj) {
      await updateSceneObject(drivenObj.id, {
        ...finalPos,
        properties: {
          ...(drivenObj.properties ?? {}),
          placedRelativeTo: {
            kind: `${op.id}_touch`,
            recordedAt: new Date().toISOString(),
            refObjectId: preview.a.objectId,
          },
        },
      });
    }
    setPreview(null);
    setActiveTool("select");
  };

  const onCancel = () => {
    clearPreviewObjectTransform(preview.drivenObjectId);
    setPreview(null);
    // Stay in face-touch tool so user can pick again, just clear the preview.
  };

  const updateDu = (raw: string) => {
    setDuDraft(raw);
    const n = Number(raw);
    if (Number.isFinite(n)) setPreviewDof(n, preview.dv);
  };
  const updateDv = (raw: string) => {
    setDvDraft(raw);
    const n = Number(raw);
    if (Number.isFinite(n)) setPreviewDof(preview.du, n);
  };

  return (
    <FloatingPanel
      id="touch-coincidence"
      title="Touch coincidence"
      icon={<Move3D size={14} />}
      badge={op.label}
    >
      <div className="touch-coincidence-body">
        <div className="touch-coincidence-summary">
          <div>
            <strong>A:</strong> {op.firstKind} on{" "}
            <em>{refObj?.name ?? preview.a.objectId.slice(0, 8)}</em>
          </div>
          <div>
            <strong>B:</strong> {op.secondKind} on{" "}
            <em>{drivenObj?.name ?? preview.drivenObjectId.slice(0, 8)}</em>{" "}
            <small>(will move)</small>
          </div>
        </div>

        {dofCount === 0 && (
          <p className="touch-coincidence-hint">
            <code>{op.label}</code> locks all 3 axes — no slide DOFs to adjust.
            Click Apply to commit.
          </p>
        )}
        {dofCount === 1 && (
          <div className="touch-coincidence-dof">
            <label>
              <span>{dofLabelU(op.id)} (mm)</span>
              <input
                type="number"
                step={1}
                value={duDraft}
                onChange={(e) => updateDu(e.target.value)}
              />
            </label>
            <p className="touch-coincidence-hint">
              0 = anchor-to-anchor (default). Positive slides B along the
              shared direction.
            </p>
          </div>
        )}
        {dofCount === 2 && (
          <div className="touch-coincidence-dof">
            <label>
              <span>u — {dofLabelU(op.id)} (mm)</span>
              <input
                type="number"
                step={1}
                value={duDraft}
                onChange={(e) => updateDu(e.target.value)}
              />
            </label>
            <label>
              <span>v — {dofLabelV(op.id)} (mm)</span>
              <input
                type="number"
                step={1}
                value={dvDraft}
                onChange={(e) => updateDv(e.target.value)}
              />
            </label>
            <p className="touch-coincidence-hint">
              (u, v) = (0, 0) is anchor-to-anchor. The two axes span B's
              local plane around its anchor.
            </p>
          </div>
        )}

        <div className="touch-coincidence-buttons">
          <button type="button" className="secondary-button" onClick={onCancel}>
            <X size={14} /> Cancel
          </button>
          <button type="button" className="primary-button" onClick={() => void onApply()}>
            <Check size={14} /> Apply
          </button>
        </div>
      </div>
    </FloatingPanel>
  );
}

function dofCountForOp(id: string): 0 | 1 | 2 {
  if (id === "vv") return 0;
  if (id === "ve" || id === "ee") return 1;
  return 2; // vf, ef, ff
}

function dofLabelU(id: string): string {
  if (id === "ve" || id === "ee") return "along edge";
  if (id === "vf" || id === "ef") return "in face (u)";
  if (id === "ff") return "in plane (u)";
  return "u";
}
function dofLabelV(id: string): string {
  if (id === "vf" || id === "ef") return "in face (v)";
  if (id === "ff") return "in plane (v)";
  return "v";
}

/** B's final lab-mm position after applying baseOffset + DOF axis offsets. */
function computeFinalPos(preview: NonNullable<ReturnType<typeof useSceneStore.getState>["faceTouchPreview"]>): {
  xMm: number;
  yMm: number;
  zMm: number;
} {
  const orig = preview.drivenOriginalPos;
  const base = preview.baseOffset;
  let dx = base.dx;
  let dy = base.dy;
  let dz = base.dz;
  if (preview.uAxis) {
    dx += preview.uAxis.x * preview.du;
    dy += preview.uAxis.y * preview.du;
    dz += preview.uAxis.z * preview.du;
  }
  if (preview.vAxis) {
    dx += preview.vAxis.x * preview.dv;
    dy += preview.vAxis.y * preview.dv;
    dz += preview.vAxis.z * preview.dv;
  }
  return {
    xMm: orig.xMm + dx,
    yMm: orig.yMm + dy,
    zMm: orig.zMm + dz,
  };
}
