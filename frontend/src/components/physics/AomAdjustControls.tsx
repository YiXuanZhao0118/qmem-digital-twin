/**
 * AomAdjustControls — split out of PhysicsElementPanel.tsx
 * (god-file). 1100-line inspector for an AOM SceneObject:
 *
 *   - Bragg angle / centre frequency / drive power readouts
 *   - Acoustic axis + RF direction body-local frame editor
 *   - +/- diffraction order selector with traversal-sign math
 *   - Sideband intensity + diffraction efficiency readout
 *   - kindParams editor for AOM-specific physics fields
 *   - Per-object aperture editor (V2 anchor binding)
 *
 * Dependencies on AOM physics helpers (braggAngleRad,
 * diffractionEfficiency, sidebandIntensitiesOnBragg, etc.) live in
 * src/optical/kinds/aom/physics.ts. The frames helpers
 * (bodyLocalDirToThree, rotateLabDir) are in src/optical/frames.ts.
 * Pulling these as direct imports here (instead of through the
 * parent) keeps the file self-contained.
 */
import * as THREE from "three";
import { useEffect, useMemo, useState } from "react";

import { useSceneStore } from "../../store/sceneStore";
import type {
  ComponentItem,
  PhysicsElement,
  SceneObject,
} from "../../types/digitalTwin";
import {
  DEFAULT_STAGE1_MODE,
  DEFAULT_STAGE2_SIGN,
  aomBodyFrameBodyLocal,
  aomTraversalSignFromEntryPort,
  braggAngleRad,
  diffractionEfficiency,
  effectiveAomOrderForTraversal,
  expectedInputDotD2,
  phaseModulationDepth,
  resolveTraversalSign,
  sidebandIntensitiesOnBragg,
  type Stage1RotationMode,
  type Stage2SignConvention,
} from "../../optical/kinds/aom/physics";
import {
  bodyLocalDirToThree,
  labDirToThree,
  rotateLabDir,
  threeToLabPointMm,
} from "../../optical/frames";
import {
  getEffectiveApertureMm,
  getRfDirectionBodyLocal,
} from "../../utils/v2Bindings";
import { resolveAomRfDriveFromScene } from "../../utils/aomRfDrive";
import { wavelengthToColor } from "../../three/opticalBeams";

function wavelengthHex(wavelengthNm: number): string {
  return `#${wavelengthToColor(wavelengthNm).getHexString()}`;
}

