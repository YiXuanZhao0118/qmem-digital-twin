// RF link panel — 2D schematic of every RF-bearing SceneObject + every
// `rf_cable` that physically connects them via `rfCableEndpoints` links.
//
// Layout: 3-column auto-bucket
//   col 0 (left)   = sources           → rf_source (DDS / AD9959 etc.)
//   col 1 (middle) = transducers       → AOM / EOM / anything with rf_in
//   col 2 (right)  = sinks / emitters  → horn_antenna
// Within a column nodes stack vertically in name order.
//
// Per-port behaviour:
//   - rf_source rf_out port  → inline-editable Freq (MHz) + Vpp (V) inputs.
//     Editing commits to RfSourceParams.channels[idx]. After Phase B, this
//     IS the single source of truth — the backend solver resolves the
//     resulting freq/power live from the upstream link via
//     `hydrate_aom_rf_drive`, so no auto-sync write to the AOM is needed.
//   - aom rf_in port → computed "need ≥ Vpp" hint derived from the AOM's
//     M² / L / W and a default 780 nm optical wavelength. Vpp is the
//     50 Ω-load peak-to-peak that delivers the RF power needed for full
//     diffraction efficiency. Acts as a sanity check against the actual
//     upstream Vpp.
//   - any other port → plain anchor-name label, click-selectable.
//
// Vpp ↔ amplitudeScale: AD9959 single-ended into 50 Ω at default Rset has
// ~1.0 Vpp full-scale, so Vpp ≈ amplitudeScale × VPP_FULL_SCALE.
//
// Edges are pulled from each rf_cable's `properties.rfCableEndpoints.{A,B}`
// link records. Cables with one or zero linked ends are listed in a
// "dangling cables" sidebar — we don't draw half-edges into empty space.

import { useEffect, useMemo, useRef, useState } from "react";
import { Cable } from "lucide-react";

import { useSceneStore } from "../store/sceneStore";
import type {
  Anchor,
  AOMParams,
  Asset3D,
  ComponentItem,
  DdsChannel,
  PhysicsElement,
  RfAmplifierParams,
  RfCableEndpointLink,
  RfSourceParams,
  SceneObject,
} from "../types/digitalTwin";
import {
  AD9959_VPP_FULL_SCALE,
  portKey as rfPortKey,
  type RfSignalState,
} from "../utils/rfPropagation";
import {
  buildRfPropagationSchedule,
  getRfSnapshotAt,
} from "../utils/rfPropagationSchedule";
import {
  connectorFamilyFromAnchor,
  kindParticipatesInRfLink,
  ppgChannelIndex,
  resolveRfLinkPortDomain,
  type RfLinkConnectorFamily,
  type RfLinkSignalDomain,
} from "../utils/rfLinkPorts";
import { FloatingPanel } from "./workspace/FloatingPanel";

const PORT_R = 5;
/** Minimum / maximum block width. Final width per column is the widest
 *  rendered row inside that column, clamped to this range so a degenerate
 *  one-char anchor doesn't shrink the block to nothing and a runaway
 *  provenance string doesn't blow the SVG out beyond a sensible bound. */
const NODE_MIN_W = 200;
const NODE_MAX_W = 480;
const NODE_HEADER_H = 28;
const PORT_ROW_H = 30;
const COL_GAP = 90;
const ROW_GAP = 28;
const PAD = 24;

/** Estimate the rendered pixel width of a chunk of text at the given font
 *  size. The system-ui stack we use is variable-width, but at this fontSize
 *  range ~0.58 × fontSize per ASCII character is a reliable upper bound
 *  (proportional digits / punctuation come in shorter, CJK comes in longer
 *  but we don't put CJK in the panel). The estimator is used purely for
 *  layout sizing, not for clipping decisions, so consistent over-estimation
 *  is fine — it just leaves a little extra padding. */
function estimateTextWidthPx(text: string, fontSizePx = 10): number {
  return text.length * fontSizePx * 0.58;
}

/** AD9959 single-ended into 50 Ω at default Rset (1.91 kΩ) is roughly
 *  1.0 Vpp at amplitudeScale = 1.0. Now imported from rfPropagation so
 *  RfLinkPanel + aomRfDrive + backend hydrate use the same constant. */
const VPP_FULL_SCALE = AD9959_VPP_FULL_SCALE;
/** RF load impedance (50 Ω) — used for the AOM required-Vpp computation. */
const Z_OHM = 50;
/** Default optical wavelength for the AOM required-Vpp readout. Real beam
 *  λ would require tracing the upstream optical chain to this AOM; for the
 *  Phase A readout we use 780 nm (Rb/Cs cold-atom typical). */
const DEFAULT_LAMBDA_NM = 780;

/** localStorage key for the per-object (dx, dy) layout offsets the user
 *  has dragged blocks to. Keyed by SceneObject.id so an object moves
 *  consistently across panel re-renders / browser reloads, but resets
 *  cleanly when the object is deleted. */
const NODE_OFFSETS_STORAGE_KEY = "qmem.rfLinkPanel.nodeOffsets";

type NodeOffset = { dx: number; dy: number };

