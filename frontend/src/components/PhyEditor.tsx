/**
 * PhyEditor — full-page sub-page wrapping the physics catalog editors.
 * Activated when `sceneStore.editorMode === "phy-editor"`.
 *
 * Layout: left rail + right pane. The rail's TOP LEVEL is the catalog
 * section (KIND / ASSET3D / COMPONENT) because that's the primary axis
 * of the data model. PHY domain (Optical / RF / Mechanical) is a
 * cross-cutting *filter* below it — a single part can belong to more
 * than one domain (an AOM is optical + RF), so domain can't be the tree
 * root without duplicating those parts. All editors mount in
 * binding-dev mode so the catalog is always CRUD-capable. Default
 * landing = Kinds, all domains.
 */

import { useEffect } from "react";

import { useSceneStore, type PhyEditorView } from "../store/sceneStore";
import { Asset3DEditor } from "./Asset3DEditor";
import { ComponentsEditor } from "./ComponentsEditor";
import { KindsEditor } from "./KindsEditor";

type Section = PhyEditorView["section"];
type DomainFilter = PhyEditorView["domain"];

const SECTIONS: { key: Section; label: string; hint: string }[] = [
  { key: "kinds", label: "KIND", hint: "contract registry" },
  { key: "asset3d", label: "ASSET3D", hint: "faces + transitions" },
  { key: "components", label: "COMPONENT", hint: "compose Asset3D into a part" },
];

const DOMAIN_FILTERS: { key: DomainFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "optical", label: "Optical" },
  { key: "rf", label: "RF" },
  { key: "mechanical", label: "Mechanical" },
];

const SECTION_LABEL: Record<Section, string> = {
  kinds: "KIND",
  asset3d: "ASSET3D",
  components: "COMPONENT",
};
const DOMAIN_LABEL: Record<DomainFilter, string> = {
  all: "All domains",
  optical: "Optical",
  rf: "RF",
  mechanical: "Mechanical",
};

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

  // null view = editor home; default the rail highlight + pane to the
  // Kinds catalog across all domains so the page is never blank.
  const activeSection: Section = phyEditorView?.section ?? "kinds";
  const activeDomain: DomainFilter = phyEditorView?.domain ?? "all";

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

  const switchView = (next: PhyEditorView) => {
    const changed =
      next.section !== activeSection || next.domain !== activeDomain;
    if (changed && !promptIfDirty("switch to a different view")) return;
    setPhyEditorView(next);
  };

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
              · {SECTION_LABEL[activeSection]} · {DOMAIN_LABEL[activeDomain]}
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
        // editor (KindsEditor / Asset3DEditor / ComponentsEditor)
        // is bounded by the viewport and owns its own scrollbar.
        style={{ gridTemplateRows: "minmax(0, 1fr)" }}
      >
        <aside className="phy-editor-rail">
          <div className="phy-editor-rail-header">Catalog</div>
          <div className="phy-editor-section-group">
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                type="button"
                className={
                  "phy-editor-rail-item" +
                  (activeSection === s.key ? " is-active" : "")
                }
                onClick={() =>
                  switchView({ section: s.key, domain: activeDomain })
                }
              >
                {s.label}
                <span className="phy-editor-rail-hint">{s.hint}</span>
              </button>
            ))}
          </div>

          <div className="phy-editor-rail-header">PHY domain</div>
          <div className="phy-editor-chips">
            {DOMAIN_FILTERS.map((d) => (
              <button
                key={d.key}
                type="button"
                className={
                  "phy-editor-chip" +
                  (activeDomain === d.key ? " is-active" : "")
                }
                onClick={() =>
                  switchView({ section: activeSection, domain: d.key })
                }
              >
                {d.label}
              </button>
            ))}
          </div>
        </aside>

        <div className="phy-editor-pane">
          {activeSection === "kinds" && <KindsEditor domain={activeDomain} />}
          {activeSection === "asset3d" && (
            <Asset3DEditor domain={activeDomain} mode="binding-dev" />
          )}
          {activeSection === "components" && (
            <ComponentsEditor domain={activeDomain} mode="binding-dev" />
          )}
        </div>
      </div>
    </div>
  );
}
