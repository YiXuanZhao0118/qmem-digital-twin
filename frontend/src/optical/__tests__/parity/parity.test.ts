/**
 * Parity test — runs every JSON fixture in __tests__/parity/golden/
 * through the v3 tracer and asserts against expected output. Matched
 * by the backend pytest in `backend/tests/optical/parity/test_parity.py`
 * reading the same files.
 */

import { describe, it } from "vitest";

import "../../kinds/lens/physics";
import "../../kinds/mirror/physics";
import "../../kinds/polarizer/physics";

import aomPlus1 from "./golden/aom_plus1_order.json";
import dichroicShortpass from "./golden/dichroic_shortpass_at_650.json";
import lensBasic from "./golden/lens_basic.json";
import mirrorNormal from "./golden/mirror_normal_incidence.json";
import pbsTransmit45 from "./golden/pbs_transmit_45deg.json";
import polarizerMalus from "./golden/polarizer_malus_30deg.json";
import waveplateHwp45 from "./golden/waveplate_hwp_45deg.json";

import "../../kinds/aom-v3/physics";
import "../../kinds/dichroic-mirror/physics";
import "../../kinds/pbs/physics";
import "../../kinds/waveplate/physics";

import { type ParityFixture, runFixture } from "./runner";

// JSON imports lose tuple narrowing on `jones: [Complex, Complex]`
// (TS widens to `{re,im}[]`), so the double-cast through `unknown` is
// required to land each fixture as a ParityFixture without weakening
// the tuple constraint at the type-def site.
const FIXTURES: ParityFixture[] = [
  aomPlus1 as unknown as ParityFixture,
  dichroicShortpass as unknown as ParityFixture,
  lensBasic as unknown as ParityFixture,
  mirrorNormal as unknown as ParityFixture,
  pbsTransmit45 as unknown as ParityFixture,
  polarizerMalus as unknown as ParityFixture,
  waveplateHwp45 as unknown as ParityFixture,
];

describe("parity / v3 tracer golden fixtures", () => {
  for (const f of FIXTURES) {
    it(f.name, () => {
      runFixture(f);
    });
  }
});