function loadNodeOffsets(): Map<string, NodeOffset> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = window.localStorage.getItem(NODE_OFFSETS_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return new Map();
    const out = new Map<string, NodeOffset>();
    for (const [k, v] of Object.entries(parsed)) {
      if (
        v &&
        typeof v === "object" &&
        typeof (v as NodeOffset).dx === "number" &&
        typeof (v as NodeOffset).dy === "number"
      ) {
        out.set(k, { dx: (v as NodeOffset).dx, dy: (v as NodeOffset).dy });
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

function saveNodeOffsets(offsets: Map<string, NodeOffset>): void {
  if (typeof window === "undefined") return;
  try {
    const obj: Record<string, NodeOffset> = {};
    offsets.forEach((v, k) => {
      obj[k] = v;
    });
    window.localStorage.setItem(NODE_OFFSETS_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    /* ignore quota / serialization errors */
  }
}

type PortRole = "in" | "out";

type Port = {
  anchorId: string;
  /** Raw asset anchor name (or anchor.id when name is null) — used as the
   *  routing key for cable endpoints, propagation maps, and port-key
   *  occupancy lookups. MUST match the asset's stored value exactly,
   *  otherwise `createRfCableBetweenPorts.resolvePort` can't find the
   *  anchor and silently fails. */
  anchorName: string;
  /** Display-only canonical name (rf_in / RF In / RFIN → RFIN). Rendered
   *  in port labels and drag hints; never used for routing. */
  displayName: string;
  role: PortRole;
  domain: RfLinkSignalDomain;
  connectorFamily: RfLinkConnectorFamily | null;
};

type RfNode = {
  objectId: string;
  name: string;
  kind: string | null;
  column: 0 | 1 | 2;
  ports: Port[];
};

type RfEdge = {
  cableObjectId: string;
  cableName: string;
  lengthMm: number | null;
  fromObjectId: string;
  fromKey: string;
  toObjectId: string;
  toKey: string;
};

type DanglingCable = {
  cableObjectId: string;
  cableName: string;
  endsLinked: 0 | 1;
};

/** Decide whether a SceneObject of the given kind should appear as a
 *  node in the RF link panel. A kind qualifies when its plugin declares
 *  at least one anchor whose port domain resolves to "rf" — covers
 *  rf_source / rf_amplifier / rf_switch / horn_antenna and the AOM /
 *  EOM hybrid (where rf_in is explicitly tagged "rf" in `portDomains`).
 *
 *  Pure-optical kinds whose asset happens to expose a stray rf_*-named
 *  anchor (fiber patch cables, for example, where the wrong asset row
 *  has leaked rf anchors) get filtered out here because the PLUGIN
 *  contract is what matters — the asset's anchor list is data and can
 *  be wrong, the plugin contract is the schema and is right by
 *  definition. */
// kindParticipatesInRfLink is shared with the store-side validation helper.

/** Resolve the RF ports of a SceneObject. Cross-checks each asset anchor
 *  against the plugin's `portDomains` (Phase 2) before admitting it as
 *  an RF port — keeps stray rf_*-named anchors on non-RF assets from
 *  leaking into the panel and keeps the AOM's optical anchors out of
 *  the RF column. */
function rfLinkPortsOf(
  anchors: Anchor[],
  kind: string | null,
): Port[] {
  return anchors
    .map((a) => {
      const domain = resolveRfLinkPortDomain({
        kind,
        anchorId: a.id,
      });
      if (!domain) return null;
      const anchorName = a.name ?? a.id;
      return {
        anchorId: a.id,
        anchorName,
        displayName: normaliseAnchorName(a.id, a.name),
        role: a.id === "rf_in" || a.id === "ttl_in" || a.id === "trigger_in"
          ? ("in" as const)
          : ("out" as const),
        domain,
        connectorFamily: connectorFamilyFromAnchor(a),
      };
    })
    .filter((port): port is Port => port !== null);
}

function classifyColumn(kind: string | null, ports: Port[]): 0 | 1 | 2 {
  if (kind === "rf_source") return 0;
  if (kind === "horn_antenna") return 2;
  const hasIn = ports.some((p) => p.role === "in");
  const hasOut = ports.some((p) => p.role === "out");
  if (hasOut && !hasIn) return 0;
  if (hasIn && !hasOut) return 2;
  return 1;
}

function endpointKey(link: RfCableEndpointLink): string {
  return `${link.targetAnchorId}|${link.targetAnchorName}`;
}

function portKey(p: Port): string {
  return `${p.anchorId}|${p.anchorName}`;
}

/** Inline `· CONNECTOR` tag used in every port row — fallback text AND the
 *  editable body rows (DDS rf_out, AOM rf_in, amp in/out). Keeps the
 *  connector visibility uniform across all kinds; without it only ports
 *  that fall through to the plain-text fallback (switch, horn, PPG) show
 *  the connector family. Domain (RF/TTL/Trigger) is already implicit in
 *  the anchor name (RFIN / RFOUT / TTLIN / TRIGGER), so we omit it here.
 */
function PortConnectorTag({ port }: { port: Port }) {
  return (
    <span
      style={{
        color: port.connectorFamily ? "#8e8e9a" : "#d96666",
        fontSize: 9,
        whiteSpace: "nowrap",
      }}
    >
      · {port.connectorFamily?.toUpperCase() ?? "NO CONN"}
    </span>
  );
}

/** Canonical anchor-name overrides. Asset rows currently store one of three
 *  variants per id ("rf_in" / "RF In" / "RFIN" / null), all referring to the
 *  same coax port. We normalise at display time so the user sees one form
 *  regardless of which asset author typed which spelling. Multi-port assets
 *  (switch RF1/RF2, DDS CH0..CH3) keep their distinct names because their
 *  anchor.name doesn't reduce to the canonical id form. */
const CANONICAL_PORT_NAMES: Record<string, string> = {
  rf_in: "RFIN",
  rf_out: "RFOUT",
  ttl_in: "TTLIN",
  trigger_in: "TRIGGER",
};
function normaliseAnchorName(anchorId: string, anchorName: string | null | undefined): string {
  const canonical = CANONICAL_PORT_NAMES[anchorId];
  if (!canonical) return anchorName ?? anchorId;
  if (!anchorName) return canonical;
  const stripped = anchorName.replace(/[\s_]/g, "").toUpperCase();
  const idStripped = anchorId.replace(/[\s_]/g, "").toUpperCase();
  // Only override when the user-set name is just a stylistic variant of the
  // anchor id; preserve genuine multi-port names (RF1 / RF2 / CH0 ...).
  return stripped === idStripped ? canonical : anchorName;
}

function powerWToVpp(p: number): number {
  return Math.sqrt(8 * Z_OHM * Math.max(0, p));
}

/** Required RF drive power (W) for full Bragg diffraction efficiency
 *  (η = 1) on a given AOM at the chosen optical wavelength. Mirrors the
 *  inverse of the closed-form formula in `aom/physics.ts`:
 *    η = sin²((πL / 2λ cosθ_B) · √(2 M² P_d / W))
 *  Solving η = 1 (arg = π/2) at small θ_B → P_d = (W · λ²) / (2 M² L²).
 *  Returns null when any of M², L, W is missing. */
function aomRequiredPowerW(aom: AOMParams, lambdaNm: number = DEFAULT_LAMBDA_NM): number | null {
  const m2 = aom.figureOfMeritM2;
  const lMm = aom.crystalLengthMm;
  const wMm = aom.acousticBeamWidthMm;
  if (m2 == null || lMm == null || wMm == null || m2 <= 0 || lMm <= 0 || wMm <= 0) return null;
  const lambdaM = lambdaNm * 1e-9;
  const lM = lMm * 1e-3;
  const wM = wMm * 1e-3;
  return (wM * lambdaM * lambdaM) / (2 * m2 * lM * lM);
}

// ============================================================================
// Sub-components: per-port editors
// ============================================================================

type EditableAd9959RowProps = {
  port: Port;
  ownerObjectId: string;
  channel: DdsChannel;
  /** Synchronously call upsertOpticalElement under the hood; returns when
   *  the backend has acknowledged so the panel re-renders with fresh state. */
  onCommit: (patch: { frequencyMhz?: number; amplitudeScale?: number }) => Promise<void>;
};

function EditableAd9959Row({ port, channel, onCommit }: EditableAd9959RowProps) {
  // Uncontrolled inputs (defaultValue + event.target.value on blur) — avoids
  // the controlled-component closure trap where a quick blur() runs before
  // React has flushed the latest draft state. The `key` prop forces a fresh
  // input element when the upstream value changes (e.g. after a successful
  // commit the server re-broadcasts the new channel state and we want the
  // input to reflect it). Inside the input, the user's typing stays
  // entirely in DOM until they blur or press Enter.
  const currentFreq = channel.frequencyMhz ?? 0;
  const currentVpp = (channel.amplitudeScale ?? 0) * VPP_FULL_SCALE;

  const commitFreq = (raw: string, target: HTMLInputElement) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      target.value = String(currentFreq);
      return;
    }
    if (n === currentFreq) return;
    void onCommit({ frequencyMhz: n });
  };
  const commitVpp = (raw: string, target: HTMLInputElement) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      target.value = currentVpp.toFixed(2);
      return;
    }
    const scale = Math.max(0, Math.min(1, n / VPP_FULL_SCALE));
    if (Math.abs(scale - (channel.amplitudeScale ?? 0)) < 1e-6) return;
    void onCommit({ amplitudeScale: scale });
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        fontSize: 10,
        color: "#cfcfd8",
        height: PORT_ROW_H,
        paddingRight: 12,
      }}
    >
      <span style={{ minWidth: 28, color: "#e8e8ee", fontWeight: 500 }}>{port.displayName}</span>
      <PortConnectorTag port={port} />
      <input
        key={`freq-${currentFreq}`}
        type="number"
        defaultValue={String(currentFreq)}
        step="0.1"
        min={0}
        onBlur={(e) => commitFreq(e.target.value, e.target)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") (e.target as HTMLInputElement).value = String(currentFreq);
        }}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 50,
          background: "#1c1c22",
          color: "#e8e8ee",
          border: "1px solid #3e3e48",
          borderRadius: 2,
          padding: "1px 3px",
          fontSize: 10,
        }}
      />
      <span style={{ color: "#8e8e9a" }}>MHz</span>
      <input
        key={`vpp-${currentVpp.toFixed(4)}`}
        type="number"
        defaultValue={currentVpp.toFixed(2)}
        step="0.05"
        min={0}
        max={VPP_FULL_SCALE}
        onBlur={(e) => commitVpp(e.target.value, e.target)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") (e.target as HTMLInputElement).value = currentVpp.toFixed(2);
        }}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 44,
          background: "#1c1c22",
          color: "#e8e8ee",
          border: "1px solid #3e3e48",
          borderRadius: 2,
          padding: "1px 3px",
          fontSize: 10,
        }}
      />
      <span style={{ color: "#8e8e9a" }}>Vpp</span>
    </div>
  );
}

type AomInRowProps = {
  port: Port;
  requiredVpp: number | null;
  /** Live signal arriving at the AOM rf_in port. Pulled from the RF
   *  propagation map so it reflects ANY upstream amplifier gain that's
   *  already been applied; bypasses the rf_source channel's raw Vpp. */
  incomingSignal: RfSignalState | null;
  /** Display name of the originating rf_source object (e.g. "AD9959").
   *  Resolved from the SceneObject list by the caller. */
  sourceObjectName: string | null;
};

/** Format a small power value in human-friendly W / mW / µW depending on
 *  magnitude so the AOM RF readout doesn't show "0.00 W" when the upstream
 *  is in the hundred-mW regime that Bragg drives actually live in. */
function formatPowerW(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "0";
  if (p >= 1.0) return `${p.toFixed(2)} W`;
  if (p >= 1e-3) return `${(p * 1e3).toFixed(1)} mW`;
  return `${(p * 1e6).toFixed(0)} µW`;
}

function AomInRow({ port, requiredVpp, incomingSignal, sourceObjectName }: AomInRowProps) {
  // Pre-compute every readout so the JSX stays a thin layout pass.
  const incomingVpp = incomingSignal ? incomingSignal.vpp : null;
  const incomingFreqMhz = incomingSignal ? incomingSignal.frequencyMhz : null;
  const incomingPowerW = incomingSignal ? (incomingVpp! * incomingVpp!) / (8 * 50) : null;
  const ratio = requiredVpp && incomingVpp ? incomingVpp / requiredVpp : null;
  let badge: { color: string; text: string } | null = null;
  if (requiredVpp != null && incomingVpp != null) {
    if (ratio! < 0.5) badge = { color: "#d96666", text: "⚠ under" };
    else if (ratio! > 1.5) badge = { color: "#d49a3a", text: "⚠ over" };
    else badge = { color: "#7be08a", text: "OK" };
  }
  // Build the provenance hint shown right-aligned. Examples:
  //   "← AD9959 · CH0"               (direct cable)
  //   "← AD9959 · CH0 · +29 dB"      (through one ZHL-1-2W)
  //   "← AD9959 · CH0 · +29 dB ⚠ clamped"
  const provenance: string | null = (() => {
    if (!incomingSignal) return null;
    const parts: string[] = [];
    if (sourceObjectName) parts.push(sourceObjectName);
    parts.push(incomingSignal.sourceAnchorName);
    if (Math.abs(incomingSignal.cumulativeGainDb) > 0.05) {
      const sign = incomingSignal.cumulativeGainDb > 0 ? "+" : "";
      parts.push(`${sign}${incomingSignal.cumulativeGainDb.toFixed(1)} dB`);
    }
    return `← ${parts.join(" · ")}`;
  })();

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 10,
        color: "#cfcfd8",
        height: PORT_ROW_H,
        paddingLeft: 12, // leave room for blue port dot at left rect edge
        overflow: "hidden",
      }}
      title={
        // Full tooltip — fits even when the inline row truncates.
        incomingSignal
          ? `${port.displayName} input: ${incomingFreqMhz!.toFixed(2)} MHz · ${incomingVpp!.toFixed(2)} Vpp · ${formatPowerW(incomingPowerW!)}` +
            (requiredVpp != null ? `\nneed ≥ ${requiredVpp.toFixed(2)} Vpp for full Bragg η` : "") +
            (provenance ? `\n${provenance.replace("← ", "from ")}` : "") +
            (incomingSignal.saturated ? "\n⚠ Upstream amplifier clamped at P_max" : "")
          : `${port.displayName} input: no upstream rf_source linked`
      }
    >
      <span style={{ minWidth: 28, color: "#e8e8ee", fontWeight: 500 }}>{port.displayName}</span>
      <PortConnectorTag port={port} />
      {/* Primary readout: what's actually arriving at the AOM right now.
          Three columns, monospaced-style alignment so the freq / Vpp / W
          tuple lines up across multiple AOMs in the column. */}
      {incomingSignal ? (
        <span style={{ color: "#e8e8ee" }}>
          <strong style={{ color: "#e8e8ee" }}>{incomingFreqMhz!.toFixed(1)}</strong>
          <span style={{ color: "#8e8e9a" }}> MHz · </span>
          <strong style={{ color: "#e8e8ee" }}>{incomingVpp!.toFixed(2)}</strong>
          <span style={{ color: "#8e8e9a" }}> V · </span>
          <span style={{ color: "#cfcfd8" }}>{formatPowerW(incomingPowerW!)}</span>
        </span>
      ) : (
        <span style={{ color: "#6e6e7a" }}>no upstream</span>
      )}
      {/* Required-Vpp hint shrinks to a small secondary label so the
          actual incoming reading stays dominant. */}
      {requiredVpp != null && (
        <span style={{ color: "#6e6e7a", fontSize: 9 }}>
          (≥ {requiredVpp.toFixed(2)} V)
        </span>
      )}
      {badge && (
        <span style={{ color: badge.color, fontSize: 9 }}>{badge.text}</span>
      )}
      {incomingSignal?.saturated && (
        <span style={{ color: "#d49a3a", fontSize: 9 }}>⚠ clamp</span>
      )}
      {/* Provenance chip sits at the right edge. CSS handles overflow
          when the rect is narrow. */}
      {provenance && (
        <span
          style={{
            marginLeft: "auto",
            color: "#8e8e9a",
            fontSize: 9,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 90,
          }}
        >
          {provenance}
        </span>
      )}
    </div>
  );
}

