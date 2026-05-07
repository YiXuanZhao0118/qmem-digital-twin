// Shift+S cursor command popover.
//
// Opens at pointer position. Commands fall into two groups:
//   - "Selection → ..." moves the currently selected object(s) somewhere.
//   - "Cursor → ..." moves the 3D cursor somewhere.
//
// Sticks with Blender's Shift+S muscle memory.

import { useEffect, useRef, useState } from "react";

import { useSceneStore } from "../../store/sceneStore";
import { threeToLabPointMm } from "../../optical/frames";

export function CursorMenu() {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const closeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey && (e.key === "S" || e.key === "s")) {
        // Don't trigger when focus is in an input/textarea.
        const tag = (e.target as HTMLElement | null)?.tagName?.toUpperCase();
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        const pos = lastPointer ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        setAnchor(pos);
        setOpen(true);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    let lastPointer: { x: number; y: number } | null = null;
    const onMove = (e: PointerEvent) => {
      lastPointer = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest(".cursor-menu");
      if (!el) {
        setOpen(false);
      }
    };
    window.addEventListener("click", onClick);
    closeRef.current = () => setOpen(false);
    return () => window.removeEventListener("click", onClick);
  }, [open]);

  if (!open || !anchor) return null;

  const close = () => setOpen(false);

  // ─── Selection → ... commands ──────────────────────────────────────────
  const selectionToCursor = async () => {
    const state = useSceneStore.getState();
    const { transformCursorMm, scene, selectedObjectIds, selectedObjectId, updateSceneObject } = state;
    // Shift+S menu is a global UI (anchored to the user's mouse), so it
    // operates on the LEFT panel's cursor — the principal pivot in both
    // single- and dual-view modes.
    const cursor = transformCursorMm.left;
    const ids = selectedObjectIds.length > 0 ? selectedObjectIds : selectedObjectId ? [selectedObjectId] : [];
    for (const id of ids) {
      const obj = scene.objects.find((o) => o.id === id);
      if (!obj) continue;
      await updateSceneObject(id, {
        xMm: cursor.x,
        yMm: cursor.y,
        zMm: cursor.z,
      });
    }
    close();
  };

  const selectionToActive = async () => {
    const state = useSceneStore.getState();
    const { scene, selectedObjectIds, selectedObjectId, updateSceneObject } = state;
    if (!selectedObjectId) return;
    const active = scene.objects.find((o) => o.id === selectedObjectId);
    if (!active) return;
    for (const id of selectedObjectIds) {
      if (id === selectedObjectId) continue;
      await updateSceneObject(id, { xMm: active.xMm, yMm: active.yMm, zMm: active.zMm });
    }
    close();
  };

  // ─── Cursor → ... commands ─────────────────────────────────────────────
  const cursorToWorldOrigin = () => {
    useSceneStore.getState().setTransformCursorMm("left", { x: 0, y: 0, z: 0 });
    close();
  };

  const cursorToActive = () => {
    const state = useSceneStore.getState();
    const id = state.selectedObjectId;
    if (!id) return;
    const obj = state.scene.objects.find((o) => o.id === id);
    if (!obj) return;
    state.setTransformCursorMm("left", { x: obj.xMm, y: obj.yMm, z: obj.zMm });
    close();
  };

  const cursorToSelected = () => {
    const state = useSceneStore.getState();
    const ids = state.selectedObjectIds.length > 0 ? state.selectedObjectIds : state.selectedObjectId ? [state.selectedObjectId] : [];
    if (ids.length === 0) return;
    const objs = ids.map((id) => state.scene.objects.find((o) => o.id === id)).filter((x): x is NonNullable<typeof x> => Boolean(x));
    if (objs.length === 0) return;
    const median = {
      x: objs.reduce((s, o) => s + o.xMm, 0) / objs.length,
      y: objs.reduce((s, o) => s + o.yMm, 0) / objs.length,
      z: objs.reduce((s, o) => s + o.zMm, 0) / objs.length,
    };
    state.setTransformCursorMm("left", median);
    close();
  };

  /** Cursor → Beam point. Reads the last beam-scope probe (set when the user
   * clicks a beam segment in the viewer). */
  const cursorToBeamPoint = () => {
    const state = useSceneStore.getState();
    const probe = state.scopeProbe;
    if (!probe) {
      // No beam clicked yet — beep instead of silent no-op.
      window.alert("Click a beam first (then Shift+S → Cursor → Beam point).");
      return;
    }
    const lab = threeToLabPointMm(probe.pointThree);
    state.setTransformCursorMm("left", lab);
    close();
  };

  return (
    <div
      className="cursor-menu"
      style={{ left: anchor.x, top: anchor.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="cursor-menu-section">Selection →</div>
      <button onClick={() => void selectionToCursor()}>Cursor</button>
      <button onClick={() => void selectionToActive()}>Active</button>

      <div className="cursor-menu-section">Cursor →</div>
      <button onClick={cursorToWorldOrigin}>World origin</button>
      <button onClick={cursorToActive}>Active</button>
      <button onClick={cursorToSelected}>Selected (median)</button>
      <button onClick={cursorToBeamPoint}>Beam point</button>
    </div>
  );
}
