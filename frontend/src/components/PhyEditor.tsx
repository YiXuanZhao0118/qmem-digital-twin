/**
 * PhyEditor — full-page sub-page wrapping the per-domain physics
 * editors. Activated when `sceneStore.editorMode === "phy-editor"`.
 *
 * Layout:
 *   ┌──── Top bar ──────────────────────────────────────────────────┐
 *   │ ← Back to scene             PHY Editor                        │
 *   ├──────────────┬────────────────────────────────────────────────┤
 *   │ ▼ Optical    │                                                │
 *   │   • Kinds    │   <selected sub-editor's content>              │
 *   │   • Components                                                │
 *   │              │                                                │
 *   │ ▷ Electrical │                                                │
 *   │   (soon)     │                                                │
 *   │              │                                                │
 *   │ ▷ Mechanical │                                                │
 *   │   (soon)     │                                                │
 *   └──────────────┴────────────────────────────────────────────────┘
 *
 * Navigation:
 *   - Left rail: hierarchical PHY-domain tree. Clicking "Kinds" or
 *     "Components" under "Optical" switches the right pane.
 *   - Top bar: a single "Back to scene" returns to the main viewport.
 *     If the active sub-editor has unsaved drafts (sceneStore.phyEditorDirty),
 *     a confirm prompt appears first. Same prompt fires on switching tabs.
 *
 * The sub-editors themselves (`KindsEditor`,
 * `ComponentEditor`) own their own Save buttons and dirty state;
 * this wrapper just routes to them.
 */

import { useSceneStore } from "../store/sceneStore";
import { ComponentEditor } from "./ComponentEditor";
import { IsolatorDevPage } from "../kinds/isolator/IsolatorDevPage";
import { KindsEditor } from "./KindsEditor";

export function PhyEditor() {
  const phyEditorView = useSceneStore((s) => s.phyEditorView);
  const setPhyEditorView = useSceneStore((s) => s.setPhyEditorView);
  const closePhyEditor = useSceneStore((s) => s.closePhyEditor);
  const phyEditorDirty = useSceneStore((s) => s.phyEditorDirty);

  const promptIfDirty = (action: string): boolean => {
    if (!phyEditorDirty) return true;
    return window.confirm(
      `You have unsaved changes in the active editor. Discard them and ${action}?`,
    );
  };

  const handleBack = () => {
    if (!promptIfDirty("return to the scene")) return;
    closePhyEditor();
  };

  const switchView = (
    view:
      | { domain: "optical" | "rf"; section: "kinds" | "components" }
      | null,
  ) => {
    if (
      phyEditorView &&
      (!view ||
        view.domain !== phyEditorView.domain ||
        view.section !== phyEditorView.section) &&
      !promptIfDirty("switch to a different editor")
    ) {
      return;
    }
    setPhyEditorView(view);
  };

  const opticalActive = phyEditorView?.domain === "optical";
  const opticalKinds = opticalActive && phyEditorView?.section === "kinds";
  const opticalComponents =
    opticalActive && phyEditorView?.section === "components";
  const rfActive = phyEditorView?.domain === "rf";
  const rfKinds = rfActive && phyEditorView?.section === "kinds";
  const rfComponents = rfActive && phyEditorView?.section === "components";

  return (
    <div className="phy-editor">
      <div className="phy-editor-topbar">
        <button
          type="button"
          className="secondary-button"
          onClick={handleBack}
        >
          ← Back to scene
        </button>
        <div className="phy-editor-title">
          <strong>PHY Editor</strong>
          {phyEditorView && (
            <span style={{ opacity: 0.7, marginLeft: 8 }}>
              · {phyEditorView.domain} → {phyEditorView.section}
            </span>
          )}
        </div>
        {phyEditorDirty && (
          <span style={{ color: "#fbbf24" }}>● Unsaved</span>
        )}
      </div>

      <div className="phy-editor-body">
        {/* LEFT: PHY domain tree */}
        <aside className="phy-editor-rail">
          <div className="phy-editor-rail-header">PHY domains</div>

          <div className="phy-editor-domain">
            <div className="phy-editor-domain-title">▼ Optical</div>
            <button
              type="button"
              className={
                "phy-editor-rail-item" +
                (opticalKinds ? " is-active" : "")
              }
              onClick={() =>
                switchView({ domain: "optical", section: "kinds" })
              }
            >
              optical_kinds
              <span className="phy-editor-rail-hint">contract registry</span>
            </button>
            <button
              type="button"
              className={
                "phy-editor-rail-item" +
                (opticalComponents ? " is-active" : "")
              }
              onClick={() =>
                switchView({ domain: "optical", section: "components" })
              }
            >
              optical_component
              <span className="phy-editor-rail-hint">anchor geometry</span>
            </button>
          </div>

          <div className="phy-editor-domain">
            <div className="phy-editor-domain-title">▼ RF</div>
            <button
              type="button"
              className={
                "phy-editor-rail-item" +
                (rfKinds ? " is-active" : "")
              }
              onClick={() =>
                switchView({ domain: "rf", section: "kinds" })
              }
            >
              rf_kinds
              <span className="phy-editor-rail-hint">contract registry</span>
            </button>
            <button
              type="button"
              className={
                "phy-editor-rail-item" +
                (rfComponents ? " is-active" : "")
              }
              onClick={() =>
                switchView({ domain: "rf", section: "components" })
              }
            >
              rf_component
              <span className="phy-editor-rail-hint">rf_in / rf_out anchors</span>
            </button>
          </div>

          <div className="phy-editor-domain phy-editor-domain-disabled">
            <div className="phy-editor-domain-title">▷ Electrical</div>
            <div className="phy-editor-rail-soon">coming later</div>
          </div>

          <div className="phy-editor-domain phy-editor-domain-disabled">
            <div className="phy-editor-domain-title">▷ Mechanical</div>
            <div className="phy-editor-rail-soon">coming later</div>
          </div>
        </aside>

        {/* RIGHT: selected sub-editor. Default landing (no rail selection)
            is the IsolatorDevPage — the live PBS tweak tool that used to
            sit as a rail item itself. Clicking any rail button below
            switches away from it; closing & re-entering PHY Editor
            returns to it. */}
        <div className="phy-editor-pane">
          {!phyEditorView && <IsolatorDevPage />}
          {opticalKinds && <KindsEditor domain="optical" />}
          {opticalComponents && <ComponentEditor domain="optical" />}
          {rfKinds && <KindsEditor domain="rf" />}
          {rfComponents && <ComponentEditor domain="rf" />}
        </div>
      </div>
    </div>
  );
}
