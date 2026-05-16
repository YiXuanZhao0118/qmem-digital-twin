import { isPhysicsPlugin, resolvePortDomain } from "../kinds/_plugin";
import { pluginForKind } from "../kinds/_plugins";
import type {
  Anchor,
  PhysicsElement,
  SceneObject,
} from "../types/digitalTwin";

/** RF Link visualises four signal domains:
 *   - "rf":      analog RF carrier (rf_source ↔ rf_amplifier ↔ AOM rf_in)
 *   - "ttl":     HIGH/LOW gate input on an instrument (switch.ttl_in)
 *   - "trigger": rising-edge trigger input on an instrument (AOM/EOM
 *                trigger_in, function-generator trigger_in)
 *   - "rfout":   PPG's single output signal — a HIGH/LOW gate at
 *                ``highVoltageV``. Connects to either ttl_in or
 *                trigger_in (see ``domainsAreCompatible`` below). */
export type RfLinkSignalDomain = "rf" | "ttl" | "trigger" | "rfout";
export type RfLinkConnectorFamily = "sma" | "bnc";

export function isRfLinkSignalDomain(value: unknown): value is RfLinkSignalDomain {
  return value === "rf" || value === "ttl" || value === "trigger" || value === "rfout";
}

/** Connection-time compatibility rule. Same-domain always connects.
 *  ``rfout`` is the PPG's output domain and is compatible with the
 *  HIGH/LOW gate inputs (``ttl`` + ``trigger``); it does NOT cross
 *  into the analog RF carrier domain. */
export function domainsAreCompatible(
  a: RfLinkSignalDomain,
  b: RfLinkSignalDomain,
): boolean {
  if (a === b) return true;
  if (a === "rfout") return b === "ttl" || b === "trigger";
  if (b === "rfout") return a === "ttl" || a === "trigger";
  return false;
}

export function connectorFamilyFromAnchor(
  anchor: Pick<Anchor, "connectorType"> | null | undefined,
): RfLinkConnectorFamily | null {
  const connectorType = anchor?.connectorType;
  if (typeof connectorType !== "string") return null;
  if (connectorType.startsWith("sma")) return "sma";
  if (connectorType.startsWith("bnc")) return "bnc";
  return null;
}

export function resolveRfLinkPortDomain(args: {
  kind: string | null;
  anchorId: string;
}): RfLinkSignalDomain | null {
  const { kind, anchorId } = args;
  if (!kind) return null;

  // PPG's rf_out emits the unified "rfout" gate — independent of any
  // TimingProgram metadata since alembic 0051 collapsed the kind axis.
  if (kind === "programmable_pulse_generator" && anchorId === "rf_out") {
    return "rfout";
  }

  const plugin = pluginForKind(kind);
  if (!plugin || !isPhysicsPlugin(plugin)) return null;
  const domain = resolvePortDomain(plugin, anchorId);
  return isRfLinkSignalDomain(domain) ? domain : null;
}

/** Positional CH index of a PPG within the scene's PPG list. Returns
 *  null for non-PPG elements. Channel ordering is the scene's PPG list
 *  sorted by SceneObject.id (stable across reloads); replaces the old
 *  ``TimingProgram.channel_index`` storage column dropped in 0051. */
export function ppgChannelIndex(
  physicsElement: PhysicsElement | null | undefined,
  allPhysicsElements: readonly PhysicsElement[],
  allObjects: readonly SceneObject[],
): number | null {
  if (!physicsElement || physicsElement.elementKind !== "programmable_pulse_generator") {
    return null;
  }
  const ppgObjectIds = allPhysicsElements
    .filter((pe) => pe.elementKind === "programmable_pulse_generator")
    .map((pe) => pe.objectId);
  // Sort by SceneObject.id for a deterministic global ordering — using
  // object ids (UUIDs) keeps the assignment stable across renders even
  // when timing_programs in DB have no created_at-based order.
  const objectIdOrder = new Map(
    allObjects.map((obj, i) => [obj.id, i] as const),
  );
  const sortedPpgIds = ppgObjectIds.slice().sort((a, b) => {
    const ia = objectIdOrder.get(a) ?? Number.MAX_SAFE_INTEGER;
    const ib = objectIdOrder.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ia - ib;
  });
  const idx = sortedPpgIds.indexOf(physicsElement.objectId);
  return idx >= 0 ? idx : null;
}

/** Positional CH index keyed by TimingProgram id — handy for the
 *  Pulse & Timing panel which works in program-space rather than
 *  PPG-object space. */
export function programChannelIndex(
  programId: string,
  allPhysicsElements: readonly PhysicsElement[],
  allObjects: readonly SceneObject[],
): number | null {
  const ppg = allPhysicsElements.find(
    (pe) =>
      pe.elementKind === "programmable_pulse_generator"
      && (pe.kindParams as { timingProgramId?: string } | undefined)?.timingProgramId === programId,
  );
  if (!ppg) return null;
  return ppgChannelIndex(ppg, allPhysicsElements, allObjects);
}

export function kindParticipatesInRfLink(kind: string | null): boolean {
  if (!kind) return false;
  const plugin = pluginForKind(kind);
  if (!plugin || !isPhysicsPlugin(plugin)) return false;
  const declared = [
    ...plugin.physics.anchors.required,
    ...plugin.physics.anchors.optional,
  ];
  return declared.some((id) => isRfLinkSignalDomain(resolvePortDomain(plugin, id)));
}
