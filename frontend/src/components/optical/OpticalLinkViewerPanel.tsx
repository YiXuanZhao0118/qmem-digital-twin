// Optical link viewer CHROME — the non-3D half of the "optical-link" viewer
// display mode.
//
// The 3D half is the main scene itself: since 2026-08-17 optical-link is a
// normal viewer mode (DigitalTwinViewer renders every component exactly as in
// "rendered" mode, ghosts the non-optical hardware, and draws the beam chain
// as Gaussian tubes + polarization markers via `optical/beamChain.ts`). This
// component only supplies the surrounding UI, laid over the canvas WITHOUT
// covering it:
//   - a collapsible left drawer with the OpticalSettingPanel for whichever
//     optic is selected (selection is the global one — click an optic in the
//     3D scene and the drawer follows),
//   - the link warnings strip (aperture clipping, λ out of spec, mode
//     mismatch), polled off the live trace,
//   - the inline beam scope, shown once the user clicks a beam segment (the
//     viewer's click handler publishes `scopeProbe`).
//
// It used to own a whole second Three.js viewport stacked on top of the main
// canvas, which is why the orientation gizmo drove a camera the user could not
// see and only the optics the beam happened to touch were drawn. All of that
// moved into the main viewer; the beam-tube / optic-surface builders live in
// `optical/beamChain.ts`.

import { useEffect, useMemo, useRef, useState } from "react";

import { useSceneStore } from "../../store/sceneStore";
import type {
  Asset3D,
  ComponentItem,
  PhysicsElement,
  SceneObject,
} from "../../types/digitalTwin";
import type { LinkTraceSegment } from "../../optical/beamChain";
import { opticalObjectIdSet } from "../../utils/opticalDomain";
import { BeamScopeContents } from "./BeamScopePanel";
import { OpticalSettingPanel } from "../physics/OpticalSettingPanel";

const EMITTER_KINDS: ReadonlySet<string> = new Set([
  "laser_source",
  "tapered_amplifier",
]);

// Inline beam-scope panel sizing. The panel is collapsible and its expanded
// height is user-draggable (top grip); the chosen height persists per browser.
// Min is 0 so the grip can be dragged all the way down to fully retract the
// body (leaving just the grip + header), not only down to a fixed floor.
const SCOPE_MIN_H = 0;
const SCOPE_DEFAULT_H = 300;
const SCOPE_H_KEY = "qmem-beam-scope-h";
function loadScopeHeight(): number {
  try {
    const raw = window.localStorage.getItem(SCOPE_H_KEY);
    const n = raw != null ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= SCOPE_MIN_H ? n : SCOPE_DEFAULT_H;
  } catch {
    return SCOPE_DEFAULT_H;
  }
}
function saveScopeHeight(h: number): void {
  try {
    window.localStorage.setItem(SCOPE_H_KEY, String(Math.round(h)));
  } catch {
    // ignore quota errors
  }
}

/** Clear-aperture RADIUS in mm for the optic the beam hit, or null when the
 *  optic doesn't define one (then no clipping warning is possible). */
function asset_anchor_apertureRadiusMm(
  el: PhysicsElement | undefined,
  asset: Asset3D | undefined,
): number | null {
  if (asset?.anchors) {
    for (const id of ["intercept_in", "intercept_face", "intercept_out", "optical_anchor"]) {
      const anchor = asset.anchors.find((a) => a.id === id);
      if (!anchor) continue;
      const shape = anchor.apertureShape
        ?? (anchor.apertureWidthMm != null && anchor.apertureHeightMm != null ? "rectangle" : "circle");
      if (shape === "circle") {
        if (typeof anchor.apertureMm === "number" && anchor.apertureMm > 0) {
          return anchor.apertureMm;
        }
      } else {
        const w = anchor.apertureWidthMm;
        const h = anchor.apertureHeightMm;
        if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) {
          return Math.min(w, h) / 2;
        }
      }
    }
  }
  // Legacy kindParams.clearApertureMm is a diameter convention (see
  // apertureCheck.ts: r = apMm / 2). Convert to radius.
  if (el) {
    const params = el.kindParams as Record<string, unknown>;
    const v = params.clearApertureMm;
    if (typeof v === "number" && v > 0) return v / 2;
  }
  return null;
}

