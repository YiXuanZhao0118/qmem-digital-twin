/**
 * Regression test for the CAD→three basis swap baked into
 * `buildPbs252BeamSplitterObject`.
 *
 * The PBS252 STL is authored in the CAD Z-up frame, but the lab beam is
 * converted to three's Y-up frame by labMmToThree (axis map (x,y,z)→(x,z,-y)
 * = Rx(-90°)). Without a matching swap on the mesh the cube renders 90° off
 * its own beam — the diagonal coating sits in the wrong plane, so the
 * reflected beam's turning point lands OUTSIDE the cube (the user-reported lab
 * symptom, vs the correct PHY-editor preview which renders + traces in the
 * same raw CAD frame and so needs no swap).
 *
 * The builder applies ONE rigid Rx(-90°) to the assembled cube. This pins the
 * swap AND its sign so a refactor can't drop it (→ the 90°-off bug) or flip it
 * to +90° (which would send the reflected beam the opposite way).
 */

import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { buildPbs252BeamSplitterObject } from "../loadAsset/stl_builders/thorlabs_pbs252";
import type { ComponentItem } from "../../types/digitalTwin";


// kindId / topAxis don't matter for the swap; properties:{} → default
// topAxis "y", which only governs the cosmetic frosted/clear split.
const COMPONENT = {
  id: "pbs",
  name: "pbs",
  kindId: "beam_splitter",
  properties: {},
} as unknown as ComponentItem;


describe("buildPbs252BeamSplitterObject CAD→three basis swap", () => {
  it("rotates the cube's CAD +Y long axis onto three -Z (Rx(-90°))", () => {
    // A box whose long axis runs along CAD +Y, shifted to span [0,4] so the
    // swap's SIGN is observable — a box symmetric about the origin could not
    // distinguish Rx(-90°) from Rx(+90°).
    const geo = new THREE.BoxGeometry(1, 4, 1);
    geo.translate(0, 2, 0); // CAD: x∈[-.5,.5], y∈[0,4], z∈[-.5,.5]

    const group = buildPbs252BeamSplitterObject(geo, COMPONENT);
    group.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(group);

    // Rx(-90°): (x,y,z)→(x,z,-y). The CAD +Y[0,4] long axis must land on
    // three -Z[-4,0]; the former CAD ±Z thickness becomes the three Y extent.
    // Rx(+90°) would instead put the long axis on three +Z[0,4] — hence the
    // signed min/max assertions below, not just an axis check.
    expect(bbox.min.x).toBeCloseTo(-0.5, 5);
    expect(bbox.max.x).toBeCloseTo(0.5, 5);
    expect(bbox.min.y).toBeCloseTo(-0.5, 5);
    expect(bbox.max.y).toBeCloseTo(0.5, 5);
    expect(bbox.min.z).toBeCloseTo(-4, 5);
    expect(bbox.max.z).toBeCloseTo(0, 5);
  });
});
