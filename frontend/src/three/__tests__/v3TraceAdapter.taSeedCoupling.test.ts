/**
 * BeamScope's "TA seed" / "TA eta" readout shows the TRACER's numbers.
 *
 * The backend reports the seed coupling on the segment that ENDS on a tapered
 * amplifier's input facet: `labSegments[*].taSeedCoupling` =
 * `{etaMode, polarizationOverlap, coupledFraction, seedPowerMw,
 * coupledPowerMw}` (`misc_ops.ta_seed_coupling`, the very factors the TA op
 * multiplies the seed by).
 *
 * BeamScope reads its segments from `window.__rayTraceDebug`, which is what
 * `v3TraceAdapter` writes — and the adapter dropped the field, so the readout
 * had never rendered since the v3 tracer became the only source. Worse, the
 * panel's local type declared the RETIRED in-browser tracer's field of the
 * same name (`rawSeedPowerMw` / `effectiveSeedPowerMw` / `modeOverlap` /
 * `distanceToInputMm`, on the TA's OUTPUT segments), so a naive "just pass it
 * through" would have printed `undefined`s. The two shapes share a name and
 * nothing else.
 *
 * The fixture is a real reading off the live bench (2026-09-23): a seed
 * arriving almost exactly cross-polarised to the Sacher TA's acceptance axis,
 * which is why `polarizationOverlap` is 1.02e-5 — the case the readout exists
 * to make visible, and the one a `toFixed(1)` percentage would print as
 * "0.0%".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { adaptV3LabSegmentsToTraceSegments } from "../v3TraceAdapter";
import type { V3LabSegment, V3SolverResult } from "../../api/client";
import type { SceneData } from "../../types/digitalTwin";

/** Verbatim from `POST /api/v3/solver/run-from-db` on the live scene. */
const LIVE_TA_SEED_COUPLING = {
  etaMode: 0.21374209848095893,
  polarizationOverlap: 1.020420755338109e-5,
  coupledFraction: 2.181068735794926e-6,
  seedPowerMw: 11.892576247225879,
  coupledPowerMw: 2.5938526240881713e-5,
} as const;

function segment(extra: Partial<V3LabSegment>): V3LabSegment {
  return {
    start: { x: 0, y: 0, z: 0 },
    end: { x: 100, y: 0, z: 0 },
    wavelengthNm: 852.347,
    powerMw: 11.892576247225879,
    sceneObjectId: "ta-object",
    bindingId: null,
    assetCatalogId: null,
    faceInId: null,
    op: null,
    isTerminal: false,
    emitterSceneObjectId: "laser-object",
    sourceSceneObjectId: "laser-object",
    jones: [{ re: 1, im: 0 }, { re: 0, im: 0 }],
    qxAtStart: { re: 0, im: 1 },
    qyAtStart: { re: 0, im: 1 },
    pathLengthMmAtStart: 0,
    ...extra,
  } as V3LabSegment;
}

const SCENE = {
  objects: [{ id: "laser-object", componentId: "laser-comp" }],
} as unknown as SceneData;

function adapt(segments: V3LabSegment[]) {
  return adaptV3LabSegmentsToTraceSegments(
    { runId: "r", segments: [], labSegments: segments, finalRays: [], errors: [], warnings: [] } as V3SolverResult,
    SCENE,
  );
}

describe("v3TraceAdapter carries taSeedCoupling", () => {
  it("passes the tracer's values through unchanged", () => {
    const [adapted] = adapt([segment({ taSeedCoupling: { ...LIVE_TA_SEED_COUPLING } })]);
    expect(adapted.taSeedCoupling).toEqual(LIVE_TA_SEED_COUPLING);
  });

  it("keeps the v3 key names — they are NOT the legacy tracer's", () => {
    const [adapted] = adapt([segment({ taSeedCoupling: { ...LIVE_TA_SEED_COUPLING } })]);
    expect(Object.keys(adapted.taSeedCoupling!).sort()).toEqual([
      "coupledFraction", "coupledPowerMw", "etaMode",
      "polarizationOverlap", "seedPowerMw",
    ]);
  });

  it("is null on a segment that does not end on a TA facet", () => {
    const [adapted] = adapt([segment({})]);
    expect(adapted.taSeedCoupling).toBeNull();
  });

  it("stays on its own segment when several are traced", () => {
    const adapted = adapt([
      segment({}),
      segment({ taSeedCoupling: { ...LIVE_TA_SEED_COUPLING } }),
      segment({}),
    ]);
    expect(adapted.map((s) => s.taSeedCoupling !== null)).toEqual([false, true, false]);
  });
});

describe("the BeamScope readout consumes the v3 shape", () => {
  // Source scan: the readout is JSX inside a component this node-env suite
  // cannot render, and what has to be pinned is WHICH keys it reads.
  const SOURCE = readFileSync(
    fileURLToPath(new URL("../../components/optical/BeamScopePanel.tsx", import.meta.url)),
    "utf8",
  );

  it("reads the trace's fields", () => {
    expect(SOURCE).toContain("taSeedCoupling.coupledPowerMw");
    expect(SOURCE).toContain("taSeedCoupling.seedPowerMw");
    expect(SOURCE).toContain("taSeedCoupling.etaMode");
    expect(SOURCE).toContain("taSeedCoupling.polarizationOverlap");
  });

  it("no longer reads the retired tracer's fields", () => {
    // Property ACCESSES only — the comment above the block names these four
    // on purpose, to say what the shape is not.
    for (const dead of ["effectiveSeedPowerMw", "rawSeedPowerMw", "modeOverlap", "distanceToInputMm"]) {
      expect(
        SOURCE,
        `taSeedCoupling.${dead} belongs to the retired rayTrace.ts shape`,
      ).not.toContain(`taSeedCoupling.${dead}`);
    }
  });

  it("keeps the two labelled lines", () => {
    expect(SOURCE).toContain("<strong>TA seed</strong>");
    expect(SOURCE).toContain("<strong>TA eta</strong>");
  });

  it("does not round a decade-small overlap down to zero", () => {
    // 1.02e-5 → "1.0e-3%", not "0.0%".
    expect(SOURCE).toMatch(/smallPct\(taSeedCoupling\.polarizationOverlap\)/);
  });
});
