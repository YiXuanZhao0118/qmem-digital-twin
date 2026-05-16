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

// Domain chip palette — matches the light theme used by the floating
// panels (cream/teal). `bg` is a soft tint, `fg` is the readable solid;
// kept saturated enough to scan a port list at a glance without
// fighting the accent green elsewhere on the page.
const DOMAIN_COLORS: Record<PortDomain, { bg: string; fg: string; label: string }> = {
  optical: { bg: "rgba(15, 118, 110, 0.10)", fg: "#0f766e",   label: "optical" },
  rf:      { bg: "rgba(37, 99, 235, 0.10)",  fg: "#1d4ed8",   label: "rf" },
  trigger: { bg: "rgba(180, 83, 9, 0.12)",   fg: "#9a4a07",   label: "trigger" },
  ttl:     { bg: "rgba(180, 83, 9, 0.12)",   fg: "#9a4a07",   label: "ttl" },
  dc:      { bg: "rgba(124, 58, 237, 0.10)", fg: "#6d28d9",   label: "dc" },
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
      title="Spec"
      icon={<Info size={13} />}
      defaultOpen
      badge={hasIntrinsic ? `${partition.intrinsic.length} fields` : undefined}
    >
      <div className="intrinsic-spec">
        {hasIntrinsic && (
          <div className="intrinsic-spec-block">
            <div className="intrinsic-spec-subhead">
              <Cpu size={11} /> Spec sheet — read-only
            </div>
            <table className="intrinsic-spec-table">
              <tbody>
                {partition.intrinsic.map((key) => (
                  <tr key={key}>
                    <td className="intrinsic-spec-key">{key}</td>
                    <td className="intrinsic-spec-val">{formatValue(kindParams[key])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {hasPortDomains && (
          <div className="intrinsic-spec-block">
            <div className="intrinsic-spec-subhead">
              <PlugZap size={11} /> Ports by domain
            </div>
            <div className="intrinsic-spec-ports">
              {anchors.map((a) => {
                const dom = resolvePortDomain(physicsPlugin, a.id);
                const meta = dom ? DOMAIN_COLORS[dom] : null;
                return (
                  <div key={`${a.id}/${a.name ?? ""}`} className="intrinsic-spec-port">
                    <span className="intrinsic-spec-port-name">
                      {a.name ?? a.id}{" "}
                      <span className="intrinsic-spec-port-id">· {a.id}</span>
                    </span>
                    {meta ? (
                      <span
                        className="intrinsic-spec-port-chip"
                        style={{ background: meta.bg, color: meta.fg }}
                      >
                        {meta.label}
                      </span>
                    ) : (
                      <span className="intrinsic-spec-port-chip intrinsic-spec-port-chip-empty">—</span>
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
