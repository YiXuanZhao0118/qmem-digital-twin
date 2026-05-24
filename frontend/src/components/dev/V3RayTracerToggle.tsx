/**
 * Floating dev-panel toggle for the v3 ray-tracer feature flag.
 *
 * Minimal UI: a fixed-position corner chip that reads/writes the
 * Zustand v3FeatureFlags store. Mount somewhere persistent
 * (`App.tsx` or layout root) during the v3 rollout.
 *
 * Phase 3d landed the flag; Phase 4d hooks a visible UI to it so
 * developers can flip v2/v3 without editing URL or storage manually.
 * Actual viewer-pipeline integration (replacing v2 tracer call sites)
 * is a separate effort.
 */

import * as React from "react";

import { useV3FeatureFlags } from "../../store/v3FeatureFlags";


type Props = {
  /** Optional className for layout overrides. */
  className?: string;
};

export function V3RayTracerToggle({ className }: Props): React.ReactElement {
  const useV3 = useV3FeatureFlags((s) => s.useV3RayTracer);
  const setUseV3 = useV3FeatureFlags((s) => s.setUseV3RayTracer);

  const onChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setUseV3(e.target.checked);
    },
    [setUseV3],
  );

  return (
    <div
      className={className}
      data-testid="v3-ray-tracer-toggle"
      style={{
        position: "fixed",
        bottom: 8,
        right: 8,
        background: useV3 ? "#1a3a52" : "#3a1a1a",
        border: `1px solid ${useV3 ? "#4ec9b0" : "#c97a4e"}`,
        color: "#fff",
        padding: "4px 10px",
        borderRadius: 4,
        fontFamily: "monospace",
        fontSize: 11,
        cursor: "pointer",
        userSelect: "none",
        display: "flex",
        gap: 6,
        alignItems: "center",
        zIndex: 9999,
      }}
    >
      <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={useV3}
          onChange={onChange}
          aria-label="Use v3 ray tracer"
        />
        <span>{useV3 ? "v3 tracer ON" : "v3 tracer OFF (v2)"}</span>
      </label>
    </div>
  );
}
