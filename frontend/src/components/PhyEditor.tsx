/**
 * PhyEditor — full-page sub-page wrapping per-domain physics editors.
 * Activated when `sceneStore.editorMode === "phy-editor"`.
 *
 * Layout: left rail (PHY domains) + right pane (selected sub-editor).
 * All editors mount in binding-dev mode so the catalog (Kinds /
 * Asset3D / Components) is always CRUD-capable. Default landing =
 * optical kinds catalog.
 */

import { useEffect } from "react";

import { useSceneStore } from "../store/sceneStore";
import { Asset3DV3Editor } from "./Asset3DV3Editor";
import { ComponentsV2Editor } from "./ComponentsV2Editor";
import { KindsEditor } from "./KindsEditor";

export function PhyEditor() {
  const phyEditorView = useSceneStore((s) => s.phyEditorView);
  const setPhyEditorView = useSceneStore((s) => s.setPhyEditorView);
  const closePhyEditor = useSceneStore((s) => s.closePhyEditor);
  const phyEditorDirty = useSceneStore((s) => s.phyEditorDirty);
  const sceneComponents = useSceneStore((s) => s.scene.components);
  const sceneBindings = useSceneStore((s) => s.scene.componentBindings);
  const loadScene = useSceneStore((s) => s.loadScene);

  // One-shot fetch: if the user navigates straight into PHY Editor before
  // App.tsx's cold-start loadScene finishes (or the store was reset),
  // re-trigger loadScene so the editors have the component binding tree
  // they need. No-op once data arrives.
  useEffect(() => {
    if (sceneComponents.length === 0 || (sceneBindings ?? []).length === 0) {
      void loadScene();
    }
  }, [loadScene, sceneComponents.length, sceneBindings]);

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
      | { domain: "optical" | "rf" | "mechanical"; section: "kinds" | "components" | "composer" }
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
  const opticalComposer =
    opticalActive && phyEditorView?.section === "composer";
  const rfActive = phyEditorView?.domain === "rf";
  const rfKinds = rfActive && phyEditorView?.section === "kinds";
  const rfComponents = rfActive && phyEditorView?.section === "components";
  const rfComposer = rfActive && phyEditorView?.section === "composer";
  const mechanicalActive = phyEditorView?.domain === "mechanical";
  const mechanicalKinds = mechanicalActive && phyEditorView?.section === "kinds";
  const mechanicalAsset3D =
    mechanicalActive && phyEditorView?.section === "components";
  const mechanicalComposer =
    mechanicalActive && phyEditorView?.section === "composer";

  // Default landing (no rail item selected) shows the optical kinds
  // catalog — same content as clicking the rail's Kinds entry, so the
  // user sees what kinds exist without having to click anything first.
  const showDefaultLanding = phyEditorView === null;

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
              · {phyEditorView.domain} → {
                // Internal section names ("components" routes the Asset3D
                // editor; "composer" routes the Components composer) are
                // historical and confuse anyone reading the breadcrumb.
                // Surface user-facing labels that match the rail.
                phyEditorView.section === "components"
                  ? "asset3d"
                  : phyEditorView.section === "composer"
                    ? "components"
                    : phyEditorView.section
              }
            </span>
          )}
        </div>
        {phyEditorDirty && (
          <span style={{ color: "#fbbf24" }}>● Unsaved</span>
        )}
      </div>

      <div
        className="phy-editor-body"
        // Grid auto-tracks default to `minmax(auto, ...)` which forces the
        // track to grow to fit content — that breaks the inner editors'
        // `flex: 1; overflow: auto` because the cell expands instead of
        // capping the editor's height. Force `minmax(0, 1fr)` so the
        // editor (KindsEditor / Asset3DV3Editor / ComponentsV2Editor)
        // is bounded by the viewport and owns its own scrollbar.
        style={{ gridTemplateRows: "minmax(0, 1fr)" }}
      >
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
              ASSET3D
              <span className="phy-editor-rail-hint">faces + transitions</span>
            </button>
            <button
              type="button"
              className={
                "phy-editor-rail-item" +
                (opticalComposer ? " is-active" : "")
              }
              onClick={() =>
                switchView({ domain: "optical", section: "composer" })
              }
            >
              COMPONENTS
              <span className="phy-editor-rail-hint">compose optical Asset3D</span>
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
              ASSET3D
              <span className="phy-editor-rail-hint">faces + transitions</span>
            </button>
            <button
              type="button"
              className={
                "phy-editor-rail-item" +
                (rfComposer ? " is-active" : "")
              }
              onClick={() =>
                switchView({ domain: "rf", section: "composer" })
              }
            >
              COMPONENTS
              <span className="phy-editor-rail-hint">compose RF Asset3D</span>
            </button>
          </div>

          <div className="phy-editor-domain phy-editor-domain-disabled">
            <div className="phy-editor-domain-title">▷ Electrical</div>
            <div className="phy-editor-rail-soon">coming later</div>
          </div>

          <div className="phy-editor-domain">
            <div className="phy-editor-domain-title">▼ Mechanical</div>
            <button
              type="button"
              className={
                "phy-editor-rail-item" +
                (mechanicalKinds ? " is-active" : "")
              }
              onClick={() =>
                switchView({ domain: "mechanical", section: "kinds" })
              }
            >
              mechanical_kinds
              <span className="phy-editor-rail-hint">contract registry</span>
            </button>
            <button
              type="button"
              className={
                "phy-editor-rail-item" +
                (mechanicalAsset3D ? " is-active" : "")
              }
              onClick={() =>
                switchView({ domain: "mechanical", section: "components" })
              }
            >
              ASSET3D
              <span className="phy-editor-rail-hint">faces + transitions</span>
            </button>
            <button
              type="button"
              className={
                "phy-editor-rail-item" +
                (mechanicalComposer ? " is-active" : "")
              }
              onClick={() =>
                switchView({ domain: "mechanical", section: "composer" })
              }
            >
              COMPONENTS
              <span className="phy-editor-rail-hint">compose Asset3D into a component</span>
            </button>
          </div>
        </aside>

        <div className="phy-editor-pane">
          {showDefaultLanding && <KindsEditor domain="optical" />}
          {opticalKinds && <KindsEditor domain="optical" />}
          {opticalComponents && <Asset3DV3Editor domain="optical" mode="binding-dev" />}
          {opticalComposer && <ComponentsV2Editor domain="optical" mode="binding-dev" />}
          {rfKinds && <KindsEditor domain="rf" />}
          {rfComponents && <Asset3DV3Editor domain="rf" mode="binding-dev" />}
          {rfComposer && <ComponentsV2Editor domain="rf" mode="binding-dev" />}
          {mechanicalKinds && <KindsEditor domain="mechanical" />}
          {mechanicalAsset3D && <Asset3DV3Editor domain="mechanical" mode="binding-dev" />}
          {mechanicalComposer && <ComponentsV2Editor domain="mechanical" mode="binding-dev" />}
        </div>
      </div>
    </div>
  );
}
