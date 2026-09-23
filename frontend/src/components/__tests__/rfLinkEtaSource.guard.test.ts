/**
 * Static guard: the RF Link panel's AOM η comes from the TRACE, not from the
 * panel.
 *
 * The panel used to compute η itself, with `aomDriveReadout` at
 * `sceneWavelengthNm`. The model was right — it is `optical/kinds/aom/physics`,
 * the same one the backend op runs — but the wavelength was not. The emitter
 * scan counted every `laser_source` AND every `tapered_amplifier`, so on the
 * live bench the Sacher TA's nominal 852 sat alongside the DBR's 852.347, two
 * wavelengths, and the badge fell back to the nominal 780 nm. The tracer's rays
 * at the AOM are at 852.347 (a SEEDED TA emits nothing of its own), and
 * P_peak ∝ λ², so the badge graded the drive against 1.11 W while the beam it
 * describes was diffracted against 1.32 W: 84% vs 82% on the live AD9959 drive,
 * and 21.04 vs 22.99 Vpp of "peak η at ≈" advice.
 *
 * The rule (docs/introduce/rf.md §3): a UI file does not compute physics when
 * an endpoint already reports the tracer's own answer —
 * `POST /api/v3/rf/propagation` → `aomDrives[*].eta`, qualified by
 * `aomEtaWavelengthNm`. A source scan because the thing being pinned is WHERE
 * the number comes from; there is no way to render this panel in the node-env
 * suite. The endpoint's own contract is pinned by
 * `backend/tests/optical/test_rf_propagation_endpoint.py`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../RfLinkPanel.tsx", import.meta.url)),
  "utf8",
);

describe("the AOM η badge reads the tracer's efficiency", () => {
  it("fetches the backend RF readout", () => {
    expect(SOURCE).toContain("fetchRfPropagationApi");
    expect(SOURCE).toMatch(/tracerRfReadout/);
  });

  it("never binds a locally-computed efficiency straight to the badge", () => {
    // The exact pre-2026-09-23 line. `efficiency` is the prop AomInRow grades
    // and prints, so destructuring it out of the local model is the bug.
    expect(
      SOURCE,
      "AomInRow's `efficiency` must resolve from `aomDrives[*].eta` first; " +
        "the local model is only the pre-response fallback.",
    ).not.toMatch(/const \{\s*peakPowerW,\s*efficiency\s*\}\s*=\s*aomDriveReadout/);
  });

  it("prefers the tracer's η at both readout sites", () => {
    // The row itself and the block-width estimator, which decides whether an
    // η chip is reserved space at all.
    expect(SOURCE.match(/tracerEtaByAomId\.get\(/g) ?? []).toHaveLength(2);
  });

  it("takes the readout wavelength from the backend too", () => {
    // P_peak ∝ λ², so the "peak η at ≈ X Vpp" suggestion and the footer legend
    // must quote the SAME λ the η beside them was evaluated at.
    expect(SOURCE).toMatch(
      /const sceneWavelengthNm =\s*tracerRfReadout\?\.aomEtaWavelengthNm \?\? localWavelengthGuessNm;/,
    );
  });

  it("keeps the badge's grading and wording", () => {
    // The fix changes where η comes from, nothing about how it is presented.
    expect(SOURCE).toContain('text: "⚠ under"');
    expect(SOURCE).toContain('text: "⚠ off-peak"');
    expect(SOURCE).toContain('text: "OK"');
    expect(SOURCE).toMatch(/efficiency \/ peakEfficiency/);
  });
});
