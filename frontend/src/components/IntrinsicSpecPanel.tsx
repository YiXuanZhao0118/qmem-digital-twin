// Object panel — read-only "spec sheet" view of a SceneObject.
//
// SOURCE OF TRUTH = the ASSETS the object's component binds (2026-08-17).
// Physical parameters live on `Asset3D.default_params` + `wavelength_range_nm`
// — that is what the tracer reads (see docs/introduce/asset.md and the
// param-ownership note in kinds.md) — so the spec sheet reads them straight
// off the bound assets, one block per asset. A composite optic therefore
// shows its real internals: the IO-3-850-HP isolator lists its two
// Glan-Laser prisms and its Faraday rod rather than nothing at all.
//
// It used to read `PhysicsElement.kindParams` filtered by the FRONTEND
// plugin's `intrinsicParamKeys`, keyed off the COMPONENT kind. That hid the
// spec for 10 of the 12 optics in a real scene: only 4 plugins ever declared
// `intrinsicParamKeys`, so `partitionKindParamKeys(...).intrinsic` was empty
// for lenses, mirrors, PBSs, fibers and every composite — and the rows that
// did render were half "—", because keys like `wavelengthRangeNm` are asset
// COLUMNS that never appear in kindParams at all.
//
// Per-instance tunables (`Asset3D.tunable_params`, edited below the sheet via
// dynamicSources) are excluded: the sheet is the fixed hardware, the editor
// underneath owns whatever this instance overrides.
//
// Why read-only: intrinsics describe the hardware itself. Changing them
// would mean "I'm pretending this is a different part" — edit the asset in
// the PHY Editor instead (and note most optical assets are `locked`).
//
// The "Ports by domain" block still resolves through the legacy
// `component.asset3dId`, so it only appears for pre-binding components.

import { Cpu, Info, PlugZap } from "lucide-react";
import { useMemo } from "react";

import type { ComponentItem, SceneObject } from "../types/digitalTwin";
import { useSceneStore } from "../store/sceneStore";
import {
  isPhysicsPlugin,
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
  // Nested objects (a laser's `spectrum`, say) are a whole record, not a
  // field — dumping the JSON into a two-column table stretches the drawer.
  // Show the head of it and hand the rest to the cell's tooltip.
  const json = JSON.stringify(v);
  return json.length > 64 ? `${json.slice(0, 63)}…` : json;
}

type Props = {
  component: ComponentItem | undefined;
  sceneObject: SceneObject;
};

export function IntrinsicSpecPanel({ component, sceneObject }: Props) {
  const assets = useSceneStore((s) => s.scene.assets);
  const components = useSceneStore((s) => s.scene.components);
  const componentBindings = useSceneStore((s) => s.scene.componentBindings);
  const objectBindings = useSceneStore((s) => s.scene.objectBindings);

  // One spec block per bound asset, in binding order. Assets that carry no
  // physics at all (housings, mount pieces — e.g. the isolator's front/back
  // shells) are skipped: an empty table reads as "no spec" when the truth is
  // "this piece is geometry".
  const specBlocks = useMemo(() => {
    const overrideByBinding = new Map(
      (objectBindings ?? [])
        .filter((b) => b.objectId === sceneObject.id)
        .map((b) => [b.componentBindingId, b.asset3dIdOverride] as const),
    );
    return (componentBindings ?? [])
      .filter((b) => b.componentId === sceneObject.componentId && b.targetKind === "asset")
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .flatMap((binding) => {
        // Honour a per-instance asset swap, exactly as the loader does.
        const assetId = overrideByBinding.get(binding.id) ?? binding.asset3dId;
        const asset = assetId ? assets.find((a) => a.id === assetId) : undefined;
        if (!asset) return [];
        const tunable = new Set(asset.tunableParams ?? []);
        const params = Object.entries(asset.defaultParams ?? {}).filter(([k]) => !tunable.has(k));
        const range = asset.wavelengthRangeNm ?? null;
        if (params.length === 0 && range == null) return [];
        return [{
          key: binding.id,
          role: binding.role,
          assetName: asset.name,
          kindId: asset.kindId ?? null,
          params,
          range,
        }];
      });
  }, [componentBindings, objectBindings, assets, sceneObject.componentId, sceneObject.id]);

  // Ports-by-domain is still plugin + legacy-`asset3dId` driven, so it only
  // shows for components that predate the binding tree.
  const plugin = component && component.kindId != null ? pluginForComponentType(component.kindId) : null;
  const physicsPlugin = plugin && isPhysicsPlugin(plugin) ? plugin : null;
  const anchors = useMemo(() => {
    const comp = components.find((c) => c.id === sceneObject.componentId);
    const asset = comp?.asset3dId ? assets.find((a) => a.id === comp.asset3dId) : undefined;
    return asset?.anchors ?? [];
  }, [components, assets, sceneObject.componentId]);

  const fieldCount = specBlocks.reduce(
    (n, b) => n + b.params.length + (b.range ? 1 : 0),
    0,
  );
  const hasSpec = specBlocks.length > 0;
  const hasPortDomains = physicsPlugin != null && anchors.length > 0;
  if (!hasSpec && !hasPortDomains) return null;

  return (
    <CollapsibleSection
      id={`intrinsic-spec-${component?.kindId ?? "object"}`}
      title="Spec"
      icon={<Info size={13} />}
      defaultOpen
      badge={hasSpec ? `${fieldCount} fields` : undefined}
    >
      <div className="intrinsic-spec">
        {specBlocks.map((block) => (
          <div key={block.key} className="intrinsic-spec-block">
            <div className="intrinsic-spec-subhead">
              <Cpu size={11} />{" "}
              {specBlocks.length > 1 ? `${block.role} — ` : ""}
              {block.kindId ?? "unkinded"}
              <span className="intrinsic-spec-asset" title={block.assetName}>
                {block.assetName}
              </span>
            </div>
            <table className="intrinsic-spec-table">
              <tbody>
                {block.params.map(([key, value]) => (
                  <tr key={key}>
                    <td className="intrinsic-spec-key">{key}</td>
                    <td
                      className="intrinsic-spec-val"
                      title={typeof value === "object" && value !== null ? JSON.stringify(value) : undefined}
                    >
                      {formatValue(value)}
                    </td>
                  </tr>
                ))}
                {block.range && (
                  <tr>
                    <td className="intrinsic-spec-key">wavelengthRangeNm</td>
                    <td className="intrinsic-spec-val">{formatValue(block.range)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ))}

        {physicsPlugin != null && anchors.length > 0 && (
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