// ============================================================================
// Amplifier transformation rows — show Vpp_in → gain → Vpp_out so the user
// can see the ZHL-1-2W (and any future RF amp) effect at a glance. Mirrors
// the EditableAd9959Row / AomInRow styling so the schematic reads uniformly.
// ============================================================================

type AmpInRowProps = {
  port: Port;
  incomingVpp: number | null;
};

function AmpInRow({ port, incomingVpp }: AmpInRowProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 10,
        color: "#cfcfd8",
        height: PORT_ROW_H,
        paddingLeft: 12,
      }}
    >
      <span style={{ minWidth: 30, color: "#e8e8ee", fontWeight: 500 }}>{port.displayName}</span>
      <PortConnectorTag port={port} />
      {incomingVpp != null ? (
        <span style={{ color: "#8e8e9a" }}>
          in: <strong style={{ color: "#cfcfd8" }}>{incomingVpp.toFixed(2)}</strong> Vpp
        </span>
      ) : (
        <span style={{ color: "#6e6e7a" }}>no upstream</span>
      )}
    </div>
  );
}

type AmpOutRowProps = {
  port: Port;
  outgoingVpp: number | null;
  gainDb: number;
  saturated: boolean;
};

function AmpOutRow({ port, outgoingVpp, gainDb, saturated }: AmpOutRowProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 6,
        fontSize: 10,
        color: "#cfcfd8",
        height: PORT_ROW_H,
        paddingRight: 12,
      }}
    >
      <span style={{ color: "#8e8e9a" }}>+{gainDb.toFixed(1)} dB</span>
      {outgoingVpp != null && (
        <span style={{ color: "#8e8e9a" }}>
          → <strong style={{ color: "#cfcfd8" }}>{outgoingVpp.toFixed(2)}</strong> Vpp
        </span>
      )}
      {saturated && (
        <span style={{ color: "#d49a3a", fontSize: 9 }}>⚠ clamp</span>
      )}
      <PortConnectorTag port={port} />
      <span style={{ minWidth: 30, color: "#e8e8ee", fontWeight: 500, textAlign: "right" }}>
        {port.displayName}
      </span>
    </div>
  );
}

// ============================================================================
// Main panel
// ============================================================================

