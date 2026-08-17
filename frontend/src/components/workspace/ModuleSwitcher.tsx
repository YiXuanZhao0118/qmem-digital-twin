/**
 * Top-bar tab strip for the multiphysics module switcher.
 *
 * Drives ``sceneStore.currentModule``; App.tsx watches that field and
 * flips ``.workspace-canvas`` between the live Optics workspace and the
 * coming-soon placeholders for Electronics / EM.
 *
 * The active tab doubles as a menu: it drops down the Scene actions that
 * used to sit in SceneToolbar's "Scene" group (Initial Setup, PHY Editor).
 * Initial Setup flips ``sceneStore.initialSetupOpen`` — the popover itself
 * still renders inside SceneToolbar. "Add text annotation" moved back to
 * SceneToolbar's View group, left of the Display-overlays eye.
 *
 * Phase A. See docs/MULTIPHYSICS_PLAN.md §1.
 */
import { ChevronDown, PenTool, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { MODULES, type ModuleDef } from "../../modules/_registry";
import { useSceneStore } from "../../store/sceneStore";

export function ModuleSwitcher() {
  const currentModule = useSceneStore((state) => state.currentModule);
  const setCurrentModule = useSceneStore((state) => state.setCurrentModule);
  const initialSetupOpen = useSceneStore((state) => state.initialSetupOpen);
  const setInitialSetupOpen = useSceneStore((state) => state.setInitialSetupOpen);
  const openPhyEditor = useSceneStore((state) => state.openPhyEditor);

  const [menuModuleId, setMenuModuleId] = useState<string | null>(null);
  const switcherRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuModuleId) return;
    const onDocDown = (event: MouseEvent) => {
      if (!switcherRef.current?.contains(event.target as Node)) {
        setMenuModuleId(null);
      }
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [menuModuleId]);

  return (
    <div
      className="module-switcher"
      role="tablist"
      aria-label="Simulation module"
      ref={switcherRef}
    >
      {MODULES.map((module) => {
        const active = currentModule === module.id;
        // Only the live Lab tab carries the Scene menu — placeholder tabs
        // have no scene to act on.
        const hasMenu = module.status === "available";
        return (
          <div className="module-tab-anchor" key={module.id}>
            <ModuleTab
              module={module}
              active={active}
              hasMenu={hasMenu}
              menuOpen={menuModuleId === module.id}
              onClick={() => {
                if (!active) setCurrentModule(module.id);
                if (hasMenu) {
                  setMenuModuleId((open) => (open === module.id ? null : module.id));
                }
              }}
            />
            {hasMenu && menuModuleId === module.id && (
              <div className="window-menu module-tab-menu" role="menu">
                <div className="window-menu-section">Scene</div>
                <button
                  type="button"
                  className={`window-menu-item${initialSetupOpen ? " active" : ""}`}
                  role="menuitemcheckbox"
                  aria-checked={initialSetupOpen}
                  onClick={() => {
                    setInitialSetupOpen(!initialSetupOpen);
                    setMenuModuleId(null);
                  }}
                >
                  <span className="window-menu-check">
                    <Settings2 size={13} />
                  </span>
                  <span>Initial Setup</span>
                </button>
                <button
                  type="button"
                  className="window-menu-item"
                  role="menuitem"
                  title="Open the PHY editor (optical kinds, optical components, ...)"
                  onClick={() => {
                    openPhyEditor();
                    setMenuModuleId(null);
                  }}
                >
                  <span className="window-menu-check">
                    <PenTool size={13} />
                  </span>
                  <span>PHY Editor</span>
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

type TabProps = {
  module: ModuleDef;
  active: boolean;
  hasMenu: boolean;
  menuOpen: boolean;
  onClick: () => void;
};

function ModuleTab({ module, active, hasMenu, menuOpen, onClick }: TabProps) {
  const comingSoon = module.status === "coming_soon";
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-haspopup={hasMenu ? "menu" : undefined}
      aria-expanded={hasMenu ? menuOpen : undefined}
      className={`module-tab${active ? " active" : ""}${comingSoon ? " coming-soon" : ""}`}
      title={
        comingSoon
          ? `${module.displayName} — ${module.phaseLabel}, coming soon`
          : module.displayName
      }
      onClick={onClick}
    >
      <span className="module-tab-name">{module.displayName}</span>
      {comingSoon && <span className="module-tab-badge">{module.phaseLabel}</span>}
      {hasMenu && <ChevronDown size={13} className="module-tab-caret" />}
    </button>
  );
}
