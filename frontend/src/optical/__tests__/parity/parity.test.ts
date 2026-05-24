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

const FIXTURES: ParityFixture[] = [
  aomPlus1 as ParityFixture,
  dichroicShortpass as ParityFixture,
  lensBasic as ParityFixture,
  mirrorNormal as ParityFixture,
  pbsTransmit45 as ParityFixture,
  polarizerMalus as ParityFixture,
  waveplateHwp45 as ParityFixture,
];

describe("parity / v3 tracer golden fixtures", () => {
  for (const f of FIXTURES) {
    it(f.name, () => {
      runFixture(f);
    });
  }
});
