/**
 * Top-bar tab strip for the multiphysics module switcher.
 *
 * Drives ``sceneStore.currentModule``; App.tsx watches that field and
 * flips ``.workspace-canvas`` between the live Optics workspace and the
 * coming-soon placeholders for Electronics / EM.
 *
 * Phase A. See docs/MULTIPHYSICS_PLAN.md §1.
 */
import { MODULES, type ModuleDef } from "../../modules/_registry";
import { useSceneStore } from "../../store/sceneStore";

export function ModuleSwitcher() {
  const currentModule = useSceneStore((state) => state.currentModule);
  const setCurrentModule = useSceneStore((state) => state.setCurrentModule);

  return (
    <div className="module-switcher" role="tablist" aria-label="Simulation module">
      {MODULES.map((module) => (
        <ModuleTab
          key={module.id}
          module={module}
          active={currentModule === module.id}
          onClick={() => setCurrentModule(module.id)}
        />
      ))}
    </div>
  );
}

type TabProps = {
  module: ModuleDef;
  active: boolean;
  onClick: () => void;
};

function ModuleTab({ module, active, onClick }: TabProps) {
  const comingSoon = module.status === "coming_soon";
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
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
    </button>
  );
}
