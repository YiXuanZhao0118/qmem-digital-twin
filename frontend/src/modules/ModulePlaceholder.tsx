/**
 * Coming-soon card for modules not yet implemented.
 *
 * Rendered by App.tsx when ``currentModule`` points at a module whose
 * registry entry has ``status === "coming_soon"``. The intent is to make
 * the tab navigable + discoverable in Phase A without committing to any
 * real UI for Electronics/EM yet.
 */
import type { ModuleDef } from "./_registry";

type Props = {
  module: ModuleDef;
};

export function ModulePlaceholder({ module }: Props) {
  return (
    <div className="module-placeholder">
      <div className="module-placeholder-card">
        <div className="module-placeholder-phase">{module.phaseLabel}</div>
        <h2 className="module-placeholder-title">{module.displayName}</h2>
        <p className="module-placeholder-desc">{module.description}</p>
        <p className="module-placeholder-status">
          Coming soon — this module is reserved in the data model but not
          yet implemented. See <code>docs/MULTIPHYSICS_PLAN.md</code> for
          the rollout schedule.
        </p>
      </div>
    </div>
  );
}
