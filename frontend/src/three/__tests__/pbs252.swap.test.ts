/**
 * Frame contract for `buildPbs252BeamSplitterObject`.
 *
 * The PBS252 STL is authored in the CAD Z-up frame, and three is configured
 * Z-up in this app, so the two frames coincide and the builder applies NO
 * basis swap — the assembled cube keeps its raw CAD orientation.
 *
 * This test used to pin the opposite: back when three was Y-up, the builder
 * applied one rigid Rx(-90°) to match `labMmToThree`'s (x,y,z)→(x,z,-y) axis
 * map, and this file asserted that rotation. The Z-up migration removed the
 * rotation (`optical/frames.ts`: `labDirToThree` is the identity,
 * `labRootSwapQuaternion` is the identity) but left both the assertion and a
 * comment block in the builder behind, so the test had been red ever since.
 *
 * The asymmetric box below is kept from the original: it makes a reintroduced
 * Rx(±90°) fail loudly, and it distinguishes the two signs from each other,
 * which a box symmetric about the origin could not.
 */

import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { buildPbs252BeamSplitterObject } from "../loadAsset/stl_builders/thorlabs_pbs252";
import type { ComponentItem } from "../../types/digitalTwin";


// kindId / topAxis don't matter here; properties:{} → default topAxis "y",
// which only governs the cosmetic frosted/clear split.
const COMPONENT = {
  id: "pbs",
  name: "pbs",
  kindId: "beam_splitter",
  properties: {},
} as unknown as ComponentItem;


describe("buildPbs252BeamSplitterObject frame contract", () => {
  it("leaves the cube in the raw CAD frame — no basis swap", () => {
    // Long axis along CAD +Y, shifted to span [0,4] so a swap's SIGN would be
    // observable rather than just its axis.
    const geo = new THREE.BoxGeometry(1, 4, 1);
    geo.translate(0, 2, 0); // CAD: x∈[-.5,.5], y∈[0,4], z∈[-.5,.5]

    const group = buildPbs252BeamSplitterObject(geo, COMPONENT);
    group.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(group);

    // Unrotated: the extents come back exactly as authored.
    expect(bbox.min.x).toBeCloseTo(-0.5, 5);
    expect(bbox.max.x).toBeCloseTo(0.5, 5);
    expect(bbox.min.y).toBeCloseTo(0, 5);
    expect(bbox.max.y).toBeCloseTo(4, 5);
    expect(bbox.min.z).toBeCloseTo(-0.5, 5);
    expect(bbox.max.z).toBeCloseTo(0.5, 5);

    // Spelled out so the failure message names the regression: Rx(-90°) would
    // put the long axis on three -Z[-4,0] and Rx(+90°) on +Z[0,4]. Either one
    // renders the diagonal coating in the wrong plane, which is the old
    // "reflected beam turns outside the cube" bug in reverse.
    expect(bbox.max.z).toBeLessThan(1);
    expect(bbox.min.z).toBeGreaterThan(-1);
  });
});
