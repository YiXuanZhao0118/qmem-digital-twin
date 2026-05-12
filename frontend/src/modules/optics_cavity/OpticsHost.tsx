/**
 * Optics tab host — splits the "Optics" top-bar tab into sub-tools:
 *
 *   - Cavity:  Fabry-Perot / ring resonator calculator (Phase Optics-Cavity)
 *   - Crystal: nonlinear-crystal phase matching + SHG + SPDC tuning
 *              (Phase Optics-Crystal)
 *
 * Future sub-tools (SPDC source designer, FDTD, …) land as additional
 * entries in OPTICS_TABS.
 */
import { useState } from "react";

import { CrystalWorkspace } from "./CrystalWorkspace";
import { OpticsCavityWorkspace } from "./OpticsCavityWorkspace";

type OpticsTab = "cavity" | "crystal";

const OPTICS_TABS: { id: OpticsTab; label: string; hint: string }[] = [
  { id: "cavity", label: "Cavity", hint: "Linear / ring Fabry-Perot resonator" },
  {
    id: "crystal",
    label: "Crystal",
    hint: "Nonlinear-crystal phase matching, SHG, SPDC tuning",
  },
];

export function OpticsHost() {
  const [tab, setTab] = useState<OpticsTab>("cavity");

  return (
    <div className="optics-host">
      <nav className="optics-sub-tabs" role="tablist">
        {OPTICS_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`optics-sub-tab${tab === t.id ? " active" : ""}`}
            onClick={() => setTab(t.id)}
            title={t.hint}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="optics-sub-body">
        {tab === "cavity" && <OpticsCavityWorkspace />}
        {tab === "crystal" && <CrystalWorkspace />}
      </div>
    </div>
  );
}