/** Passive optical kinds — wavelengthRangeNm warning fires for these
 *  (a beam hitting an out-of-range coating / crystal will not behave as
 *  spec'd, but the solver/ray-tracer doesn't enforce it). Emitter +
 *  fiber-end kinds are excluded — their wavelength is the *source* of
 *  truth, not a constraint imposed on incoming light. */
const PASSIVE_OPTICAL_KINDS: ReadonlySet<string> = new Set([
  "mirror",
  "dichroic_mirror",
  "lens_biconvex",
  "lens_plano_convex",
  "lens_cylindrical",
  "waveplate",
  "polarizer",
  "beam_splitter",
  "isolator",
  "eom",
  "aom",
  "nonlinear_crystal",
  "saturable_absorber",
  "fiber_coupler",
  "fiber",
]);

/** Kinds whose beam acceptance is described by Gaussian modematching
 *  (TA seed mode, fiber MFD) rather than a hard clear aperture. The
 *  Clipping warning is suppressed for these — the matching mode-overlap
 *  warning is the right physical signal. PHY Editor likewise hides
 *  apertureMm for these via `showAperture={false}`. */
const MODEMATCHED_KINDS: ReadonlySet<string> = new Set([
  "laser_source",
  "tapered_amplifier",
  "fiber",
  "fiber_end",
]);

type LinkWarning = {
  key: string;
  kind: "aperture-too-small" | "wavelength-out-of-range" | "mode-mismatch";
  message: string;
};

/** Target Gaussian mode (1/e² waist radius in µm + a human label) the
 *  incoming beam should match for efficient coupling. TA seeds and
 *  fiber inputs are the canonical cases. Returns null for kinds whose
 *  mode acceptance isn't spec'd by a single Gaussian waist. */
function getModeMatchTarget(
  kind: string,
  kindParams: Record<string, unknown>,
  lookupParams?: (objectId: string) => Record<string, unknown> | null,
): { waistUm: number; label: string } | null {
  if (kind === "tapered_amplifier") {
    const x = kindParams.inputSpatialModeX as { waistUm?: number } | undefined;
    const y = kindParams.inputSpatialModeY as { waistUm?: number } | undefined;
    const wx = typeof x?.waistUm === "number" ? x.waistUm : null;
    const wy = typeof y?.waistUm === "number" ? y.waistUm : null;
    const w = wx != null && wy != null ? (wx + wy) / 2 : (wx ?? wy);
    if (w == null || w <= 0) return null;
    return { waistUm: w, label: "TA seed mode" };
  }
  if (kind === "fiber") {
    // Either end may be the input port. Use endA's MFD as the
    // approximation — symmetric patch cables (the default) have endA ==
    // endB, and asymmetric ones are rare. MFD = 2 × 1/e² waist radius.
    const endA = kindParams.endA as { modeFieldDiameterUm?: number } | undefined;
    const mfd = endA?.modeFieldDiameterUm;
    if (typeof mfd !== "number" || mfd <= 0) return null;
    return { waistUm: mfd / 2, label: "fiber MFD" };
  }
  if (kind === "fiber_end") {
    // Resolve MFD from the paired fiber body's per-end spec.
    const bodyId = kindParams.fiberBodyObjectId;
    const role = kindParams.endRole;
    if (typeof bodyId !== "string" || (role !== "A" && role !== "B") || !lookupParams) {
      return null;
    }
    const bodyParams = lookupParams(bodyId);
    if (!bodyParams) return null;
    const end = bodyParams[role === "A" ? "endA" : "endB"] as
      | { modeFieldDiameterUm?: number }
      | undefined;
    const mfd = end?.modeFieldDiameterUm;
    if (typeof mfd !== "number" || mfd <= 0) return null;
    return { waistUm: mfd / 2, label: `fiber MFD (end ${role})` };
  }
  return null;
}

/** Gaussian-to-Gaussian power overlap (same waist position, on-axis).
 *  η = 4 / (w1/w2 + w2/w1)²; ≤ 1. The actual physical coupling is also
 *  limited by tilt / transverse offset / waist-z mismatch, but waist-
 *  ratio overlap alone catches the most common misalignment (wrong
 *  focal length on the coupling lens). */