export function AomAdjustControls({
  sceneObject,
  element,
}: {
  sceneObject: SceneObject;
  element: PhysicsElement;
}) {
  const upsertOpticalElement = useSceneStore((state) => state.upsertOpticalElement);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  const scene = useSceneStore((state) => state.scene);

  const params = (element.kindParams ?? {}) as {
    // Phase B: centerFreqMhz / rfDrivePowerW were removed from AOMParams.
    // The panel resolves them live from the upstream rf_source via
    // `resolveAomRfDriveFromScene` and overlays them onto `physicsParams`
    // (constructed below) for the physics formulas.
    acousticVelocityMPerS?: number;
    refractiveIndex?: number;
    baseEfficiency?: number;
    figureOfMeritM2?: number;
    crystalLengthMm?: number;
    acousticBeamWidthMm?: number;
    rfPowerMaxW?: number;
    diffractionOrder?: number;
    // Phase 5: new frame-suffixed names; legacy names kept for read
    // compat across un-migrated rows.
    acousticAxisBodyLocal?: number[];
    acousticAxisLocal?: number[];
    rfPropagationDirectionBodyLocal?: number[];
    rfPropagationDirectionLocal?: number[];
    braggAngularAcceptanceMrad?: number;
    maxDiffractionOrder?: number;
    sidebandVisibilityThreshold?: number;
    braggTiltAxisDegLab?: number;
    braggTiltAxisAngleDeg?: number;  // legacy
    /** Phase 7 (AOM align rewrite): optional override for the body-local
     *  pivot used by the Bragg rotation. Defaults to the midpoint of
     *  the asset's intercept_in / intercept_out anchors. */
    braggInteractionPointMmBodyLocal?: number[] | null;
    /** Phase 7.4 align rewrite: how Stage 1 pins the rotation about
     *  beam direction (the only DoF left after the Bragg constraint
     *  beam·D2 = sin θ_B is imposed). See physics.ts for the modes. */
    stage1RotationMode?: Stage1RotationMode;
    /** Phase 7.4 align rewrite: whether the user-selected order m maps
     *  to the same physical lab side regardless of state ("lab-fixed"),
     *  or flips with state-B traversal ("physical-traversal"). */
    stage2SignConvention?: Stage2SignConvention;
  };
  // (Phase 7.1) `braggTiltAxisDegLab` legacy field reading removed —
  // align now derives the tilt axis from b̂_world × â_world. Schema
  // field is kept for backward compat with stored data but no longer
  // consulted by either UI or align.
  const componentRef = scene.components.find((c) => c.id === sceneObject.componentId);
  const compProps = (componentRef?.properties ?? {}) as { wavelengthRangeNm?: number[] };

  // Phase B (RF link single-source-of-truth): the AOM's centerFreqMhz and
  // rfDrivePowerW are no longer stored on the AOM. They are resolved live
  // from the upstream rf_source channel via the rf_cable link. The
  // resolver mirrors `hydrate_aom_rf_drive` in optics_seq.py so the panel
  // shows exactly what the backend solver will see.
  const upstreamDrive = useMemo(
    () => resolveAomRfDriveFromScene(
      sceneObject.id,
      scene.objects,
      scene.components,
      scene.assets,
      scene.physicsElements,
    ),
    [scene.objects, scene.components, scene.assets, scene.physicsElements, sceneObject.id],
  );
  const upstreamRf = useMemo<{ sourceName: string; channelName: string } | null>(() => {
    if (!upstreamDrive) return null;
    const srcObj = scene.objects.find((o) => o.id === upstreamDrive.sourceObjectId);
    return {
      sourceName: srcObj?.name ?? "rf_source",
      channelName: upstreamDrive.sourceAnchorName,
    };
  }, [upstreamDrive, scene.objects]);
  // Effective params overlay: physics formulas below still expect
  // `centerFreqMhz` / `rfDrivePowerW` on the params object. Inject the
  // resolved live values so braggAngleRad / diffractionEfficiency /
  // phaseModulationDepth all see the upstream-derived values without any
  // signature changes. Falls through to defaults when orphan.
  const effectiveCenterFreqMhz = upstreamDrive?.frequencyMhz ?? 80;
  const effectiveRfDrivePowerW = upstreamDrive
    ? Math.min(upstreamDrive.drivePowerW, params.rfPowerMaxW ?? Number.POSITIVE_INFINITY)
    : undefined;
  const physicsParams = {
    ...params,
    centerFreqMhz: effectiveCenterFreqMhz,
    rfDrivePowerW: effectiveRfDrivePowerW,
  } as typeof params & { centerFreqMhz: number; rfDrivePowerW?: number };
  const wavelengthForAngleNm = (() => {
    const range = compProps.wavelengthRangeNm;
    if (Array.isArray(range) && range.length === 2) {
      return (range[0] + range[1]) / 2;
    }
    return 780;
  })();

  // Phase 7: physics formulas live in optical/kinds/aom/physics.ts. The
  // panel computes the on-Bragg case at the rated mid-band so the user
  // sees the operating-point of the AOM; the ray-tracer applies the
  // same formulas plus an off-Bragg `braggAngularFactor` per actual
  // beam direction. Single source = panel ↔ scene cannot disagree.
  const thetaBRad = braggAngleRad(physicsParams, wavelengthForAngleNm);
  const thetaBMrad = thetaBRad * 1e3;
  const efficiencyEst = diffractionEfficiency(physicsParams, wavelengthForAngleNm, thetaBRad);
  const phaseModDepth = phaseModulationDepth(
    physicsParams, wavelengthForAngleNm, thetaBRad, efficiencyEst,
  );

  const orderRaw = params.diffractionOrder;
  const currentOrder: -1 | 0 | 1 =
    orderRaw === 0 ? 0 : orderRaw === -1 ? -1 : 1;
  const braggAcceptanceMrad = params.braggAngularAcceptanceMrad ?? 2.0;
  // 2026-05-10: RF direction now lives on the Asset3D as `rf_direction`
  // anchor; the helper falls back to legacy kindParams keys for
  // un-migrated rows.
  const _assetForRf = (() => {
    const c = scene.components.find((cc) => cc.id === sceneObject.componentId);
    return c?.asset3dId ? scene.assets.find((aa) => aa.id === c.asset3dId) ?? null : null;
  })();
  const _rfDir = getRfDirectionBodyLocal(_assetForRf, params as Record<string, unknown>)
    ?? { x: -1, y: 0, z: 0 };
  const rfDirectionLocal = [_rfDir.x, _rfDir.y, _rfDir.z];
  const opticalCarrierThz = 299_792_458 / (wavelengthForAngleNm * 1e-9) / 1e12;
  const maxDiffractionOrder = Math.max(1, Math.min(10, Math.round(params.maxDiffractionOrder ?? 3)));
  const sidebandVisibilityThreshold = Math.max(0, Math.min(1, params.sidebandVisibilityThreshold ?? 0.01));

  const intensityByOrder = sidebandIntensitiesOnBragg(
    currentOrder, efficiencyEst, phaseModDepth, maxDiffractionOrder,
  );
  const zerothIntensity = intensityByOrder.get(0)!;
  const selectedFirstOrderIntensity = currentOrder === 0 ? 0 : efficiencyEst;

  const orders: number[] = [];
  for (let nn = -maxDiffractionOrder; nn <= maxDiffractionOrder; nn++) orders.push(nn);

  const sidebandRows: Array<{
    order: number;
    angleMrad: number;
    frequencyOffsetMhz: number;
    centerFrequencyThz: number;
    intensity: number;
    matched: boolean;
    visible: boolean; // would the ray-tracer draw it?
  }> = orders.map((order) => {
    const intensity = intensityByOrder.get(order) ?? 0;
    const matched = order === currentOrder;
    const alwaysShow = order === 0 || order === currentOrder;
    return {
      order,
      // Convention (2026-05-11 datasheet match): each order m sits at
      // m·2·θ_B from the input (the full Bragg deflection angle, equal
      // to m·λ·f/v in air; matches AA Opto MT80 datasheet's `Δθ = λF/V`).
      // θ_B here is the EXTERNAL (lab-frame) Bragg half-angle returned
      // by physics.ts braggAngleRad — see `physics.ts` for the convention.
      angleMrad: order === 0 ? 0 : order * 2 * thetaBMrad,
      frequencyOffsetMhz: order * effectiveCenterFreqMhz,
      centerFrequencyThz: opticalCarrierThz + order * effectiveCenterFreqMhz * 1e-6,
      intensity,
      matched,
      visible: alwaysShow || intensity >= sidebandVisibilityThreshold,
    };
  });

  const persist = async (patch: Record<string, unknown>) => {
    await upsertOpticalElement({
      objectId: sceneObject.id,
      elementKind: element.elementKind,
      kindParams: { ...params, ...patch },
      inputPorts: element.inputPorts,
      outputPorts: element.outputPorts,
    });
  };

  const setOrder = (order: -1 | 0 | 1) => {
    if (order === currentOrder) return;
    void persist({ diffractionOrder: order });
  };

  // (Removed in Phase 7) The "Flip RF" control is intentionally absent.
  // With braggTiltAxisDegLab defining the rotation plane and
  // diffractionOrder ∈ {-1, 0, +1} selecting which side of that plane
  // the diffracted ray emerges, the ±1 geometry is fully determined.
  // Flipping `acousticAxisBodyLocal` was a redundant second path to
  // the same swap (it negates the dot in the Bragg constraint, which
  // is equivalent to flipping orderSign). Keeping both knobs let users
  // accidentally set inconsistent state. The acoustic axis is now
  // treated as fixed asset metadata (MT80 default body -X, transducer
  // -> absorber); to swap which side gets +1, change the order radio
  // instead.

  // RF drive power slider — η depends on it via the closed-form sin².
  // RF drive power is committed via the NumberCell in the RF Settings
  // block (top of the AOM panel). The old text-input row with rfDraft/
  // commitRfPower local state was removed when RF settings were split
  // out — keeping the rfMax cap so the NumberCell onCommit can clamp.
  const rfMax = params.rfPowerMaxW ?? 2.0;

  // Phase B: RF drive power is no longer stored on the AOM. "Max η"
  // now simply pegs the baseEfficiency override at 0.99 — the user
  // selects the actual drive level in the RF link panel (AD9959 CH Vpp).
  // The closed-form rfPowerForPeakEfficiencyW remains available for
  // panel readouts but the button no longer writes to a removed field.
  const maximiseEfficiency = () => {
    void persist({ baseEfficiency: 0.99 });
  };

  // Align the AOM body to the upstream beam in two stages, sharing a
  // single Bragg sign convention with rayTrace.ts via the helpers in
  // optical/kinds/aom/physics.ts (`expectedInputDotD2`,
  // `diffractedDirection`).
  //
  // Anchor contract (Phase 7.4 rewrite — vibe-coding-log 2026-05-08):
  //
  //   - Asset MUST declare both `intercept_in` and `intercept_out`
  //     anchors with `apertureMm` set. Migration 0021 backfills these.
  //
  //   - Body frame: D1 = unit(intercept_out − intercept_in)  (optical
  //     axis), D2 = rfPropagationDirectionBodyLocal (acoustic / RFin
  //     axis), D3 = D1 × D2 (Bragg rotation axis). For canonical MT80:
  //     D1 = body+Y, D2 = body−X, D3 = body+Z.
  //
  //   - Entry port: whichever of intercept_in / intercept_out the
  //     upstream beam reaches first geometrically. Reported in the
  //     feedback as "entry=in" or "entry=out". This used to flip the
  //     body 180° via `traversalSignRaw` (the old state-A/state-B
  //     dichotomy); since 2026-05-15 it only affects the diffraction-
  //     order label (via `effectiveAomOrderForTraversal` /
  //     `traversalSignForExpect`), not the body orientation.
  //
  //   - Stage 1 (snap optical axis ∥ beam): pick D1_target = s·beam
  //     where s = sign(D1_current · beam) — minimum rotation from
  //     current pose, never a 180° flip. D3_target by
  //     `params.stage1RotationMode` (default "min-rot"):
  //       "min-rot"  — D3_target = projection of D3_current onto ⊥-beam
  //                    (matches the user's 3-step decomposition: rotate
  //                    around D3 to bring beam into (D1,D3) plane, then
  //                    rotate around D2 to put D1 on beam).
  //       "upright"  — D3 closest to lab+Z (forces AOM upright on a
  //                    horizontal table; can rotate the body more than
  //                    necessary if it started in a non-upright pose).
  //       "keep-d2"  — D2 closest to its current lab direction.
  //     D2_target = D3_target × D1_target (right-handed).
  //
  //   - Stage 2 (Bragg rotation): rotate body about D3_target by
  //       ω = −s · arcsin(expectedInputDotD2(...))
  //     so beam·D2_body lands on the value `physics.ts` derives from
  //     the user-selected order m and `params.stage2SignConvention`.
  //
  //   - Pivot for Stage 2: midpoint of in/out anchors (or
  //     `kindParams.braggInteractionPointMmBodyLocal` override). Pivot
  //     only matters for the "rock around interaction point" UX feel;
  //     the final pose is determined by orientation + midpoint-on-beam
  //     translation, which makes the math pivot-independent.
  //
  //   - Translation: project the (in+out)/2 midpoint onto the beam ray.
  const [alignBusy, setAlignBusy] = useState(false);
  const [alignFeedback, setAlignFeedback] = useState<string | null>(null);

  const ALIGN_TOLERANCE_MM = 25;

  const alignToLaser = async () => {
    setAlignBusy(true);
    setAlignFeedback(null);
    try {
      // [1] Locate Asset3D and validate the anchor contract.
      const componentRow = scene.components.find((c) => c.id === sceneObject.componentId);
      const assetRow = componentRow?.asset3dId
        ? scene.assets.find((a) => a.id === componentRow.asset3dId)
        : undefined;
      if (!componentRow) {
        setAlignFeedback("AOM Component row not found in scene store.");
        return;
      }
      if (!assetRow) {
        setAlignFeedback(
          "AOM has no Asset3D — open PHY Editor → Optical → optical_component to assign or define anchors.",
        );
        return;
      }
      const inAnchor = assetRow.anchors.find((a) => a.id === "intercept_in");
      const outAnchor = assetRow.anchors.find((a) => a.id === "intercept_out");
      const missing: string[] = [];
      if (!inAnchor) missing.push("intercept_in");
      if (!outAnchor) missing.push("intercept_out");
      if (missing.length) {
        setAlignFeedback(
          `AOM asset ${assetRow.name} is missing ${missing.join(" and ")}. ` +
          "Open PHY Editor → Optical → optical_component and add the port anchor(s).",
        );
        return;
      }
      // Asset-level aperture only (PHY Editor → Optical → Components).
      const inEffAp = getEffectiveApertureMm(sceneObject, inAnchor!, "intercept_in");
      const outEffAp = getEffectiveApertureMm(sceneObject, outAnchor!, "intercept_out");
      if (inEffAp == null || inEffAp <= 0) missing.push("intercept_in.aperture");
      if (outEffAp == null || outEffAp <= 0) missing.push("intercept_out.aperture");
      if (missing.length) {
        setAlignFeedback(
          `AOM ${sceneObject.name} has anchor(s) without aperture: ${missing.join(", ")}. ` +
          "Set apertureMm in PHY Editor → Optical → Components before aligning.",
        );
        return;
      }

      // [2] Body-local D1/D2/D3 from anchors + RF direction.
      const inBody = inAnchor!.positionMmBodyLocal;
      const outBody = outAnchor!.positionMmBodyLocal;
      const rfBody = {
        x: rfDirectionLocal[0],
        y: rfDirectionLocal[1],
        z: rfDirectionLocal[2],
      };
      const bodyFrame = aomBodyFrameBodyLocal(inBody, outBody, rfBody);
      if (!bodyFrame) {
        setAlignFeedback(
          "Cannot derive D1/D2/D3 from this asset — in/out anchors coincide " +
          "or RF direction is parallel/zero. Open PHY Editor and fix.",
        );
        return;
      }
      const D1Body = bodyFrame.D1;
      const D2Body = bodyFrame.D2;
      const D3Body = bodyFrame.D3;

      // [3] Current world-frame anchor positions (for upstream-beam search).
      const bodyToLab = (bodyMm: { x: number; y: number; z: number }) => {
        const rotated = rotateLabDir(bodyMm, sceneObject);
        return {
          x: sceneObject.xMm + rotated.x,
          y: sceneObject.yMm + rotated.y,
          z: sceneObject.zMm + rotated.z,
        };
      };
      const inLab = bodyToLab(inBody);
      const outLab = bodyToLab(outBody);

      // [4] Walk live ray-trace segments, pick the upstream beam whose
      //     closest-approach hits one of the AOM anchors. Beam-first
      //     (smaller forward t) wins as the entry port.
      type TraceSeg = {
        sourceObjectId: string;
        startThree: { x: number; y: number; z: number };
        endThree: { x: number; y: number; z: number };
        hitObjectId?: string | null;
      };
      const traces: TraceSeg[] = (typeof window !== "undefined"
        ? (window as unknown as { __rayTraceDebug?: TraceSeg[] }).__rayTraceDebug
        : undefined) ?? [];
      type Match = {
        portId: "intercept_in" | "intercept_out";
        entryBody: { x: number; y: number; z: number };
        entryT: number;
        otherT: number;
        closest: { x: number; y: number; z: number };
        dir: { x: number; y: number; z: number };
        miss: number;
        otherMiss: number;
        sourceId: string;
      };
      let best: Match | null = null;
      for (const seg of traces) {
        if (seg.sourceObjectId === sceneObject.id) continue;
        const a = threeToLabPointMm(seg.startThree);
        const b = threeToLabPointMm(seg.endThree);
        const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
        const lenSq = ab.x ** 2 + ab.y ** 2 + ab.z ** 2;
        if (lenSq < 1e-6) continue;
        const segLen = Math.sqrt(lenSq);
        const dir = { x: ab.x / segLen, y: ab.y / segLen, z: ab.z / segLen };
        const projects = (
          [inLab, outLab] as { x: number; y: number; z: number }[]
        ).map((p) => {
          const t = (p.x - a.x) * dir.x + (p.y - a.y) * dir.y + (p.z - a.z) * dir.z;
          const closest = { x: a.x + dir.x * t, y: a.y + dir.y * t, z: a.z + dir.z * t };
          const miss = Math.hypot(p.x - closest.x, p.y - closest.y, p.z - closest.z);
          return { t, closest, miss };
        });
        const [pIn, pOut] = projects;
        if (pIn.t < 0 && pOut.t < 0) continue;

        // Segment upper bound: a beam that terminates at another component
        // (seg.hitObjectId != null) doesn't extend past its endpoint.
        // Without this check, a stale upstream beam segment that happens to
        // be collinear with the AOM anchor's current world position will
        // produce miss ≈ 0 and beat the real reaching beam (which has miss
        // = a few mm because the AOM isn't perfectly aligned yet). Allow a
        // tolerance equal to ALIGN_TOLERANCE_MM so a beam that ends exactly
        // at the AOM still matches. Unbounded beams (hitObjectId == null)
        // pass through with no upper bound.
        const segUpperBound = seg.hitObjectId != null
          ? segLen + ALIGN_TOLERANCE_MM
          : Number.POSITIVE_INFINITY;

        const candidates: Array<Match> = [];
        if (pIn.miss <= ALIGN_TOLERANCE_MM && pIn.t >= 0 && pIn.t <= segUpperBound) {
          candidates.push({
            portId: "intercept_in",
            entryBody: { ...inBody },
            entryT: pIn.t,
            otherT: pOut.t,
            closest: pIn.closest,
            dir,
            miss: pIn.miss,
            otherMiss: pOut.miss,
            sourceId: seg.sourceObjectId,
          });
        }
        if (pOut.miss <= ALIGN_TOLERANCE_MM && pOut.t >= 0 && pOut.t <= segUpperBound) {
          candidates.push({
            portId: "intercept_out",
            entryBody: { ...outBody },
            entryT: pOut.t,
            otherT: pIn.t,
            closest: pOut.closest,
            dir,
            miss: pOut.miss,
            otherMiss: pIn.miss,
            sourceId: seg.sourceObjectId,
          });
        }
        candidates.sort((m1, m2) => m1.entryT - m2.entryT);
        const local = candidates[0];
        if (!local) continue;
        if (!best || local.miss < best.miss || (local.miss === best.miss && local.entryT < best.entryT)) {
          best = local;
        }
      }
      if (!best) {
        setAlignFeedback(
          `No upstream beam reaches either AOM port within ${ALIGN_TOLERANCE_MM} mm. ` +
          "Rotate the AOM toward the desired beam first, or check the upstream chain is emitting.",
        );
        return;
      }

      // [5] Ambiguity guard — AOM nearly perpendicular to beam.
      // V2: use the effective per-object aperture (already validated > 0
      // on entry above).
      const entryAp = best.portId === "intercept_in" ? inEffAp! : outEffAp!;
      const apertureDiamMm = 2 * entryAp;
      if (
        best.otherMiss <= ALIGN_TOLERANCE_MM &&
        best.otherT >= 0 &&
        Math.abs(best.entryT - best.otherT) < apertureDiamMm
      ) {
        setAlignFeedback(
          "AOM is nearly perpendicular to the beam — both ports are within one aperture of the same point on the beam. " +
          "Rotate the body manually first so the beam clearly enters one port and exits the other.",
        );
        return;
      }

      // [6] State (A/B). traversalSignRaw is the *physical* state; what
      //     we feed to expectedInputDotD2 may be over-ridden by the
      //     "lab-fixed" stage-2 sign convention.
      const traversalSignRaw = aomTraversalSignFromEntryPort(best.portId);
      const stage2SignConvention = params.stage2SignConvention ?? DEFAULT_STAGE2_SIGN;
      const traversalSignForExpect = resolveTraversalSign(traversalSignRaw, stage2SignConvention);
      const effectiveOrder = effectiveAomOrderForTraversal(currentOrder, traversalSignRaw);
      const isStateB = traversalSignRaw < 0;

      // ─────────────────────────────────────────────────────────────────
      // Three-step alignment (user's decomposition, 2026-05-11):
      //   Step A: translate (in+out)/2 onto the beam line
      //   Step B: rotate so D1·beam = cos(θ_corr) where θ_corr = ±θ_B
      //   Step C: spin around D3 so beam stays in the (D1, D2) plane
      //           (i.e. beam·D3 = 0 and the in/out anchors track the beam)
      //
      // Stage 1 + Stage 2 + entry-anchor translation (the previous
      // implementation) decomposed the same final pose into "D1∥beam,
      // then tilt by θ_B about D3, then translate entry to beam". The
      // new implementation arrives at the same target geometry directly:
      //
      //   D3_target_lab = projection of (lab axis or current D3) onto
      //                   the plane perpendicular to beam — Step C
      //   D1_target_lab = s·cos(θ_B)·beam + m·s'·sin(θ_B)·(D3_target × beam)
      //                   — Step B (s = traversalSignRaw, s' = traversalSignForExpect)
      //   D2_target_lab = D3_target × D1_target (right-handed triad)
      //   pos_new       = midpoint_foot − R_new · midpoint_body — Step A
      //
      // The D1_target formula is derived from the Bragg condition
      //   beam · D2 = expectedInputDotD2(m, s', θ_B) = −m·s'·sin(θ_B)
      // combined with beam · D1 = s·cos(θ_B), beam · D3 = 0. Verified by
      // the residual check below: |arcsin(beam·D2_new) − arcsin(expected)| < 1 mrad.
      // ─────────────────────────────────────────────────────────────────
      const beamUnit = best.dir;
      const cross3 = (
        a: { x: number; y: number; z: number },
        b: { x: number; y: number; z: number },
      ) => ({
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x,
      });
      const projectOntoPerp = (
        v: { x: number; y: number; z: number },
        unitN: { x: number; y: number; z: number },
      ): { x: number; y: number; z: number } | null => {
        const dot = v.x * unitN.x + v.y * unitN.y + v.z * unitN.z;
        const proj = {
          x: v.x - dot * unitN.x,
          y: v.y - dot * unitN.y,
          z: v.z - dot * unitN.z,
        };
        const m = Math.hypot(proj.x, proj.y, proj.z);
        return m > 1e-6 ? { x: proj.x / m, y: proj.y / m, z: proj.z / m } : null;
      };

      // Step C: pick D3_target perpendicular to beam. `stage1RotationMode`
      //   keeps the same UI semantics as before — it now decides which
      //   reference axis to project onto ⊥-beam to get D3:
      //     "upright"  → D3 ≈ projection of lab+Z (chassis vertical)
      //     "min-rot"  → D3 ≈ projection of current D3_lab (least disturbance)
      //     "keep-d2"  → D3 = current_D2_lab × beam (preserves acoustic-axis side)
      const D1WorldCurrent = rotateLabDir(D1Body, sceneObject);
      const D2WorldCurrent = rotateLabDir(D2Body, sceneObject);
      const D3WorldCurrent = rotateLabDir(D3Body, sceneObject);
      const stage1Mode: Stage1RotationMode = params.stage1RotationMode ?? DEFAULT_STAGE1_MODE;
      let D3TargetLab: { x: number; y: number; z: number } | null = null;
      if (stage1Mode === "min-rot") {
        D3TargetLab =
          projectOntoPerp(D3WorldCurrent, beamUnit) ??
          projectOntoPerp({ x: 0, y: 0, z: 1 }, beamUnit) ??
          projectOntoPerp({ x: 0, y: 1, z: 0 }, beamUnit) ??
          projectOntoPerp({ x: 1, y: 0, z: 0 }, beamUnit);
      } else if (stage1Mode === "keep-d2") {
        // D3 such that current D2 stays on the same side: D3 = unit(D2 × beam).
        const raw = cross3(D2WorldCurrent, beamUnit);
        const mag = Math.hypot(raw.x, raw.y, raw.z);
        D3TargetLab =
          mag > 1e-6
            ? { x: raw.x / mag, y: raw.y / mag, z: raw.z / mag }
            : projectOntoPerp({ x: 0, y: 0, z: 1 }, beamUnit) ??
              projectOntoPerp({ x: 0, y: 1, z: 0 }, beamUnit) ??
              projectOntoPerp({ x: 1, y: 0, z: 0 }, beamUnit);
      } else {
        // "upright" (default)
        D3TargetLab =
          projectOntoPerp({ x: 0, y: 0, z: 1 }, beamUnit) ??
          projectOntoPerp({ x: 0, y: 1, z: 0 }, beamUnit) ??
          projectOntoPerp({ x: 1, y: 0, z: 0 }, beamUnit);
      }
      if (!D3TargetLab) {
        setAlignFeedback(
          "Cannot pick D3 perpendicular to beam — beam direction degenerate against all reference axes. " +
          "Rotate the AOM manually first or move the upstream beam off the lab-Z axis.",
        );
        return;
      }

      // Step B: derive D1_target and D2_target in lab from the Bragg
      // condition. e2 = D3_target × beam is the unit perpendicular to
      // beam in the (D1, D2) plane.
      const e2 = cross3(D3TargetLab, beamUnit);
      const cosT = Math.cos(thetaBRad);
      const sinT = Math.sin(thetaBRad);
      // s = sign(D1_current · beam): pick D1_target ∥ +beam or −beam
      // by minimum rotation, NOT by which port reaches the beam first
      // (2026-05-15 fix). The old code used `traversalSignRaw` here,
      // which forced a 180° body flip whenever state B was detected
      // (entry = intercept_out) — even though the AOM is bidirectional
      // and the body orientation does not need to flip. The "in" vs
      // "out" entry distinction is preserved for diffraction-order
      // labeling via `traversalSignForExpect` / `effectiveOrder`.
      // s' = traversalSignForExpect (lab-fixed convention may set this
      //      to +1 always; physical-traversal mirrors traversalSignRaw).
      const dotD1Beam =
        D1WorldCurrent.x * beamUnit.x +
        D1WorldCurrent.y * beamUnit.y +
        D1WorldCurrent.z * beamUnit.z;
      const sRaw: 1 | -1 = dotD1Beam >= 0 ? 1 : -1;
      const sExpect = traversalSignForExpect;
      const D1TargetLab = {
        x: sRaw * cosT * beamUnit.x + currentOrder * sExpect * sinT * e2.x,
        y: sRaw * cosT * beamUnit.y + currentOrder * sExpect * sinT * e2.y,
        z: sRaw * cosT * beamUnit.z + currentOrder * sExpect * sinT * e2.z,
      };
      const D2TargetLab = cross3(D3TargetLab, D1TargetLab);

      // Build R_new (basis change): body's {D1, D2, D3} → lab targets.
      //   M_body   has body-local D1/D2/D3 as columns
      //   M_target has world target D1/D2/D3 as columns
      //   R_new = M_target · M_body^{-1}
      const D1BodyThree = bodyLocalDirToThree(D1Body);
      const D2BodyThree = bodyLocalDirToThree(D2Body);
      const D3BodyThree = bodyLocalDirToThree(D3Body);
      const mBody = new THREE.Matrix4().makeBasis(D1BodyThree, D2BodyThree, D3BodyThree);
      const D1TargetThree = labDirToThree(D1TargetLab).normalize();
      const D2TargetThree = labDirToThree(D2TargetLab).normalize();
      const D3TargetThree = labDirToThree(D3TargetLab).normalize();
      const mTarget = new THREE.Matrix4().makeBasis(D1TargetThree, D2TargetThree, D3TargetThree);
      const mBodyInv = mBody.clone().invert();
      const mAlign = new THREE.Matrix4().multiplyMatrices(mTarget, mBodyInv);
      const finalQuat = new THREE.Quaternion().setFromRotationMatrix(mAlign);

      // For the feedback message we still want to report the equivalent
      // "Stage 2 omega" (= the angle by which D1 deviates from s·beam) so
      // the user can sanity-check it equals ±θ_B per the chosen order.
      const expectedDotD2 = expectedInputDotD2(currentOrder, traversalSignForExpect, thetaBRad);
      const omegaRad = -sRaw * Math.asin(THREE.MathUtils.clamp(expectedDotD2, -1, 1));

      // Step A: translate so MIDPOINT of (intercept_in, intercept_out) sits
      // on the beam line. We project the OLD midpoint onto the beam to
      // pick the foot, then set pos_new so the body's midpoint maps to
      // that foot under R_new.
      const midpointBody = {
        x: 0.5 * (inBody.x + outBody.x),
        y: 0.5 * (inBody.y + outBody.y),
        z: 0.5 * (inBody.z + outBody.z),
      };
      const midpointLabOld = bodyToLab(midpointBody);
      // best.closest is the foot of the perpendicular from the OLD entry
      // anchor onto the beam — it's a known point on the beam ray. We
      // project the OLD midpoint onto the same beam ray to get the
      // midpoint's own foot.
      const beamRef = best.closest;
      const tMid =
        (midpointLabOld.x - beamRef.x) * beamUnit.x +
        (midpointLabOld.y - beamRef.y) * beamUnit.y +
        (midpointLabOld.z - beamRef.z) * beamUnit.z;
      const midpointFoot = {
        x: beamRef.x + tMid * beamUnit.x,
        y: beamRef.y + tMid * beamUnit.y,
        z: beamRef.z + tMid * beamUnit.z,
      };
      const rotatedBodyOffset = (bodyMm: { x: number; y: number; z: number }) => {
        const v3 = bodyLocalDirToThree(bodyMm);
        v3.applyQuaternion(finalQuat);
        return { x: v3.x, y: -v3.z, z: v3.y };
      };
      const rotatedMidpoint = rotatedBodyOffset(midpointBody);
      let nextXMm = midpointFoot.x - rotatedMidpoint.x;
      let nextYMm = midpointFoot.y - rotatedMidpoint.y;
      let nextZMm = midpointFoot.z - rotatedMidpoint.z;
      // After the above, the midpoint of (in, out) sits exactly at
      // midpointFoot which is on the beam line by construction. The in
      // and out anchors are then offset from that midpoint by ±L/2·D1,
      // where D1 makes angle θ_B with beam — so each port sits at
      // L/2·sin(θ_B) ⊥-distance from the beam (typically <0.1 mm for an
      // AOM).

      // [11] Verify Bragg: compute residual = arcsin(beam · D2_new) − arcsin(expectedDotD2).
      const D2NewThree = bodyLocalDirToThree(D2Body);
      D2NewThree.applyQuaternion(finalQuat).normalize();
      const D2NewLab = { x: D2NewThree.x, y: -D2NewThree.z, z: D2NewThree.y };
      const beamDotD2New = beamUnit.x * D2NewLab.x + beamUnit.y * D2NewLab.y + beamUnit.z * D2NewLab.z;
      const residualMrad = (
        Math.asin(THREE.MathUtils.clamp(beamDotD2New, -1, 1)) -
        Math.asin(THREE.MathUtils.clamp(expectedDotD2, -1, 1))
      ) * 1e3;

      // [12] Decompose finalQuat back to SceneObject Euler.
      const finalEuler = new THREE.Euler().setFromQuaternion(finalQuat, "YXZ");
      const nextRxDeg = THREE.MathUtils.radToDeg(finalEuler.x);
      const nextRzDeg = THREE.MathUtils.radToDeg(finalEuler.y);
      const nextRyDeg = -THREE.MathUtils.radToDeg(finalEuler.z);

      // [13] Aperture clipping warning (best-effort; ray-tracer doesn't
      //      publish per-segment 1/e² waist, so use upstream seed waist
      //      as a coarse upper bound).
      const sourceObj = scene.objects.find((o) => o.id === best!.sourceId);
      const sourceComp = sourceObj
        ? scene.components.find((c) => c.id === sourceObj.componentId)
        : undefined;
      const sourceProps = (sourceComp?.properties ?? {}) as { beamWaistMm?: number };
      const upstreamWaistMm =
        typeof sourceProps.beamWaistMm === "number" ? sourceProps.beamWaistMm : null;
      const clippingWarning =
        upstreamWaistMm !== null && upstreamWaistMm > entryAp
          ? ` ⚠ upstream beam waist ${upstreamWaistMm.toFixed(2)} mm > entry aperture ${entryAp.toFixed(2)} mm — beam will clip.`
          : "";

      // [14] Persist + feedback.
      await updateSceneObject(sceneObject.id, {
        xMm: nextXMm,
        yMm: nextYMm,
        zMm: nextZMm,
        rxDeg: nextRxDeg,
        ryDeg: nextRyDeg,
        rzDeg: nextRzDeg,
      });
      const sourceName = sourceObj?.name ?? best!.sourceId.slice(0, 6);
      const entryLabel = isStateB ? "entry=out" : "entry=in";
      const d1ParityLabel = sRaw > 0 ? "D1∥+beam" : "D1∥−beam";
      const orderLabel = currentOrder === 0 ? "0th" : currentOrder > 0 ? "+1" : "-1";
      const traversalNote =
        traversalSignRaw < 0 && currentOrder !== 0 && stage2SignConvention === "physical-traversal"
          ? ` (entry=out flips selected ${currentOrder > 0 ? "+1" : "-1"} → physical ${effectiveOrder > 0 ? "+1" : "-1"})`
          : "";
      setAlignFeedback(
        `Aligned (${stage1Mode}): midpoint on beam, ${d1ParityLabel} ` +
        `(${entryLabel}), m=${orderLabel}${traversalNote}. ` +
        `Equivalent ω = ${(omegaRad * 1e3).toFixed(3)} mrad about D3. ` +
        `Bragg residual ${residualMrad.toFixed(3)} mrad. ` +
        `Source: ${sourceName} beam.${clippingWarning}`,
      );
    } catch (err) {
      setAlignFeedback(`Align failed: ${(err as Error).message}`);
    } finally {
      setAlignBusy(false);
    }
  };

  // Structured kindParams editor — mirrors the LaserSourceControls /
  // WaveplateAdjustControls style. Rendered above the existing RF drive +
  // sideband-table block. Each section commits via `persist()` and uses a
  // local NumberCell that draftss / commits on blur or Enter.
  const NumberCell = ({
    label,
    suffix,
    value,
    step = 0.1,
    onCommit,
    placeholder,
    style,
  }: {
    label: string;
    suffix?: string;
    value: number;
    step?: number;
    onCommit: (v: number) => void;
    placeholder?: string;
    style?: React.CSSProperties;
  }) => {
    const [draft, setDraft] = useState(Number.isFinite(value) ? value.toString() : "");
    useEffect(() => setDraft(Number.isFinite(value) ? value.toString() : ""), [value]);
    const commit = (raw: string) => {
      const v = Number(raw);
      if (!Number.isFinite(v)) return;
      onCommit(v);
    };
    return (
      <label className="component-editor-coord" style={style}>
        <span style={{ fontSize: 11 }}>{label}{suffix ? ` (${suffix})` : ""}</span>
        <input
          type="number"
          step={step}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit((e.target as HTMLInputElement).value);
            }
          }}
        />
      </label>
    );
  };

  const sectionStyle: React.CSSProperties = {
    marginTop: 8,
    padding: "6px 8px",
    background: "rgba(56, 189, 248, 0.06)",
    borderLeft: "2px solid #38bdf8",
    fontSize: 11,
  };
  const titleStyle: React.CSSProperties = { color: "#38bdf8", fontWeight: 600, marginBottom: 6 };
  // RF subsection — amber accent matches the .physics-panel-rf chrome so the
  // user sees at a glance which knobs belong to the RF input vs the optical
  // crystal. AOM is a hybrid kind (optical body + RF drive), so the panel
  // exposes both. (User feedback 2026-05-13: keep RF settings visually
  // separated from optical settings.)
  const rfSectionStyle: React.CSSProperties = {
    marginTop: 8,
    padding: "6px 8px",
    background: "rgba(245, 158, 11, 0.08)",
    borderLeft: "2px solid #f59e0b",
    fontSize: 11,
  };
  const rfTitleStyle: React.CSSProperties = { color: "#b45309", fontWeight: 700, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" };
  const opticalTitleStyle: React.CSSProperties = { color: "#0369a1", fontWeight: 700, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" };
  const groupHeaderStyle: React.CSSProperties = { marginTop: 12, marginBottom: 4, fontSize: 10 };
  const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 };
  const grid3: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 };

  const useBaseEfficiencyOverride = typeof params.baseEfficiency === "number";

  return (
    <div className="mirror-adjust">
      {/* RF Settings — drive carrier + power. Hybrid kinds (AOM/EOM) expose
          their RF input here so the RF-related knobs aren't mixed in with
          the optical crystal / Bragg math. */}
      <div style={groupHeaderStyle}><span style={rfTitleStyle}>RF Settings</span></div>
      <div style={rfSectionStyle}>
        <div style={{ ...titleStyle, color: "#b45309" }}>RF carrier &amp; drive</div>
        {upstreamRf ? (
          <div
            style={{
              padding: 8,
              background: "#1c1c22",
              borderRadius: 4,
              border: "1px dashed #3e3e48",
              fontSize: 11,
              color: "#cfcfd8",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div style={{ color: "#8e8e9a", fontSize: 10 }}>
              Synced from <strong style={{ color: "#cfcfd8" }}>{upstreamRf.sourceName}</strong>
              {" · "}
              <strong style={{ color: "#cfcfd8" }}>{upstreamRf.channelName}</strong>
              {" "}via rf_cable — edit in the RF link panel.
            </div>
            <div style={{ display: "flex", gap: 16 }}>
              <span>
                Carrier f:{" "}
                <strong>{effectiveCenterFreqMhz.toFixed(1)} MHz</strong>
              </span>
              <span>
                RF drive: <strong>{(effectiveRfDrivePowerW ?? 0).toFixed(3)} W</strong>
              </span>
              <span style={{ marginLeft: "auto" }}>
                RF max:{" "}
                <NumberCell
                  label=""
                  suffix="W"
                  value={params.rfPowerMaxW ?? 2}
                  step={0.1}
                  onCommit={(v) => v > 0 && void persist({ rfPowerMaxW: v })}
                />
              </span>
            </div>
          </div>
        ) : (
          <div
            style={{
              padding: 8,
              background: "#1c1c22",
              borderRadius: 4,
              border: "1px dashed #b45309",
              fontSize: 11,
              color: "#cfcfd8",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div style={{ color: "#d49a3a", fontSize: 10 }}>
              ⚠ This AOM has no upstream rf_cable. Connect its rf_in anchor
              to an rf_source channel in the RF link panel to drive it.
              Until then the closed-form efficiency falls back to
              baseEfficiency and the sideband Δf = 80 MHz default.
            </div>
            <div style={{ display: "flex", gap: 16 }}>
              <span>
                Carrier f: <strong>{effectiveCenterFreqMhz.toFixed(1)} MHz</strong>{" "}
                <span style={{ color: "#8e8e9a" }}>(default)</span>
              </span>
              <span style={{ marginLeft: "auto" }}>
                RF max:{" "}
                <NumberCell
                  label=""
                  suffix="W"
                  value={params.rfPowerMaxW ?? 2}
                  step={0.1}
                  onCommit={(v) => v > 0 && void persist({ rfPowerMaxW: v })}
                />
              </span>
            </div>
          </div>
        )}
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            className="secondary-button"
            onClick={maximiseEfficiency}
            title="Peg baseEfficiency at 0.99 (closed-form η no longer writes back to AOMParams after Phase B — RF drive is owned by the upstream AD9959 channel in the RF link panel)."
          >
            Max η (override)
          </button>
        </div>
        <div style={{ opacity: 0.7, marginTop: 4, fontSize: 10 }}>
          Drives the acoustic wave that diffracts the beam (RF chain terminates here).
          {effectiveRfDrivePowerW != null ? (
            <> Live P_d = <strong>{effectiveRfDrivePowerW.toFixed(4)} W</strong>, capped at {rfMax.toFixed(2)} W.</>
          ) : (
            <> No upstream — P_d undefined (closed-form η disabled).</>
          )}
        </div>
      </div>

      {/* Optical Settings — crystal physics, Bragg geometry, efficiency, sideband. */}
      <div style={groupHeaderStyle}><span style={opticalTitleStyle}>Optical Settings</span></div>
      {/* Acoustic crystal — knobs that affect θ_B and Δθ on the optical side. */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Acoustic crystal</div>
        <div style={grid2}>
          <NumberCell
            label="Acoustic v"
            suffix="m/s"
            value={params.acousticVelocityMPerS ?? 4200}
            step={50}
            onCommit={(v) => v > 0 && void persist({ acousticVelocityMPerS: v })}
          />
          <NumberCell
            label="Refractive n"
            value={params.refractiveIndex ?? 2.26}
            step={0.01}
            onCommit={(v) => v > 0 && void persist({ refractiveIndex: v })}
          />
        </div>
        <div style={{ opacity: 0.6, marginTop: 4, fontSize: 10 }}>
          External Bragg half-angle θ_B = arcsin(λ·f/(2·v)) = <strong>{thetaBMrad.toFixed(2)} mrad</strong> @ {wavelengthForAngleNm.toFixed(0)} nm.
          {" "}Full 0→±1 separation 2θ_B = <strong>{(2 * thetaBMrad).toFixed(2)} mrad</strong>{" "}
          (matches datasheet's Δθ = λ·f/v).
        </div>
      </div>

      {/* Crystal geometry — feed the closed-form sin² formula. */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Crystal geometry</div>
        <div style={grid3}>
          <NumberCell
            label="Crystal length L"
            suffix="mm"
            value={params.crystalLengthMm ?? 25}
            step={1}
            onCommit={(v) => v > 0 && void persist({ crystalLengthMm: v })}
          />
          <NumberCell
            label="Acoustic beam W"
            suffix="mm"
            value={params.acousticBeamWidthMm ?? 1.5}
            step={0.1}
            onCommit={(v) => v > 0 && void persist({ acousticBeamWidthMm: v })}
          />
          <NumberCell
            label="Figure of merit M₂"
            suffix="m²/W"
            value={params.figureOfMeritM2 ?? 3.4e-14}
            step={1e-15}
            onCommit={(v) => v > 0 && void persist({ figureOfMeritM2: v })}
          />
        </div>
        <div style={{ opacity: 0.6, marginTop: 4, fontSize: 10 }}>
          Used by the closed-form η = sin²((π·L / 2λ·cosθ_B) · √(2·M₂·P_d/W)).{" "}
          For TeO₂-L (longitudinal mode) at 850 nm, M₂ ≈ 3.4×10⁻¹⁴ m²/W.
        </div>
      </div>

      {/* Efficiency — closed-form vs override; angular acceptance. */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Efficiency</div>
        <label className="component-editor-coord" style={{ marginBottom: 6, display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={useBaseEfficiencyOverride}
            onChange={(e) => {
              if (e.target.checked) {
                // Set baseEfficiency to current closed-form result so the
                // checkbox flip doesn't surprise the user with a jump.
                void persist({ baseEfficiency: efficiencyEst });
              } else {
                // Remove baseEfficiency so closed-form takes over.
                const { baseEfficiency: _drop, ...rest } = params;
                void upsertOpticalElement({
                  objectId: sceneObject.id,
                  elementKind: element.elementKind,
                  kindParams: rest,
                  inputPorts: element.inputPorts,
                  outputPorts: element.outputPorts,
                });
              }
            }}
          />
          <span style={{ fontSize: 11 }}>
            Override closed-form (set η directly — useful when datasheet η doesn't match the M₂/L/W combo)
          </span>
        </label>
        <div style={grid2}>
          {useBaseEfficiencyOverride && (
            <NumberCell
              label="η (override)"
              value={params.baseEfficiency ?? 0.85}
              step={0.01}
              onCommit={(v) => v >= 0 && v <= 1 && void persist({ baseEfficiency: v })}
            />
          )}
          <NumberCell
            label="Bragg angular acceptance"
            suffix="mrad"
            value={params.braggAngularAcceptanceMrad ?? 2}
            step={0.1}
            onCommit={(v) => v > 0 && void persist({ braggAngularAcceptanceMrad: v })}
          />
        </div>
        <div style={{ opacity: 0.6, marginTop: 4, fontSize: 10 }}>
          Live η at λ ≈ {wavelengthForAngleNm.toFixed(0)} nm
          {effectiveRfDrivePowerW != null
            ? <>, P_d = {effectiveRfDrivePowerW.toFixed(4)} W</>
            : <>, P_d undefined</>}:{" "}
          <strong>{(efficiencyEst * 100).toFixed(1)}%</strong>.
          {useBaseEfficiencyOverride
            ? " (using override)"
            : " (closed-form sin²)"}
        </div>
      </div>

      {/* (RF drive power, RF max and Max η button moved into the RF
          Settings group at the top of this panel — 2026-05-13.) */}
      <p className="mirror-adjust-hint">
        Bragg angle θ_B at λ ≈ {wavelengthForAngleNm.toFixed(0)} nm:{" "}
        <strong>{thetaBMrad.toFixed(2)} mrad</strong> ({(thetaBRad * 180 / Math.PI).toFixed(3)}°).
        Estimated efficiency η = <strong>{(efficiencyEst * 100).toFixed(1)}%</strong>.
        {" "}Angular acceptance = <strong>{braggAcceptanceMrad.toFixed(2)} mrad</strong>.
      </p>
      <div className="mirror-adjust-hint" style={{ opacity: 0.9 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", fontWeight: 600 }}>Sideband</th>
              <th style={{ textAlign: "right", fontWeight: 600 }}>Angle</th>
              <th style={{ textAlign: "right", fontWeight: 600 }}>Shift</th>
              <th style={{ textAlign: "right", fontWeight: 600 }}>Center</th>
              <th style={{ textAlign: "right", fontWeight: 600 }}>Intensity</th>
            </tr>
          </thead>
          <tbody>
            {sidebandRows.map((row) => {
              const orderLabel = row.order > 0 ? `+${row.order}` : `${row.order}`;
              const isHighlighted = row.order === 0 || row.matched;
              const visibleStyle: React.CSSProperties = isHighlighted
                ? { background: "rgba(245, 158, 11, 0.10)", fontWeight: 600 }
                : row.visible
                  ? {}
                  : { opacity: 0.45 };
              return (
                <tr key={row.order} style={visibleStyle}>
                  <td>
                    {orderLabel}
                    {row.matched ? " ◀ selected" : ""}
                    {!row.visible ? " (hidden)" : ""}
                  </td>
                  <td style={{ textAlign: "right" }}>{row.angleMrad.toFixed(2)} mrad</td>
                  <td style={{ textAlign: "right" }}>{row.frequencyOffsetMhz > 0 ? "+" : ""}{row.frequencyOffsetMhz.toFixed(1)} MHz</td>
                  <td style={{ textAlign: "right" }}>{row.centerFrequencyThz.toFixed(6)} THz</td>
                  <td style={{ textAlign: "right" }}>{(row.intensity * 100).toFixed(row.intensity < 0.01 ? 3 : 1)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mirror-adjust-hint" style={{ marginTop: 4, fontSize: 11, opacity: 0.7 }}>
          Spawning orders ±{maxDiffractionOrder}; visibility threshold ={" "}
          {(sidebandVisibilityThreshold * 100).toFixed(1)}% of input. Orders below
          this don't draw a ray (0 and the selected ±1 always show).
        </p>
        {currentOrder !== 0 ? (
          <div style={{ marginTop: 6, padding: "4px 8px", background: "rgba(245, 158, 11, 0.12)", borderLeft: "2px solid rgb(245, 158, 11)", fontSize: 12 }}>
            <strong>Visible beams (0th ↔ {currentOrder > 0 ? "+1" : "−1"}):</strong>{" "}
            angular separation ={" "}
            <strong>{(2 * thetaBMrad).toFixed(3)} mrad</strong>{" "}
            ({(2 * thetaBRad * 180 / Math.PI).toFixed(4)}°).
            <br />
            Intensity split — 0th: <strong>{(zerothIntensity * 100).toFixed(1)}%</strong>,{" "}
            {currentOrder > 0 ? "+1" : "−1"}: <strong>{(selectedFirstOrderIntensity * 100).toFixed(1)}%</strong>.
          </div>
        ) : (
          <div style={{ marginTop: 6, padding: "4px 8px", background: "rgba(0,0,0,0.05)", borderLeft: "2px solid rgba(0,0,0,0.3)", fontSize: 12 }}>
            <strong>Visible beam:</strong> only 0th order — RF off, no diffraction, no angular separation.
          </div>
        )}
      </div>
      <div className="mirror-adjust-row" role="radiogroup" aria-label="Diffraction order">
        <span style={{ alignSelf: "center", fontSize: 12, opacity: 0.8 }}>Output order:</span>
        {([-1, 0, 1] as const).map((opt) => (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={currentOrder === opt}
            className={currentOrder === opt ? "primary-button" : "secondary-button"}
            onClick={() => setOrder(opt)}
            style={{ minWidth: 56 }}
          >
            {opt > 0 ? `+${opt}` : opt === 0 ? "0" : `${opt}`}
          </button>
        ))}
      </div>
      <div className="mirror-adjust-row">
        <label className="mirror-adjust-field" style={{ flex: 1 }}>
          <span>Show up to ±N order</span>
          <input
            type="number"
            min={1}
            max={10}
            step={1}
            value={maxDiffractionOrder}
            onChange={(e) => {
              const v = Math.max(1, Math.min(10, Math.round(Number(e.target.value) || 1)));
              void persist({ maxDiffractionOrder: v });
            }}
          />
        </label>
        <label className="mirror-adjust-field" style={{ flex: 1 }}>
          <span>Visibility threshold (%)</span>
          <input
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={(sidebandVisibilityThreshold * 100).toFixed(2)}
            onChange={(e) => {
              const pct = Math.max(0, Math.min(100, Number(e.target.value) || 0));
              void persist({ sidebandVisibilityThreshold: pct / 100 });
            }}
          />
        </label>
      </div>
      <p className="mirror-adjust-hint" style={{ opacity: 0.8 }}>
        {currentOrder === 0
          ? "0 = RF off — all power on the transmitted (zeroth) path."
          : `${currentOrder > 0 ? "+1" : "−1"} = diffracted by ${currentOrder > 0 ? "+" : "−"}2θ_B; ` +
            `zeroth retains (1−η) ≈ ${((1 - efficiencyEst) * 100).toFixed(1)}%.`}
      </p>
      {/* (Phase 7.1 移除) Bragg tilt axis r (°) 手動輸入。Tilt 軸現在
          自動 = b̂×â（PHY Editor 的 intercept_in/out 定義 b̂、Component
          metadata 的 acousticAxisBodyLocal 定義 â），純幾何推導，沒有
          獨立 DoF。Schema 中的 `braggTiltAxisDegLab` 保留供舊資料讀取，
          但 align 不再讀取這個欄位。 */}
      <button
        type="button"
        className="primary-button"
        onClick={() => void alignToLaser()}
        disabled={alignBusy}
        title="Pick the AOM port (intercept_in / intercept_out) that the upstream beam reaches first, translate that anchor onto the beam line, then rotate the body 1-D around the tilt axis (defined in PHY Editor by α — body-local, ⊥ b̂; pivot = midpoint = Bragg interaction point) so dir·acoustic = orderSign·sin(θ_B)."
      >
        {alignBusy ? "Aligning…" : "Align AOM port + Bragg"}
      </button>
      {alignFeedback && (
        <div className="snap-to-beam-feedback" style={{ marginTop: 6 }}>
          {alignFeedback}
        </div>
      )}
    </div>
  );
}