export function RfLinkPanel() {
  const objects = useSceneStore((s) => s.scene.objects);
  const components = useSceneStore((s) => s.scene.components);
  const assets = useSceneStore((s) => s.scene.assets);
  const physicsElements = useSceneStore((s) => s.scene.physicsElements);
  const timingPrograms = useSceneStore((s) => s.scene.timingPrograms) ?? [];
  const selectObject = useSceneStore((s) => s.selectObject);
  const selectedObjectId = useSceneStore((s) => s.selectedObjectId);
  const upsertOpticalElement = useSceneStore((s) => s.upsertOpticalElement);
  const createRfCableBetweenPorts = useSceneStore((s) => s.createRfCableBetweenPorts);

  // Drag-to-connect state: pointerdown on a port starts a rubber-band; if
  // released on another port of the opposite role on a different object,
  // we spawn a fresh rf_cable SceneObject and auto-attach both ends. The
  // SVG element captures the pointer so the rubber-band follows the cursor
  // even outside the panel chrome.
  type DragState = {
    srcObjectId: string;
    srcAnchorId: string;
    srcAnchorName: string;
    srcRole: PortRole;
    srcDomain: RfLinkSignalDomain;
    srcConnectorFamily: RfLinkConnectorFamily;
    mouseX: number;
    mouseY: number;
    /** Port key (`objectId|anchorId|anchorName|role`) directly under the
     *  cursor right now, or null when over empty space. Driven by the
     *  schematic SVG's onPointerMove via elementFromPoint. Lets the
     *  footer hint preview the target name + whether the connect would
     *  be accepted. */
    hoverPortKey: string | null;
  };
  const [drag, setDrag] = useState<DragState | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // Right-click context menu state. Two modes, mutually exclusive:
  //   - `create-ppg`: empty ttl_in / trigger_in input port → offer
  //     "Create Pulse & Timing program here" (auto-builds PPG + cable).
  //   - `remove-cable`: any port already attached to an rf_cable → offer
  //     "Disconnect cable". Cables are hidden from the Outliner so this
  //     is the only UX path to remove them once placed.
  type PortContextMenu =
    | {
        mode: "create-ppg";
        x: number;
        y: number;
        targetObjectId: string;
        targetAnchorId: string;
        targetAnchorName: string;
        targetConnectorFamily: RfLinkConnectorFamily;
      }
    | {
        mode: "remove-cable";
        x: number;
        y: number;
        cableObjectId: string;
        cableName: string;
        portLabel: string;
      };
  const [portMenu, setPortMenu] = useState<PortContextMenu | null>(null);
  const [ppgBusy, setPpgBusy] = useState(false);
  const [ppgError, setPpgError] = useState<string | null>(null);

  // Per-node layout drag state. Independent of the cable rubber-band
  // drag above: this one starts on the node's rect (not on a port
  // circle), is persisted to localStorage, and lets the user override
  // the auto-column layout to declutter dense scenes.
  type NodeDragState = {
    objectId: string;
    startClientX: number;
    startClientY: number;
    initialOffsetX: number;
    initialOffsetY: number;
    /** Pointerdown→pointerup with no movement counts as a click (selects
     *  the object); set true the moment the cursor moves past the
     *  threshold so we know to suppress the click semantics. */
    movedPastThreshold: boolean;
  };
  const NODE_DRAG_THRESHOLD_PX = 4;
  const [nodeDrag, setNodeDrag] = useState<NodeDragState | null>(null);
  const [nodeOffsets, setNodeOffsets] = useState<Map<string, NodeOffset>>(() => loadNodeOffsets());

  // Body class toggled while a drag is in progress so other floating
  // panels can dim themselves and stop intercepting clicks — the user
  // is clearly mid-action and doesn't want a stray panel interrupting.
  // CSS rule lives in the panel-scoped <style> below so nothing global
  // needs editing; opt-out is just not having that class.
  useEffect(() => {
    if (!drag) return;
    document.body.classList.add("is-rf-link-dragging");
    return () => document.body.classList.remove("is-rf-link-dragging");
  }, [drag !== null]);

  const peByObjectId = useMemo(() => {
    const m = new Map<string, PhysicsElement>();
    for (const e of physicsElements) m.set(e.objectId, e);
    return m;
  }, [physicsElements]);

  const kindByObjectId = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of physicsElements) m.set(e.objectId, e.elementKind);
    return m;
  }, [physicsElements]);

  const createPpgAtPort = useSceneStore((s) => s.createPpgAtPort);
  const deleteObject = useSceneStore((s) => s.deleteObject);
  const updateSceneObject = useSceneStore((s) => s.updateSceneObject);

  // Inline node-name editing — double-click a node header opens a small
  // `<foreignObject>` input. On commit (blur / Enter) we write to the
  // SceneObject.name; for PPG nodes this also propagates to Pulse &
  // Timing's left column via the shared scene state. Escape reverts.
  const [editingNameNodeId, setEditingNameNodeId] = useState<string | null>(null);
  const [editingNameDraft, setEditingNameDraft] = useState<string>("");
  const commitNodeRename = (objectId: string, name: string) => {
    setEditingNameNodeId(null);
    const obj = objects.find((o) => o.id === objectId);
    const trimmed = name.trim();
    if (!obj || trimmed === obj.name) return;
    if (trimmed.length === 0) return;
    void updateSceneObject(objectId, { name: trimmed }).catch(() => {});
  };

  const handleCreatePpgFromMenu = async () => {
    if (!portMenu || portMenu.mode !== "create-ppg") return;
    setPpgBusy(true);
    setPpgError(null);
    try {
      const created = await createPpgAtPort({
        targetObjectId: portMenu.targetObjectId,
        targetAnchorId: portMenu.targetAnchorId,
        targetAnchorName: portMenu.targetAnchorName,
        targetConnectorFamily: portMenu.targetConnectorFamily,
      });
      if (!created) {
        setPpgError("No matching PPG catalog row, or the port is busy.");
      } else {
        setPortMenu(null);
      }
    } catch (err) {
      setPpgError(err instanceof Error ? err.message : String(err));
    } finally {
      setPpgBusy(false);
    }
  };

  const handleRemoveCableFromMenu = async () => {
    if (!portMenu || portMenu.mode !== "remove-cable") return;
    setPpgBusy(true);
    setPpgError(null);
    try {
      await deleteObject(portMenu.cableObjectId);
      setPortMenu(null);
    } catch (err) {
      setPpgError(err instanceof Error ? err.message : String(err));
    } finally {
      setPpgBusy(false);
    }
  };

  const assetByObjectId = useMemo(() => {
    const compMap = new Map<string, ComponentItem>(components.map((c) => [c.id, c]));
    const assetMap = new Map<string, Asset3D>(assets.map((a) => [a.id, a]));
    return (obj: SceneObject): Asset3D | undefined => {
      const c = compMap.get(obj.componentId);
      if (!c || !c.asset3dId) return undefined;
      return assetMap.get(c.asset3dId);
    };
  }, [components, assets]);

  const nodes = useMemo<RfNode[]>(() => {
    const list: RfNode[] = [];
    for (const obj of objects) {
      const kind = kindByObjectId.get(obj.id) ?? null;
      if (kind === "rf_cable") continue;
      // Plugin-driven gate — skips fiber / waveplate / lens / etc. even
      // if their asset row spuriously carries an rf_* anchor name.
      if (!kindParticipatesInRfLink(kind)) continue;
      const asset = assetByObjectId(obj);
      const ports = rfLinkPortsOf(asset?.anchors ?? [], kind);
      if (ports.length === 0) continue;
      list.push({
        objectId: obj.id,
        name: obj.name,
        kind,
        column: classifyColumn(kind, ports),
        ports,
      });
    }
    return list;
  }, [objects, kindByObjectId, assetByObjectId, peByObjectId, timingPrograms]);

  const { edges, dangling } = useMemo<{ edges: RfEdge[]; dangling: DanglingCable[] }>(() => {
    const edgesOut: RfEdge[] = [];
    const danglingOut: DanglingCable[] = [];
    for (const obj of objects) {
      const kind = kindByObjectId.get(obj.id);
      if (kind !== "rf_cable") continue;
      const ep = (obj.properties as {
        rfCableEndpoints?: { A?: RfCableEndpointLink; B?: RfCableEndpointLink };
      }).rfCableEndpoints;
      const a = ep?.A;
      const b = ep?.B;
      const pe = peByObjectId.get(obj.id);
      const lengthMm =
        pe && pe.elementKind === "rf_cable"
          ? ((pe as { kindParams: { lengthMm?: number } }).kindParams.lengthMm ?? null)
          : null;
      if (a && b) {
        edgesOut.push({
          cableObjectId: obj.id,
          cableName: obj.name,
          lengthMm,
          fromObjectId: a.targetObjectId,
          fromKey: endpointKey(a),
          toObjectId: b.targetObjectId,
          toKey: endpointKey(b),
        });
      } else {
        danglingOut.push({
          cableObjectId: obj.id,
          cableName: obj.name,
          endsLinked: a || b ? 1 : 0,
        });
      }
    }
    return { edges: edgesOut, dangling: danglingOut };
  }, [objects, kindByObjectId, peByObjectId]);

  /** For each (objectId|anchorName) of an rf_source rf_out port, find the
   *  matching DdsChannel by `channel.anchorName === anchorName`. */
  const channelByPortKey = useMemo(() => {
    const m = new Map<string, { channel: DdsChannel; channelIdx: number; params: RfSourceParams }>();
    for (const pe of physicsElements) {
      if (pe.elementKind !== "rf_source") continue;
      const params = pe.kindParams as RfSourceParams;
      const channels = params.channels ?? [];
      channels.forEach((ch, i) => {
        if (!ch.anchorName) return;
        m.set(`${pe.objectId}|${ch.anchorName}`, { channel: ch, channelIdx: i, params });
      });
    }
    return m;
  }, [physicsElements]);

  /** Set of port keys that are already claimed by an existing rf_cable
   *  endpoint. Used to (a) visually mute the port circle so the user
   *  sees it's busy, (b) block the drag-to-connect pointerup commit so
   *  we don't create a second cable to the same anchor. Key format:
   *  `${objectId}|${anchorId}|${anchorName}`. */
  const occupiedPortKeys = useMemo(() => {
    const s = new Set<string>();
    for (const obj of objects) {
      if (kindByObjectId.get(obj.id) !== "rf_cable") continue;
      const ep = (obj.properties as {
        rfCableEndpoints?: { A?: RfCableEndpointLink; B?: RfCableEndpointLink };
      }).rfCableEndpoints;
      for (const link of [ep?.A, ep?.B]) {
        if (link) s.add(`${link.targetObjectId}|${link.targetAnchorId}|${link.targetAnchorName}`);
      }
    }
    return s;
  }, [objects, kindByObjectId]);

  /** Reverse index: port key → owning rf_cable SceneObject id. Used by
   *  the right-click "Remove cable" context menu so a single click can
   *  disconnect a port without the user having to find the cable in the
   *  Outliner. */
  const cableByPortKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const obj of objects) {
      if (kindByObjectId.get(obj.id) !== "rf_cable") continue;
      const ep = (obj.properties as {
        rfCableEndpoints?: { A?: RfCableEndpointLink; B?: RfCableEndpointLink };
      }).rfCableEndpoints;
      for (const link of [ep?.A, ep?.B]) {
        if (link) {
          m.set(
            `${link.targetObjectId}|${link.targetAnchorId}|${link.targetAnchorName}`,
            obj.id,
          );
        }
      }
    }
    return m;
  }, [objects, kindByObjectId]);

  /** AOM kindParams keyed by SceneObject id. Lets the rf_in port reader
   *  pull M²/L/W in one lookup. */
  const aomByObjectId = useMemo(() => {
    const m = new Map<string, AOMParams>();
    for (const pe of physicsElements) {
      if (pe.elementKind !== "aom") continue;
      m.set(pe.objectId, pe.kindParams as AOMParams);
    }
    return m;
  }, [physicsElements]);

  /** Full RF propagation map — for every port that an RF signal reaches,
   *  the frequency + Vpp + provenance. Replaces the old direct-only
   *  upstreamByAomKey: now signals walk through any number of amplifiers
   *  before landing at the AOM (or any other rf_in sink), so the panel
   *  shows the actually-amplified Vpp rather than the raw source Vpp.
   *  Same map drives the AOM "incoming Vpp" badge AND the amplifier
   *  rf_in/rf_out transformation rows. */
  const scrubTimeNs = useSceneStore((s) => s.scrubTimeNs);
  const deviceStates = useSceneStore((s) => s.scene.deviceStates);
  // Instrument Power panel cascade — kept in sync with the viewer's
  // identical computation (see DigitalTwinViewer.tsx). Powered-off RF
  // sources / amps / switches are excluded from the propagation BFS.
  const poweredOffObjectIds = useMemo(() => {
    const out = new Set<string>();
    for (const ds of deviceStates ?? []) {
      const power = (ds.state as { power?: unknown } | undefined)?.power;
      if (power === false) out.add(ds.objectId);
    }
    return out;
  }, [deviceStates]);
  // Precompute one propagation snapshot per timing section (boundaries
  // = union of all program interval start/end times). The schedule only
  // depends on scene + programs, NOT on scrubTimeNs — so dragging the
  // scrub cursor is an O(log N) lookup instead of a full graph walk.
  const rfPropagationSchedule = useMemo(
    () =>
      buildRfPropagationSchedule({
        objects,
        components,
        assets,
        physicsElements,
        timingPrograms,
        poweredOffObjectIds,
      }),
    [objects, components, assets, physicsElements, timingPrograms, poweredOffObjectIds],
  );
  const rfPropagation = useMemo(
    () => getRfSnapshotAt(rfPropagationSchedule, scrubTimeNs),
    [rfPropagationSchedule, scrubTimeNs],
  );

  /** RfAmplifier kindParams keyed by SceneObject id — pulled out so the
   *  rf_in/rf_out rows can show gain alongside the Vpp transformation. */
  const ampByObjectId = useMemo(() => {
    const m = new Map<string, RfAmplifierParams>();
    for (const pe of physicsElements) {
      if (pe.elementKind !== "rf_amplifier") continue;
      m.set(pe.objectId, pe.kindParams as RfAmplifierParams);
    }
    return m;
  }, [physicsElements]);

  /** Commit handler: write the new channel param to the rf_source. After
   *  Phase B the panel is the canonical source — no AOM-side sync is
   *  needed (the solver hydrates the AOM's effective drive at solve time
   *  via `hydrate_aom_rf_drive`, and the frontend ray-tracer reads the
   *  same upstream resolver).
   *
   *  Auto-creates the matching `channels[]` entry on first edit when the
   *  PhysicsElement was bootstrapped with the legacy `channels: null`
   *  default (the dds_ad9959_pcb auto-create path doesn't seed a per-
   *  anchor channels list yet). The new channel mirrors the AD9959
   *  default tone (80 MHz, 1.0 amplitude, single-tone mode) so the panel
   *  becomes editable the moment the user types into the input. */
  const commitChannelEdit = async (
    srcObjectId: string,
    srcAnchorName: string,
    patch: { frequencyMhz?: number; amplitudeScale?: number },
  ) => {
    const pe = peByObjectId.get(srcObjectId);
    if (!pe || pe.elementKind !== "rf_source") return;
    const params = pe.kindParams as RfSourceParams;
    const channels = params.channels ?? [];
    const idx = channels.findIndex((c) => c.anchorName === srcAnchorName);
    let nextChannels: DdsChannel[];
    if (idx === -1) {
      // First edit on an AD9959 whose channels[] was never bootstrapped.
      // Build a fresh DdsChannel from defaults + the user's patch.
      const fresh: DdsChannel = {
        channelIndex: channels.length,
        anchorName: srcAnchorName,
        mode: "single_tone",
        channelEnabled: true,
        frequencyMhz: patch.frequencyMhz ?? 80.0,
        phaseDeg: 0.0,
        amplitudeScale: patch.amplitudeScale ?? 1.0,
        sweep: null,
        modulationLevels: 2,
        profiles: null,
      };
      nextChannels = [...channels, fresh];
    } else {
      nextChannels = channels.map((c, i) => (i === idx ? { ...c, ...patch } : c));
    }
    await upsertOpticalElement({
      objectId: srcObjectId,
      elementKind: pe.elementKind,
      kindParams: { ...params, channels: nextChannels },
      inputPorts: pe.inputPorts,
      outputPorts: pe.outputPorts,
    });
  };

  type Pos = { x: number; y: number; w: number; h: number };

  /** Per-row pixel-width estimate based on the actual text the row will
   *  render. Mirrors the JSX in EditableAd9959Row / AomInRow / AmpInRow /
   *  AmpOutRow so the block width matches the content one-to-one. */
  const estimateRowWidthPx = (node: RfNode, port: Port): number => {
    // Anchor-name label (left or right padded depending on role).
    const NAME_PAD = 30;
    const SIDE_PAD = 24; // 12px each side inside the foreignObject
    const GAP = 6;
    const labelW = estimateTextWidthPx(port.displayName, 10);
    // Connector tag width — `· BNC` / `· SMA` / `· NO CONN` rendered at
    // fontSize 9 in every body row. Padded so PortConnectorTag never gets
    // clipped on narrow column blocks.
    const connectorTagW = estimateTextWidthPx(
      `· ${port.connectorFamily?.toUpperCase() ?? "NO CONN"}`,
      9,
    );
    // Per-port kind-specific bodies. Keep the order in sync with the
    // render switch below so missing branches show up as conservative
    // "just the anchor name" estimates (small block, easy to spot).
    if (node.kind === "rf_source" && port.role === "out") {
      // EditableAd9959Row: [name] [· BNC] [freq input 50px] MHz [vpp input 44px] Vpp
      const FREQ_INPUT = 50;
      const VPP_INPUT = 44;
      const mhzLabel = estimateTextWidthPx("MHz", 10);
      const vppLabel = estimateTextWidthPx("Vpp", 10);
      return SIDE_PAD + NAME_PAD + GAP + connectorTagW + GAP + FREQ_INPUT + GAP + mhzLabel + GAP + VPP_INPUT + GAP + vppLabel;
    }
    if (node.kind === "aom" && port.role === "in") {
      const aom = aomByObjectId.get(node.objectId);
      const requiredP = aom ? aomRequiredPowerW(aom) : null;
      const requiredVpp = requiredP != null ? powerWToVpp(requiredP) : null;
      const signal = rfPropagation.signalAtPort.get(rfPortKey(node.objectId, port.anchorName));
      const sourceName = signal
        ? objects.find((o) => o.id === signal.sourceObjectId)?.name ?? null
        : null;
      const incomingW = signal
        ? estimateTextWidthPx(
            `${signal.frequencyMhz.toFixed(1)} MHz · ${signal.vpp.toFixed(2)} V · ${signal.vpp.toFixed(2)} mW`,
            10,
          )
        : estimateTextWidthPx("no upstream", 10);
      const requiredW = requiredVpp != null ? estimateTextWidthPx(`(≥ ${requiredVpp.toFixed(2)} V)`, 9) : 0;
      const badgeW = signal && requiredVpp != null ? estimateTextWidthPx("⚠ over", 9) : 0;
      const clampW = signal?.saturated ? estimateTextWidthPx("⚠ clamp", 9) : 0;
      const provenanceW = signal
        ? Math.min(
            estimateTextWidthPx(
              `← ${sourceName ?? ""} · ${signal.sourceAnchorName}` +
                (Math.abs(signal.cumulativeGainDb) > 0.05
                  ? ` · ${signal.cumulativeGainDb > 0 ? "+" : ""}${signal.cumulativeGainDb.toFixed(1)} dB`
                  : ""),
              9,
            ),
            90, // matches the maxWidth on the provenance chip
          )
        : 0;
      return SIDE_PAD + NAME_PAD + GAP + connectorTagW + GAP + incomingW + GAP + requiredW + GAP + badgeW + GAP + clampW + GAP + provenanceW;
    }
    if (node.kind === "rf_amplifier") {
      const amp = ampByObjectId.get(node.objectId);
      const signal = rfPropagation.signalAtPort.get(rfPortKey(node.objectId, port.anchorName));
      if (port.role === "in") {
        const ioW = signal
          ? estimateTextWidthPx(`in: ${signal.vpp.toFixed(2)} Vpp`, 10)
          : estimateTextWidthPx("no upstream", 10);
        return SIDE_PAD + NAME_PAD + GAP + connectorTagW + GAP + ioW;
      }
      // rf_out row: `+gainDb dB → Vpp Vpp ⚠ clamp · CONN anchorName`
      const gainW = estimateTextWidthPx(`+${(amp?.gainDb ?? 0).toFixed(1)} dB`, 10);
      const ioW = signal ? estimateTextWidthPx(`→ ${signal.vpp.toFixed(2)} Vpp`, 10) : 0;
      const clampW = signal?.saturated ? estimateTextWidthPx("⚠ clamp", 9) : 0;
      return SIDE_PAD + gainW + GAP + ioW + GAP + clampW + GAP + connectorTagW + GAP + NAME_PAD;
    }
    // Generic fallback: just the anchor name + connector tag + channel
    // suffix (PPG only) on one side.
    const channelSuffixW =
      node.kind === "programmable_pulse_generator" && port.role === "out"
        ? estimateTextWidthPx(" · CH99", 10)
        : 0;
    return SIDE_PAD + NAME_PAD + GAP + labelW + GAP + connectorTagW + channelSuffixW;
  };

  /** Header width: object name + kind label + a small breathing margin. */
  const estimateHeaderWidthPx = (node: RfNode): number => {
    const SIDE_PAD = 18; // 10px name margin + 8px end gap
    const GAP = 14;
    const nameW = estimateTextWidthPx(node.name, 12);
    const kindW = node.kind ? estimateTextWidthPx(node.kind, 9) : 0;
    return SIDE_PAD + nameW + GAP + kindW;
  };

  const positionByNodeId = useMemo(() => {
    const cols: RfNode[][] = [[], [], []];
    nodes.forEach((n) => cols[n.column].push(n));
    cols.forEach((col) => col.sort((a, b) => a.name.localeCompare(b.name)));

    // Per-column max width — every block in the column shares this width
    // so the in / out port circles line up vertically and the cable edges
    // come out at predictable x coordinates.
    const colWidths = cols.map((col) => {
      let max = NODE_MIN_W;
      for (const node of col) {
        max = Math.max(max, estimateHeaderWidthPx(node));
        for (const port of node.ports) {
          max = Math.max(max, estimateRowWidthPx(node, port));
        }
      }
      return Math.min(NODE_MAX_W, Math.ceil(max));
    });

    // Cumulative column x offsets — variable per scene because each
    // column gets its own width.
    const colX: number[] = [PAD];
    for (let i = 1; i < cols.length; i += 1) {
      colX.push(colX[i - 1] + colWidths[i - 1] + COL_GAP);
    }

    const positions = new Map<string, Pos>();
    cols.forEach((col, i) => {
      let y = PAD;
      const x = colX[i];
      const w = colWidths[i];
      col.forEach((node) => {
        const h = NODE_HEADER_H + node.ports.length * PORT_ROW_H + 10;
        // Apply per-node manual drag offset on top of the auto-layout
        // base position. Offsets persist in localStorage; the auto
        // layout column / row spacing is the fallback for un-dragged
        // nodes and the anchor any future "reset layout" button reverts to.
        const off = nodeOffsets.get(node.objectId);
        positions.set(node.objectId, {
          x: x + (off?.dx ?? 0),
          y: y + (off?.dy ?? 0),
          w,
          h,
        });
        y += h + ROW_GAP;
      });
    });
    return positions;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, rfPropagation, aomByObjectId, ampByObjectId, objects, nodeOffsets]);

  const nodeById = useMemo(() => {
    const m = new Map<string, RfNode>();
    nodes.forEach((n) => m.set(n.objectId, n));
    return m;
  }, [nodes]);

  const portCoord = (objectId: string, key: string): { cx: number; cy: number; role: PortRole } | null => {
    const pos = positionByNodeId.get(objectId);
    const node = nodeById.get(objectId);
    if (!pos || !node) return null;
    const idx = node.ports.findIndex((p) => portKey(p) === key);
    if (idx === -1) return null;
    const port = node.ports[idx];
    const cy = pos.y + NODE_HEADER_H + idx * PORT_ROW_H + PORT_ROW_H / 2;
    const cx = port.role === "in" ? pos.x : pos.x + pos.w;
    return { cx, cy, role: port.role };
  };

  const svgHeight = useMemo(() => {
    let max = 0;
    positionByNodeId.forEach((p) => {
      max = Math.max(max, p.y + p.h);
    });
    return Math.max(max + PAD, 160);
  }, [positionByNodeId]);

  const svgWidth = useMemo(() => {
    let max = 0;
    positionByNodeId.forEach((p) => {
      max = Math.max(max, p.x + p.w);
    });
    // Always reserve the full 3-column footprint so an empty far-right
    // column doesn't crowd the cables coming from the middle.
    const fallback = PAD + 3 * NODE_MIN_W + 2 * COL_GAP + PAD;
    return Math.max(max + PAD, fallback);
  }, [positionByNodeId]);

  return (
    <FloatingPanel id="rf-link" title="RF link" icon={<Cable size={14} />}>
      <style>{`
        body.is-rf-link-dragging .floating-panel:not([data-panel-id="rf-link"]) {
          opacity: 0.35;
          pointer-events: none;
          transition: opacity 0.15s ease-out;
        }
        body.is-rf-link-dragging .floating-panel[data-panel-id="rf-link"] {
          transition: opacity 0.15s ease-out;
        }
      `}</style>
      <div
        style={{
          padding: 8,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          overflow: "hidden",
        }}
      >
        {ppgError && (
          <div
            style={{
              padding: 6,
              background: "#3a1f1f",
              border: "1px solid #6a3a3a",
              borderRadius: 4,
              color: "#ff8f8f",
              fontSize: 11,
              cursor: "pointer",
            }}
            onClick={() => setPpgError(null)}
            title="Click to dismiss"
          >
            {ppgError}
          </div>
        )}
        {nodes.length === 0 ? (
          <div style={{ padding: 16, color: "#9a9aa6", fontSize: 12 }}>
            No RF components in scene yet.
          </div>
        ) : (
          <div style={{ flex: 1, overflow: "auto", background: "#16161b", borderRadius: 4 }}>
            <svg
              ref={svgRef}
              width={svgWidth}
              height={svgHeight}
              style={{ display: "block", fontFamily: "var(--ui-font, system-ui, sans-serif)" }}
              onPointerMove={(e) => {
                if (!drag || !svgRef.current) return;
                const rect = svgRef.current.getBoundingClientRect();
                // Resolve the port key under the cursor so the footer hint
                // can preview "→ Target · Anchor" vs "Port busy" vs the
                // empty-space prompt. elementFromPoint runs in pixel space
                // so we pass the raw clientX/Y here; the rubber-band path
                // is pointer-events: none so it never shadows real ports.
                const hoverEl = document.elementFromPoint(e.clientX, e.clientY) as Element | null;
                const portEl = hoverEl?.closest?.("[data-rf-port-key]") as HTMLElement | null;
                const hoverPortKey = portEl?.dataset?.rfPortKey ?? null;
                setDrag({
                  ...drag,
                  mouseX: e.clientX - rect.left,
                  mouseY: e.clientY - rect.top,
                  hoverPortKey,
                });
              }}
              onPointerUp={(e) => {
                if (!drag) return;
                try { svgRef.current?.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
                // Determine drop target via elementFromPoint — the rubber-
                // band path has pointer-events: none so it never intercepts.
                const targetEl = document.elementFromPoint(e.clientX, e.clientY) as Element | null;
                const portEl = targetEl?.closest?.("[data-rf-port-key]") as HTMLElement | null;
                if (portEl?.dataset?.rfPortKey) {
                  const [objId, anchorId, anchorName, role, domain, connectorFamily] = portEl.dataset.rfPortKey.split("|");
                  const targetKey = `${objId}|${anchorId}|${anchorName}`;
                  // Valid only when target is on a different object, role
                  // is opposite (out → in or in → out), AND the target
                  // anchor isn't already claimed by another rf_cable.
                  // Duplicate-link guard runs here AND in the visual
                  // (occupiedPortKeys) so the user sees a forbidden cursor
                  // before they release; this is a defence-in-depth check.
                  const sameObject = objId === drag.srcObjectId;
                  const sameRole = !role || role === drag.srcRole;
                  const domainMismatch = domain !== drag.srcDomain;
                  // Cross-family (SMA ↔ BNC) is allowed because the catalog
                  // ships `rf_cable_sma_to_bnc`; only block when either
                  // endpoint has no defined connector at all (`"none"`).
                  const connectorUndefined =
                    connectorFamily === "none" || drag.srcConnectorFamily === undefined;
                  const busy = occupiedPortKeys.has(targetKey);
                  if (!sameObject && !sameRole && !domainMismatch && !connectorUndefined && !busy) {
                    const args = drag.srcRole === "out"
                      ? {
                          srcObjectId: drag.srcObjectId,
                          srcAnchorId: drag.srcAnchorId,
                          srcAnchorName: drag.srcAnchorName,
                          tgtObjectId: objId,
                          tgtAnchorId: anchorId,
                          tgtAnchorName: anchorName,
                        }
                      : {
                          srcObjectId: objId,
                          srcAnchorId: anchorId,
                          srcAnchorName: anchorName,
                          tgtObjectId: drag.srcObjectId,
                          tgtAnchorId: drag.srcAnchorId,
                          tgtAnchorName: drag.srcAnchorName,
                        };
                    void createRfCableBetweenPorts(args);
                  }
                }
                setDrag(null);
              }}
              onPointerCancel={() => setDrag(null)}
            >
              {edges.map((e) => {
                const from = portCoord(e.fromObjectId, e.fromKey);
                const to = portCoord(e.toObjectId, e.toKey);
                if (!from || !to) return null;
                // Direction of signal flow on this cable. The output
                // (rf_out) port is always the upstream side; the path
                // is drawn so animateMotion's t=0 starts there and
                // t=1 reaches the downstream input.
                const forward = from.role === "out";
                const startX = forward ? from.cx : to.cx;
                const startY = forward ? from.cy : to.cy;
                const endX = forward ? to.cx : from.cx;
                const endY = forward ? to.cy : from.cy;
                const midX = (startX + endX) / 2;
                const d = `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`;
                const pathId = `rfedge-${e.cableObjectId}`;
                const labelY = (from.cy + to.cy) / 2 - 5;

                // Activity = both endpoints recorded the SAME signal
                // (same source) in the propagation map. When a switch
                // routes to a different throw the inactive cable's
                // endpoint never gets seeded, so the ball naturally
                // disappears. The yellow ball cadence is intentionally
                // fixed (no carrier-frequency scaling) — it's a flow
                // indicator, not a meaningful waveform.
                const fromAnchorName = e.fromKey.split("|")[1] ?? "";
                const toAnchorName = e.toKey.split("|")[1] ?? "";
                const fromSig = rfPropagation.signalAtPort.get(
                  rfPortKey(e.fromObjectId, fromAnchorName),
                );
                const toSig = rfPropagation.signalAtPort.get(
                  rfPortKey(e.toObjectId, toAnchorName),
                );
                const active =
                  !!fromSig
                  && !!toSig
                  && fromSig.sourceObjectId === toSig.sourceObjectId;

                return (
                  <g key={e.cableObjectId}>
                    <path
                      id={pathId}
                      d={d}
                      fill="none"
                      stroke={active ? "#fbbf24" : "#8e8e9a"}
                      strokeWidth={active ? 2.5 : 2}
                    />
                    {active && (
                      <circle r={4.5} fill="#fde68a" stroke="#b45309" strokeWidth={1}>
                        <animateMotion dur="1.4s" repeatCount="indefinite">
                          <mpath href={`#${pathId}`} />
                        </animateMotion>
                      </circle>
                    )}
                    <text
                      x={midX}
                      y={labelY}
                      textAnchor="middle"
                      fontSize={10}
                      fill="#bdbdc8"
                    >
                      {e.cableName}
                      {e.lengthMm != null ? ` · ${e.lengthMm.toFixed(0)} mm` : ""}
                    </text>
                  </g>
                );
              })}

              {nodes.map((n) => {
                const pos = positionByNodeId.get(n.objectId);
                if (!pos) return null;
                const selected = selectedObjectId === n.objectId;
                const isSource = n.kind === "rf_source";
                const aom = n.kind === "aom" ? aomByObjectId.get(n.objectId) ?? null : null;
                const amp = n.kind === "rf_amplifier" ? ampByObjectId.get(n.objectId) ?? null : null;
                const isPpg = n.kind === "programmable_pulse_generator";
                const ppgCh = isPpg
                  ? ppgChannelIndex(peByObjectId.get(n.objectId) ?? null, physicsElements, objects)
                  : null;
                return (
                  <g key={n.objectId}>
                    <rect
                      x={pos.x}
                      y={pos.y}
                      width={pos.w}
                      height={pos.h}
                      rx={6}
                      ry={6}
                      fill="#23232a"
                      stroke={selected ? "#5fa8ff" : "#3e3e48"}
                      strokeWidth={selected ? 2 : 1}
                      // grab → grabbing cue. Port circles + foreignObject
                      // bodies sit on top of this rect in document order,
                      // so pointerdown on a port / input never reaches
                      // here — node drag and port drag are cleanly
                      // separated.
                      style={{ cursor: nodeDrag?.objectId === n.objectId ? "grabbing" : "grab" }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        const existing = nodeOffsets.get(n.objectId) ?? { dx: 0, dy: 0 };
                        setNodeDrag({
                          objectId: n.objectId,
                          startClientX: e.clientX,
                          startClientY: e.clientY,
                          initialOffsetX: existing.dx,
                          initialOffsetY: existing.dy,
                          movedPastThreshold: false,
                        });
                        try { (e.currentTarget as Element).setPointerCapture?.(e.pointerId); } catch {}
                      }}
                      onPointerMove={(e) => {
                        if (!nodeDrag || nodeDrag.objectId !== n.objectId) return;
                        const dx = e.clientX - nodeDrag.startClientX;
                        const dy = e.clientY - nodeDrag.startClientY;
                        const moved =
                          nodeDrag.movedPastThreshold ||
                          Math.abs(dx) > NODE_DRAG_THRESHOLD_PX ||
                          Math.abs(dy) > NODE_DRAG_THRESHOLD_PX;
                        if (!moved) return;
                        setNodeOffsets((prev) => {
                          const next = new Map(prev);
                          next.set(n.objectId, {
                            dx: nodeDrag.initialOffsetX + dx,
                            dy: nodeDrag.initialOffsetY + dy,
                          });
                          return next;
                        });
                        if (!nodeDrag.movedPastThreshold) {
                          setNodeDrag({ ...nodeDrag, movedPastThreshold: true });
                        }
                      }}
                      onPointerUp={(e) => {
                        if (!nodeDrag || nodeDrag.objectId !== n.objectId) {
                          setNodeDrag(null);
                          return;
                        }
                        try { (e.currentTarget as Element).releasePointerCapture?.(e.pointerId); } catch {}
                        if (!nodeDrag.movedPastThreshold) {
                          // Click semantics — no movement past the threshold.
                          selectObject(n.objectId);
                        } else {
                          // Persist the new resting position.
                          saveNodeOffsets(nodeOffsets);
                        }
                        setNodeDrag(null);
                      }}
                      onPointerCancel={() => setNodeDrag(null)}
                    />
                    {editingNameNodeId === n.objectId ? (
                      <foreignObject
                        x={pos.x + 8}
                        y={pos.y + 6}
                        width={Math.min(pos.w - 16, 180)}
                        height={20}
                      >
                        <input
                          autoFocus
                          type="text"
                          value={editingNameDraft}
                          onChange={(e) => setEditingNameDraft(e.target.value)}
                          onBlur={() => commitNodeRename(n.objectId, editingNameDraft)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            if (e.key === "Escape") setEditingNameNodeId(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          onPointerDown={(e) => e.stopPropagation()}
                          style={{
                            width: "100%",
                            background: "#1c1c22",
                            color: "#e8e8ee",
                            border: "1px solid #62a3ff",
                            borderRadius: 2,
                            padding: "1px 4px",
                            fontSize: 12,
                            fontWeight: 500,
                          }}
                        />
                      </foreignObject>
                    ) : (
                      <text
                        x={pos.x + 10}
                        y={pos.y + 18}
                        fontSize={12}
                        fill="#e8e8ee"
                        fontWeight={500}
                        style={{ cursor: "text" }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setEditingNameNodeId(n.objectId);
                          setEditingNameDraft(n.name);
                        }}
                      >
                        <title>Double-click to rename</title>
                        {n.name}
                      </text>
                    )}
                    {n.kind && (
                      <text
                        x={pos.x + pos.w - 8}
                        y={pos.y + 18}
                        fontSize={9}
                        fill="#8e8e9a"
                        textAnchor="end"
                        style={{ pointerEvents: "none" }}
                      >
                        {n.kind}
                      </text>
                    )}
                    <line
                      x1={pos.x}
                      y1={pos.y + NODE_HEADER_H - 1}
                      x2={pos.x + pos.w}
                      y2={pos.y + NODE_HEADER_H - 1}
                      stroke="#3e3e48"
                      strokeWidth={1}
                    />
                    {n.ports.map((port, i) => {
                      const rowY = pos.y + NODE_HEADER_H + i * PORT_ROW_H;
                      const cy = rowY + PORT_ROW_H / 2;
                      const cx = port.role === "in" ? pos.x : pos.x + pos.w;
                      const color = port.role === "in" ? "#62a3ff" : "#7be08a";

                      // Per-port body: editable for AD9959 rf_out, computed
                      // for AOM rf_in, fallback to plain text label.
                      let body: React.ReactNode;
                      if (isSource && port.role === "out") {
                        const entry = channelByPortKey.get(`${n.objectId}|${port.anchorName}`);
                        // Always show the editor on an rf_source rf_out;
                        // when the PhysicsElement was bootstrapped with
                        // `channels: null` (the dds_ad9959_pcb auto-create
                        // path hasn't seeded per-CH entries yet), synthesise
                        // a default channel here so the row stays editable.
                        // commitChannelEdit appends a real channels[] entry
                        // on first save.
                        const channel: DdsChannel = entry?.channel ?? {
                          channelIndex: 0,
                          anchorName: port.anchorName,
                          mode: "single_tone",
                          channelEnabled: true,
                          frequencyMhz: 80.0,
                          phaseDeg: 0.0,
                          amplitudeScale: 1.0,
                          sweep: null,
                          modulationLevels: 2,
                          profiles: null,
                        };
                        body = (
                          <EditableAd9959Row
                            port={port}
                            ownerObjectId={n.objectId}
                            channel={channel}
                            onCommit={(patch) => commitChannelEdit(n.objectId, port.anchorName, patch)}
                          />
                        );
                      } else if (aom && port.role === "in") {
                        const requiredP = aomRequiredPowerW(aom);
                        const requiredVpp = requiredP != null ? powerWToVpp(requiredP) : null;
                        // Pull the post-chain signal from the propagation map.
                        // It already includes any in-line amplifier gain
                        // (and saturation clamps), so the incoming reading
                        // matches what the Bragg solver / backend will see.
                        const signal = rfPropagation.signalAtPort.get(rfPortKey(n.objectId, port.anchorName)) as RfSignalState | undefined;
                        // Resolve the originating rf_source object name so
                        // the AOM row can show provenance ("← AD9959 · CH0").
                        const sourceObjectName = signal
                          ? objects.find((o) => o.id === signal.sourceObjectId)?.name ?? null
                          : null;
                        body = (
                          <AomInRow
                            port={port}
                            requiredVpp={requiredVpp}
                            incomingSignal={signal ?? null}
                            sourceObjectName={sourceObjectName}
                          />
                        );
                      } else if (amp) {
                        // Amplifier: show Vpp_in on rf_in and Vpp_out + gain
                        // badge on rf_out, both pulled from the propagation
                        // map. The map already applied this amp's gain at
                        // the rf_out key, so we just read it back.
                        const signal = rfPropagation.signalAtPort.get(rfPortKey(n.objectId, port.anchorName)) as RfSignalState | undefined;
                        if (port.role === "in") {
                          body = <AmpInRow port={port} incomingVpp={signal ? signal.vpp : null} />;
                        } else {
                          body = (
                            <AmpOutRow
                              port={port}
                              outgoingVpp={signal ? signal.vpp : null}
                              gainDb={amp.gainDb ?? 0}
                              saturated={signal ? signal.saturated : false}
                            />
                          );
                        }
                      }
                      const showPpgChannel =
                        isPpg && port.role === "out" && port.anchorId === "rf_out";
                      const channelSuffix = showPpgChannel
                        ? ` · CH${ppgCh != null ? ppgCh : "—"}`
                        : "";
                      const fallback = !body ? (
                        <text
                          x={port.role === "in" ? cx + PORT_R + 6 : cx - PORT_R - 6}
                          y={cy + 3}
                          fontSize={10}
                          fill="#cfcfd8"
                          textAnchor={port.role === "in" ? "start" : "end"}
                        >
                          {`${port.displayName} · ${port.connectorFamily?.toUpperCase() ?? "NO CONN"}${channelSuffix}`}
                        </text>
                      ) : null;

                      // While dragging, highlight valid drop targets (opposite
                      // role on a different object) so the user gets a clear
                      // visual when the cursor lands on a port they can connect.
                      // Occupied ports get a red ring during drag so the user
                      // can see at a glance which ports are already claimed.
                      const portFullKey = `${n.objectId}|${port.anchorId}|${port.anchorName}`;
                      const isPortOccupied = occupiedPortKeys.has(portFullKey);
                      // ttl_in / trigger_in input ports are the entry point
                      // for the right-click "Create Pulse & Timing here"
                      // shortcut — it spawns a fresh PPG (with its own
                      // TimingProgram) and an rf_cable to this port in one
                      // step. Only fires when the port has a defined
                      // connector family (sma|bnc) and is not already busy.
                      const canSpawnPpgHere =
                        port.role === "in" &&
                        (port.domain === "ttl" || port.domain === "trigger") &&
                        port.connectorFamily != null &&
                        !isPortOccupied;
                      const isDragSource =
                        drag &&
                        drag.srcObjectId === n.objectId &&
                        drag.srcAnchorId === port.anchorId &&
                        drag.srcAnchorName === port.anchorName;
                      const portHasConnector = port.connectorFamily !== null;
                      // Cross-family (SMA ↔ BNC) is fine — catalog has
                      // `rf_cable_sma_to_bnc`. Only block when one side has
                      // no defined connector at all.
                      const isValidDropTarget =
                        !!drag &&
                        !isDragSource &&
                        drag.srcObjectId !== n.objectId &&
                        drag.srcRole !== port.role &&
                        drag.srcDomain === port.domain &&
                        portHasConnector &&
                        !isPortOccupied;
                      const isBlockedDropTarget =
                        !!drag &&
                        !isDragSource &&
                        drag.srcObjectId !== n.objectId &&
                        drag.srcRole !== port.role &&
                        (!portHasConnector ||
                          drag.srcDomain !== port.domain ||
                          isPortOccupied);
                      // Render the foreignObject FIRST so the port circle
                      // stays on top — foreignObject's HTML content
                      // intercepts pointer events across its full bounding
                      // box on some renderers (headless WebKit, certain
                      // mobile browsers), which would otherwise eat the
                      // drag-source pointerdown and the drop-target
                      // elementFromPoint lookup.
                      return (
                        <g key={portKey(port) + "@" + i}>
                          {body && (
                            <foreignObject
                              x={pos.x}
                              y={rowY}
                              width={pos.w}
                              height={PORT_ROW_H}
                            >
                              {body}
                            </foreignObject>
                          )}
                          {fallback}
                          <circle
                            cx={cx}
                            cy={cy}
                            r={isValidDropTarget ? PORT_R + 2 : PORT_R}
                            fill={isBlockedDropTarget ? "#3e3e48" : color}
                            stroke={
                              isBlockedDropTarget
                                ? "#d96666"
                                : isValidDropTarget
                                  ? "#ffffff"
                                  : "#1c1c22"
                            }
                            strokeWidth={isValidDropTarget || isBlockedDropTarget ? 2 : 1}
                            data-rf-port-key={`${n.objectId}|${port.anchorId}|${port.anchorName}|${port.role}|${port.domain}|${port.connectorFamily ?? "none"}`}
                            data-rf-port-occupied={isPortOccupied || undefined}
                            style={{ cursor: isPortOccupied || !portHasConnector ? "not-allowed" : "crosshair", touchAction: "none" }}
                            onPointerDown={(e) => {
                              if (e.button !== 0) return;
                              if (!port.connectorFamily) return;
                              if (!svgRef.current) return;
                              e.preventDefault();
                              e.stopPropagation();
                              const rect = svgRef.current.getBoundingClientRect();
                              setDrag({
                                srcObjectId: n.objectId,
                                srcAnchorId: port.anchorId,
                                srcAnchorName: port.anchorName,
                                srcRole: port.role,
                                srcDomain: port.domain,
                                srcConnectorFamily: port.connectorFamily,
                                mouseX: e.clientX - rect.left,
                                mouseY: e.clientY - rect.top,
                                hoverPortKey: null,
                              });
                              try { svgRef.current.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
                            }}
                            onContextMenu={(e) => {
                              // Busy port → offer "Disconnect cable" so the
                              // user can clear the link without hunting
                              // for the rf_cable in the (now-hidden)
                              // Outliner. Empty ttl_in / trigger_in input →
                              // offer "Create Pulse & Timing program here".
                              // Other empty ports do nothing on right-click.
                              const cableObjectId = cableByPortKey.get(portFullKey);
                              if (cableObjectId) {
                                e.preventDefault();
                                e.stopPropagation();
                                const cable = objects.find((o) => o.id === cableObjectId);
                                setPortMenu({
                                  mode: "remove-cable",
                                  x: e.clientX,
                                  y: e.clientY,
                                  cableObjectId,
                                  cableName: cable?.name ?? "RF cable",
                                  portLabel: `${n.name} · ${port.displayName}`,
                                });
                                return;
                              }
                              if (!canSpawnPpgHere) return;
                              e.preventDefault();
                              e.stopPropagation();
                              setPortMenu({
                                mode: "create-ppg",
                                x: e.clientX,
                                y: e.clientY,
                                targetObjectId: n.objectId,
                                targetAnchorId: port.anchorId,
                                targetAnchorName: port.anchorName,
                                targetConnectorFamily: port.connectorFamily!,
                              });
                            }}
                          />
                        </g>
                      );
                    })}
                  </g>
                );
              })}
              {drag && (() => {
                // Rubber band from the drag source port to the cursor. The
                // source coord comes from the same portCoord helper used
                // for committed edges so the rubber band starts exactly
                // where future cable would land. The dash offset animates
                // continuously so the line reads as "in progress" instead
                // of a static guide.
                const srcKey = `${drag.srcAnchorId}|${drag.srcAnchorName}`;
                const srcCoord = portCoord(drag.srcObjectId, srcKey);
                if (!srcCoord) return null;
                const midX = (srcCoord.cx + drag.mouseX) / 2;
                const d = `M ${srcCoord.cx} ${srcCoord.cy} C ${midX} ${srcCoord.cy}, ${midX} ${drag.mouseY}, ${drag.mouseX} ${drag.mouseY}`;

                // Hint text near the cursor reflects what would happen if
                // the user released RIGHT NOW. Parsed from the live hover
                // port key — same field the pointerup handler uses for
                // its decision, so the user can never see "OK to connect"
                // and then have the commit silently no-op.
                let hint: { text: string; color: string } = {
                  text: "Drop on a port to connect",
                  color: "#bdbdc8",
                };
                if (drag.hoverPortKey) {
                  const [hObjId, hAnchorId, hAnchorName, hRole, hDomain, hConnector] = drag.hoverPortKey.split("|");
                  const targetFullKey = `${hObjId}|${hAnchorId}|${hAnchorName}`;
                  const targetObj = objects.find((o) => o.id === hObjId);
                  const sameObject = hObjId === drag.srcObjectId;
                  const sameRole = !hRole || hRole === drag.srcRole;
                  const busy = occupiedPortKeys.has(targetFullKey);
                  if (sameObject) {
                    hint = { text: "Same object", color: "#8e8e9a" };
                  } else if (sameRole) {
                    hint = { text: `Role mismatch (${hRole})`, color: "#d49a3a" };
                  } else if (hConnector === "none") {
                    hint = { text: "Connector undefined", color: "#d96666" };
                  } else if (hDomain !== drag.srcDomain) {
                    hint = { text: `Domain mismatch (${hDomain})`, color: "#d49a3a" };
                  } else if (hConnector !== drag.srcConnectorFamily) {
                    // Cross-family is allowed (sma_to_bnc cable variant
                    // exists in the catalog) — surface it as info, not a
                    // block. The cable picker decides which variant to use.
                    hint = {
                      text: `Cross-family (${drag.srcConnectorFamily?.toUpperCase()} → ${hConnector?.toUpperCase()}) — adapter cable`,
                      color: "#8acfff",
                    };
                  } else if (busy) {
                    hint = { text: "⛔ Port busy", color: "#d96666" };
                  } else {
                    hint = {
                      text: `→ ${targetObj?.name ?? hObjId} · ${hAnchorName}`,
                      color: "#7be08a",
                    };
                  }
                }
                const hintX = drag.mouseX + 12;
                const hintY = drag.mouseY - 8;
                const hintW = Math.max(120, hint.text.length * 6 + 16);
                return (
                  <g style={{ pointerEvents: "none" }}>
                    <path
                      d={d}
                      fill="none"
                      stroke="#5fa8ff"
                      strokeWidth={2}
                      strokeDasharray="6,4"
                      strokeLinecap="round"
                    >
                      <animate
                        attributeName="stroke-dashoffset"
                        from="0"
                        to="-20"
                        dur="0.6s"
                        repeatCount="indefinite"
                      />
                    </path>
                    <rect
                      x={hintX - 4}
                      y={hintY - 12}
                      width={hintW}
                      height={18}
                      rx={3}
                      ry={3}
                      fill="#0f0f14"
                      stroke="#3e3e48"
                      strokeWidth={1}
                      opacity={0.9}
                    />
                    <text
                      x={hintX + 4}
                      y={hintY + 1}
                      fontSize={11}
                      fill={hint.color}
                    >
                      {hint.text}
                    </text>
                  </g>
                );
              })()}
            </svg>
          </div>
        )}
        {dangling.length > 0 && (
          <div
            style={{
              padding: 8,
              background: "#1e1e24",
              borderRadius: 4,
              fontSize: 11,
              color: "#cfcfd8",
              borderLeft: "3px solid #d49a3a",
            }}
          >
            <div style={{ marginBottom: 4, color: "#d49a3a", fontWeight: 500 }}>
              Unrouted cables ({dangling.length})
            </div>
            {dangling.map((d) => (
              <div
                key={d.cableObjectId}
                style={{ cursor: "pointer", padding: "2px 0" }}
                onClick={() => selectObject(d.cableObjectId)}
              >
                {d.cableName}{" "}
                <span style={{ color: "#8e8e9a" }}>
                  ({d.endsLinked === 1 ? "one end free" : "both ends free"})
                </span>
              </div>
            ))}
          </div>
        )}
        <div style={{ fontSize: 10, color: "#6e6e7a", display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
          <span><span style={{ color: "#7be08a" }}>●</span> rf_out (editable / amp out)</span>
          <span><span style={{ color: "#62a3ff" }}>●</span> rf_in (computed Vpp)</span>
          <span>Amplifier rows show Vpp_in → +gain dB → Vpp_out (clamped at P_max).</span>
          <span>Drag a block to reposition · drag a port to create a cable.</span>
          <span>AD9959 full-scale ≈ {VPP_FULL_SCALE.toFixed(1)} Vpp @ 50 Ω · λ = {DEFAULT_LAMBDA_NM} nm for AOM req.</span>
          {nodeOffsets.size > 0 && (
            <button
              type="button"
              onClick={() => {
                setNodeOffsets(new Map());
                saveNodeOffsets(new Map());
              }}
              title="Clear manual block positions and snap everything back to the column layout"
              style={{
                marginLeft: "auto",
                background: "#23232a",
                color: "#cfcfd8",
                border: "1px solid #3e3e48",
                borderRadius: 3,
                padding: "2px 8px",
                fontSize: 10,
                cursor: "pointer",
              }}
            >
              Reset layout ({nodeOffsets.size})
            </button>
          )}
        </div>
      </div>
      {portMenu && (
        <>
          {/* Backdrop catches clicks anywhere else to dismiss the menu. */}
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 9998,
              cursor: "default",
            }}
            onClick={() => setPortMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setPortMenu(null);
            }}
          />
          <div
            style={{
              position: "fixed",
              left: portMenu.x,
              top: portMenu.y,
              zIndex: 9999,
              minWidth: 220,
              background: "#23232a",
              border: "1px solid #3e3e48",
              borderRadius: 4,
              boxShadow: "0 4px 14px rgba(0,0,0,0.45)",
              padding: 4,
              fontSize: 11,
              color: "#cfcfd8",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {portMenu.mode === "create-ppg" ? (
              <>
                <button
                  type="button"
                  disabled={ppgBusy}
                  onClick={() => void handleCreatePpgFromMenu()}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "6px 8px",
                    background: "transparent",
                    color: "#e8e8ee",
                    border: "none",
                    borderRadius: 3,
                    cursor: ppgBusy ? "wait" : "pointer",
                  }}
                  onMouseOver={(e) => (e.currentTarget.style.background = "#2e2e36")}
                  onMouseOut={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  {ppgBusy
                    ? "Adding..."
                    : "Create Pulse & Timing program here"}
                </button>
                <div
                  style={{
                    padding: "4px 8px",
                    color: "#8e8e9a",
                    fontSize: 10,
                    borderTop: "1px solid #3e3e48",
                    marginTop: 2,
                  }}
                >
                  connector: {portMenu.targetConnectorFamily.toUpperCase()} · auto-binds PPG ↔ program
                </div>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={ppgBusy}
                  onClick={() => void handleRemoveCableFromMenu()}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "6px 8px",
                    background: "transparent",
                    color: "#ff8f8f",
                    border: "none",
                    borderRadius: 3,
                    cursor: ppgBusy ? "wait" : "pointer",
                  }}
                  onMouseOver={(e) => (e.currentTarget.style.background = "#3a1f1f")}
                  onMouseOut={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  {ppgBusy ? "Removing..." : `Disconnect cable "${portMenu.cableName}"`}
                </button>
                <div
                  style={{
                    padding: "4px 8px",
                    color: "#8e8e9a",
                    fontSize: 10,
                    borderTop: "1px solid #3e3e48",
                    marginTop: 2,
                  }}
                >
                  attached at: {portMenu.portLabel}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </FloatingPanel>
  );
}