function gaussianOverlap(w1: number, w2: number): number {
  if (w1 <= 0 || w2 <= 0) return 0;
  const r = w1 / w2 + w2 / w1;
  return 4 / (r * r);
}

const MODE_MATCH_WARN_THRESHOLD = 0.8;

function computeLinkWarnings(
  segments: readonly LinkTraceSegment[],
  objects: readonly SceneObject[],
  components: readonly ComponentItem[],
  assets: readonly Asset3D[],
  physicsElements: readonly PhysicsElement[],
): LinkWarning[] {
  if (segments.length === 0) return [];
  const objectById = new Map(objects.map((o) => [o.id, o]));
  const componentById = new Map(components.map((c) => [c.id, c]));
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const elementByObjectId = new Map<string, PhysicsElement>();
  for (const el of physicsElements) elementByObjectId.set(el.objectId, el);
  const lookupParams = (objectId: string): Record<string, unknown> | null => {
    const e = elementByObjectId.get(objectId);
    return e ? ((e.kindParams ?? {}) as Record<string, unknown>) : null;
  };

  const out: LinkWarning[] = [];
  const seen = new Set<string>();
  for (const seg of segments) {
    if (!seg.hitObjectId) continue;
    const obj = objectById.get(seg.hitObjectId);
    if (!obj) continue;
    const comp = componentById.get(obj.componentId);
    const asset = comp?.asset3dId ? assetById.get(comp.asset3dId) : undefined;
    const el = elementByObjectId.get(seg.hitObjectId);
    const kind = el?.elementKind;

    // [1] Aperture: warn if clear-aperture radius < 3 × beam waist
    //     (1/e² radius). Standard no-clip guideline — at 3 × waist a
    //     Gaussian beam contains > 99.97% of its power. Modematched
    //     kinds (laser/TA/fiber) get the mode-overlap warning instead;
    //     no clear aperture is defined for them.
    const skipAperture = kind != null && MODEMATCHED_KINDS.has(kind);
    const apRadiusMm = skipAperture ? null : asset_anchor_apertureRadiusMm(el, asset);
    const waistEndMm = seg.waistAtEndUm / 1000;
    if (apRadiusMm != null && waistEndMm > 0 && apRadiusMm < 3 * waistEndMm) {
      const key = `ap|${seg.hitObjectId}|${seg.wavelengthNm}`;
      if (!seen.has(key)) {
        seen.add(key);
        const beamDiamMm = waistEndMm * 2;
        const apDiamMm = apRadiusMm * 2;
        out.push({
          key,
          kind: "aperture-too-small",
          message: `${obj.name}: aperture Ø ${apDiamMm.toFixed(2)} mm < 3× beam Ø ${(beamDiamMm * 3).toFixed(2)} mm (beam Ø ${beamDiamMm.toFixed(2)} mm)`,
        });
      }
    }

    // [2] Wavelength range: warn when beam λ is outside the passive
    //     optic's spec'd range.
    if (kind && PASSIVE_OPTICAL_KINDS.has(kind)) {
      const params = (el?.kindParams ?? {}) as { wavelengthRangeNm?: [number, number] };
      const range = params.wavelengthRangeNm;
      if (Array.isArray(range) && range.length === 2) {
        const [minNm, maxNm] = range;
        if (
          typeof minNm === "number" && typeof maxNm === "number"
          && (seg.wavelengthNm < minNm || seg.wavelengthNm > maxNm)
        ) {
          const key = `wl|${seg.hitObjectId}|${seg.wavelengthNm}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({
              key,
              kind: "wavelength-out-of-range",
              message: `${obj.name}: beam λ ${seg.wavelengthNm.toFixed(1)} nm outside spec [${minNm}, ${maxNm}] nm`,
            });
          }
        }
      }
    }

    // [3] Mode matching: warn when incoming beam waist mismatches the
    //     target's accepted Gaussian mode (TA seed input, fiber MFD)
    //     by more than the threshold. Uses the simple same-waist-z
    //     overlap formula η = 4 / (w_in/w_t + w_t/w_in)² — captures
    //     wrong-focal-length coupling lens, the dominant lab error.
    if (kind && el) {
      const target = getModeMatchTarget(
        kind,
        (el.kindParams ?? {}) as Record<string, unknown>,
        lookupParams,
      );
      if (target && seg.waistAtEndUm > 0) {
        const eta = gaussianOverlap(seg.waistAtEndUm, target.waistUm);
        if (eta < MODE_MATCH_WARN_THRESHOLD) {
          const key = `mm|${seg.hitObjectId}|${seg.wavelengthNm}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({
              key,
              kind: "mode-mismatch",
              message: `${obj.name}: mode overlap ${(eta * 100).toFixed(0)}% (beam waist ${seg.waistAtEndUm.toFixed(1)} µm vs ${target.label} ${target.waistUm.toFixed(1)} µm)`,
            });
          }
        }
      }
    }
  }
  return out;
}

