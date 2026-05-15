// Object panel — read-only "spec sheet" view of a SceneObject.
//
// The Phase-3-aware twin of the existing PhysicsElementPanel (which edits
// state knobs): IntrinsicSpecPanel surfaces every kindParam the plugin
// tagged `intrinsicParamKeys` — wavelength, AOM acoustic velocity, ZHL-1-2W
// gain, AD9959 channel count, … — alongside a port-domain summary so the
// user can see, at a glance, which Link graph each anchor participates in
// (Optical / RF / Trigger / TTL / DC).
//
// Why read-only: intrinsics describe the hardware itself. Changing them
// would mean "I'm pretending this is a different part" — a calibration
// override belongs on the SceneObject instance, not the catalog. Phase 4
// surfaces an explicit "Calibration override" affordance backed by
// `intrinsic_overrides` columns; until then this panel is purely a
// reference card.
//
// Plugins that haven't opted into the Phase-2 partition (`intrinsicParamKeys`
// + `stateParamKeys`) cause the panel to hide its content sections —
// nothing to show, no surprises. The exhaustiveness test in
// `plugin_partition.test.ts` ensures every migrated kind partitions cleanly.

import { Cpu, Info, PlugZap } from "lucide-react";
import { useMemo } from "react";

import type { ComponentItem, PhysicsElement, SceneObject } from "../types/digitalTwin";
import { useSceneStore } from "../store/sceneStore";
import {
  isPhysicsPlugin,
  partitionKindParamKeys,
  resolvePortDomain,
  type PortDomain,
} from "../kinds/_plugin";
import { pluginForComponentType } from "../kinds/_plugins";
import { CollapsibleSection } from "./CollapsibleSection";

const DOMAIN_COLORS: Record<PortDomain, { bg: string; fg: string; label: string }> = {
  optical: { bg: "#2a3b2e", fg: "#7be08a", label: "optical" },
  rf:      { bg: "#2a323b", fg: "#62a3ff", label: "rf" },
  trigger: { bg: "#3b2a2e", fg: "#d49a3a", label: "trigger" },
  ttl:     { bg: "#3b2a2e", fg: "#d49a3a", label: "ttl" },
  dc:      { bg: "#2e2a3b", fg: "#a062ff", label: "dc" },
};

/** Pretty-print a kindParam value for the read-only spec view.
 *
 *  - Numbers: keep up to 4 significant digits; scientific notation for
 *    very small / very large magnitudes (e.g. 34e-15 for the AOM M²).
 *  - Array of numbers: comma-separated, fixed precision.
 *  - Strings / booleans: as-is.
 *  - null / undefined: "—". */
function formatValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return String(v);
    if (v === 0) return "0";
    const abs = Math.abs(v);
    if (abs < 1e-3 || abs >= 1e5) return v.toExponential(3);
    return Number(v.toPrecision(4)).toString();
  }
  if (Array.isArray(v)) {
    return v.map((x) => formatValue(x)).join(", ");
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

type Props = {
  component: ComponentItem | undefined;
  sceneObject: SceneObject;
};

export function IntrinsicSpecPanel({ component, sceneObject }: Props) {
  const physicsElements = useSceneStore((s) => s.scene.physicsElements);
  const assets = useSceneStore((s) => s.scene.assets);
  const components = useSceneStore((s) => s.scene.components);

  // Resolve plugin via componentType. PassivePlugins (mirror_mount, posts,
  // …) don't have a physics block and therefore no intrinsic params —
  // we hide the panel entirely for those.
  const plugin = component ? pluginForComponentType(component.componentType) : null;
  const physicsPlugin = plugin && isPhysicsPlugin(plugin) ? plugin : null;

  const physicsElement: PhysicsElement | undefined = useMemo(
    () => physicsElements.find((e) => e.objectId === sceneObject.id),
    [physicsElements, sceneObject.id],
  );

  const anchors = useMemo(() => {
    const comp = components.find((c) => c.id === sceneObject.componentId);
    const asset = comp?.asset3dId ? assets.find((a) => a.id === comp.asset3dId) : undefined;
    return asset?.anchors ?? [];
  }, [components, assets, sceneObject.componentId]);

  if (!physicsPlugin) return null;

  const partition = partitionKindParamKeys(physicsPlugin);
  const kindParams = (physicsElement?.kindParams ?? physicsPlugin.physics.defaultParams) as Record<string, unknown>;

  // Don't show the panel at all when the plugin hasn't been migrated yet
  // (no intrinsic keys declared). Phase 4 will flip this to an empty-state
  // hint, but during the migration window silence is the right default.
  const hasIntrinsic = partition.intrinsic.length > 0;
  const hasPortDomains = anchors.length > 0;
  if (!hasIntrinsic && !hasPortDomains) return null;

  return (
    <CollapsibleSection
      id={`intrinsic-spec-${physicsPlugin.id}`}
      title="Object spec (intrinsic)"
      icon={<Info size={13} />}
      defaultOpen={false}
      badge={hasIntrinsic ? `${partition.intrinsic.length} fields` : undefined}
    >
      <div style={{ padding: "6px 8px", display: "flex", flexDirection: "column", gap: 10 }}>
        {hasIntrinsic && (
          <div>
            <div style={{ fontSize: 10, color: "#8e8e9a", marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
              <Cpu size={11} /> Spec sheet — read-only
            </div>
            <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
              <tbody>
                {partition.intrinsic.map((key) => (
                  <tr key={key}>
                    <td style={{
                      padding: "2px 4px",
                      color: "#cfcfd8",
                      whiteSpace: "nowrap",
                      borderBottom: "1px solid #2a2a30",
                    }}>{key}</td>
                    <td style={{
                      padding: "2px 4px",
                      color: "#e8e8ee",
                      fontFamily: "var(--mono-font, ui-monospace, monospace)",
                      textAlign: "right",
                      borderBottom: "1px solid #2a2a30",
                    }}>{formatValue(kindParams[key])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {hasPortDomains && (
          <div>
            <div style={{ fontSize: 10, color: "#8e8e9a", marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
              <PlugZap size={11} /> Ports by domain
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {anchors.map((a) => {
                const dom = resolvePortDomain(physicsPlugin, a.id);
                const meta = dom ? DOMAIN_COLORS[dom] : null;
                return (
                  <div
                    key={`${a.id}/${a.name ?? ""}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 6,
                      fontSize: 11,
                      padding: "2px 4px",
                      borderBottom: "1px solid #2a2a30",
                    }}
                  >
                    <span style={{ color: "#cfcfd8" }}>
                      {a.name ?? a.id}{" "}
                      <span style={{ color: "#6e6e7a" }}>· {a.id}</span>
                    </span>
                    {meta ? (
                      <span
                        style={{
                          fontSize: 9,
                          padding: "1px 6px",
                          borderRadius: 3,
                          background: meta.bg,
                          color: meta.fg,
                        }}
                      >
                        {meta.label}
                      </span>
                    ) : (
                      <span style={{ fontSize: 9, color: "#6e6e7a" }}>—</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