function liveSegments(): LinkTraceSegment[] {
  return (window as unknown as { __rayTraceDebug?: LinkTraceSegment[] }).__rayTraceDebug ?? [];
}

export function OpticalLinkViewerContent() {
  const objects = useSceneStore((s) => s.scene.objects);
  const physicsElements = useSceneStore((s) => s.scene.physicsElements);
  const components = useSceneStore((s) => s.scene.components);
  const assets = useSceneStore((s) => s.scene.assets);
  const componentBindings = useSceneStore((s) => s.scene.componentBindings);
  const scopeProbe = useSceneStore((s) => s.scopeProbe);

  // Left drawer: every OPTICAL scene object is inspectable; the drawer follows
  // the global selection so clicking an optic in the 3D scene shows its
  // physics here.
  const opticalObjects = useMemo(() => {
    const opticalIds = opticalObjectIdSet({
      objects,
      components,
      physicsElements,
      componentBindings,
      assets,
    });
    return objects
      .filter((o) => opticalIds.has(o.id))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }, [objects, components, physicsElements, componentBindings, assets]);
  const [inspectObjectId, setInspectObjectId] = useState<string | null>(null);
  // Inspector is a collapsible LEFT drawer — default collapsed so the 3D view
  // is clear. Selecting an optic (or the edge tab) opens it.
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Inline beam-scope panel: collapsible (header chevron) + vertically
  // resizable (top grip). Height lives in a ref and is written straight to the
  // body element during a drag so pointermove doesn't churn React at 60 fps —
  // same idiom as useResizablePanes / DualViewerSplit. Persisted per browser.
  const [scopeCollapsed, setScopeCollapsed] = useState(false);
  const scopeBodyRef = useRef<HTMLDivElement | null>(null);
  const scopeHeightRef = useRef<number>(loadScopeHeight());
  const startScopeResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startH = scopeHeightRef.current;
    const onMove = (move: PointerEvent) => {
      // The grip rides the panel's TOP edge; dragging up grows it downward.
      const next = Math.max(
        SCOPE_MIN_H,
        Math.min(startH + (startY - move.clientY), window.innerHeight * 0.8),
      );
      scopeHeightRef.current = next;
      if (scopeBodyRef.current) scopeBodyRef.current.style.height = `${next}px`;
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      saveScopeHeight(scopeHeightRef.current);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };
  // Follow the global scene selection: selecting a different optic anywhere
  // (3D viewer, object list, …) re-points the Optical-setting inspector at it,
  // so its intrinsic spec + tunable coefficients refresh for that object. Only
  // syncs when the selected object IS an optic (non-optical selections leave the
  // last inspected optic in place rather than blanking the drawer).
  const selectedObjectId = useSceneStore((s) => s.selectedObjectId);
  useEffect(() => {
    if (selectedObjectId && opticalObjects.some((o) => o.id === selectedObjectId)) {
      setInspectObjectId(selectedObjectId);
      setDrawerOpen(true);
    }
  }, [selectedObjectId, opticalObjects]);

  // Keep the selection valid as the scene changes (default to the first optic).
  const effectiveInspectId =
    inspectObjectId && opticalObjects.some((o) => o.id === inspectObjectId)
      ? inspectObjectId
      : (opticalObjects[0]?.id ?? null);
  const inspectObject = opticalObjects.find((o) => o.id === effectiveInspectId) ?? null;
  const inspectComponent = inspectObject
    ? components.find((c) => c.id === inspectObject.componentId) ?? null
    : null;

  const noEmitters = useMemo(
    () => !physicsElements.some((el) => EMITTER_KINDS.has(el.elementKind)),
    [physicsElements],
  );

  // Aperture / wavelength-range / mode-match warnings derived from the live
  // trace segments. Polled at 250 ms (cheap; segments rarely change) because
  // `window.__rayTraceDebug` is published by the viewer's render effect, not
  // through the store. State-set only when the list actually changes so React
  // doesn't re-render at the polling rate.
  const [warnings, setWarnings] = useState<LinkWarning[]>([]);
  useEffect(() => {
    const sync = () => {
      const next = computeLinkWarnings(
        liveSegments(), objects, components, assets, physicsElements,
      );
      setWarnings((prev) => {
        if (prev.length !== next.length) return next;
        for (let i = 0; i < prev.length; i++) {
          if (prev[i].key !== next[i].key || prev[i].message !== next[i].message) return next;
        }
        return prev;
      });
    };
    sync();
    const id = window.setInterval(sync, 250);
    return () => window.clearInterval(id);
  }, [objects, components, assets, physicsElements]);

  // The scope appears once the user clicks a beam segment — the viewer's click
  // handler publishes `scopeProbe` (single click in this mode).
  const probeOnLiveBeam = scopeProbe != null;

  return (
    <div className="viewer-optical-link-chrome">
      {/* Optical-setting inspector — collapsible LEFT drawer. Default collapsed
          so the 3D view is clear; select an optic (or click the edge tab) to
          open it. The rail is nudged down so it clears the floating
          .viewer-toolbar at the viewport's top-left; the top-RIGHT stays free
          for the orientation gizmo. */}
      <div className="vol-drawer-rail">
        {drawerOpen && (
          <div className="vol-drawer">
            <div className="vol-drawer-title">
              <span className="vol-drawer-label">Optical setting</span>
              <span className="vol-drawer-name">{inspectObject?.name ?? "—"}</span>
            </div>
            {inspectObject && inspectComponent ? (
              <OpticalSettingPanel component={inspectComponent} sceneObject={inspectObject} />
            ) : (
              <p className="vol-empty">
                Click an optical element in the scene to edit its physics.
              </p>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => setDrawerOpen((o) => !o)}
          title={drawerOpen ? "Collapse optical setting" : "Optical setting"}
          className="vol-drawer-tab"
        >
          <span>{drawerOpen ? "‹" : "›"}</span>
          {!drawerOpen && <span className="vol-drawer-tab-label">Optical setting</span>}
        </button>
      </div>

      <div className="vol-bottom">
        {noEmitters && (
          <p className="vol-note">
            No laser sources or standalone tapered amplifiers in the scene.
          </p>
        )}
        {warnings.length > 0 && (
          <div className="vol-warnings">
            <div className="vol-warnings-head">
              ⚠ {warnings.length} link warning{warnings.length === 1 ? "" : "s"}
            </div>
            {warnings.map((w) => {
              const prefix =
                w.kind === "aperture-too-small"
                  ? "▸ Clipping: "
                  : w.kind === "wavelength-out-of-range"
                    ? "▸ λ range: "
                    : "▸ Mode match: ";
              return (
                <div key={w.key} className="vol-warning-row">
                  {prefix}
                  {w.message}
                </div>
              );
            })}
          </div>
        )}
        {probeOnLiveBeam && (
          <div className="vol-scope">
            {/* Top grip — drag up/down to resize (hidden while collapsed). */}
            {!scopeCollapsed && (
              <div onPointerDown={startScopeResize} title="Drag to resize" className="vol-scope-grip">
                <div className="vol-scope-grip-bar" />
              </div>
            )}
            {/* Header — title + collapse/expand toggle. */}
            <div
              onClick={() => setScopeCollapsed((c) => !c)}
              title={scopeCollapsed ? "Expand beam scope" : "Collapse beam scope"}
              className="vol-scope-header"
            >
              <span>Beam scope</span>
              <span>{scopeCollapsed ? "▸" : "▾"}</span>
            </div>
            {/* Body — drag-controlled height, scrolls internally. */}
            {!scopeCollapsed && (
              <div
                ref={scopeBodyRef}
                className="vol-scope-body"
                style={{ height: scopeHeightRef.current }}
              >
                <BeamScopeContents />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
