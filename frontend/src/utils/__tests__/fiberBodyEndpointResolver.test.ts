/**
 * Tests for resolveEndpointFromKindParams, the helper that turns a fiber
 * PE's kindParams.endA/endB into a body-local spline endpoint and Bezier
 * handle for the renderer.
 *
 * Current contract (2026-05-17, see the resolver's own docstring): `posMm`
 * is the BACK of the connector — the junction where the wire meets it, which
 * is also the spline endpoint and the mesh origin. So `posMmBody` is
 * `posMm` unchanged; the optical tip sits FIBER_FERRULE_TIP_MM further along
 * the outward direction and is not this function's job.
 *
 * These tests previously encoded the pre-2026-05-17 contract, where `posMm`
 * was the tip and the resolver added the connector length to reach the
 * junction. They asserted `posMm + FIBER_END_CONNECTOR_LENGTH_MM` and had
 * been red ever since.
 *
 * tensionHandleMm is already the fiber BODY-local wire tangent; rotDeg is
 * residual ferrule metadata and must not rotate the wire.
 */
import { describe, expect, it } from "vitest";

import {
  bodyHandleToTensionHandle,
  resolveEndpointFromKindParams,
} from "../fiberBodyEndpointResolver";

describe("resolveEndpointFromKindParams", () => {
  it("identity rotDeg: handle equals body-local tensionHandleMm", () => {
    const r = resolveEndpointFromKindParams("A", {
      posMm: [10, 20, 30],
      rotDeg: [0, 0, 0],
      tensionHandleMm: [0, 30, 0],
    });
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.posMmBody[0]).toBeCloseTo(10, 6);
    expect(r.posMmBody[1]).toBeCloseTo(20, 6);
    expect(r.posMmBody[2]).toBeCloseTo(30, 6);
    expect(r.handleMmBody[0]).toBeCloseTo(0, 6);
    expect(r.handleMmBody[1]).toBeCloseTo(30, 6);
    expect(r.handleMmBody[2]).toBeCloseTo(0, 6);
  });

  it("rotDeg does not rotate the wire tangent", () => {
    const r = resolveEndpointFromKindParams("A", {
      posMm: [0, 0, 0],
      rotDeg: [0, 0, 90],
      tensionHandleMm: [0, 30, 0],
    });
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.posMmBody[0]).toBeCloseTo(0, 4);
    expect(r.posMmBody[1]).toBeCloseTo(0, 4);
    expect(r.posMmBody[2]).toBeCloseTo(0, 4);
    expect(r.handleMmBody[0]).toBeCloseTo(0, 4);
    expect(r.handleMmBody[1]).toBeCloseTo(30, 4);
    expect(r.handleMmBody[2]).toBeCloseTo(0, 4);
  });

  it("returns null when tension vector is zero", () => {
    const r = resolveEndpointFromKindParams("A", {
      posMm: [0, 0, 0],
      rotDeg: [0, 0, 0],
      tensionHandleMm: [0, 0, 0],
    });
    expect(r).toBeNull();
  });

  it("falls back to default body-local tension when tensionHandleMm is missing", () => {
    const r = resolveEndpointFromKindParams("B", {
      posMm: [1, 2, 3],
      rotDeg: [0, 0, 0],
      tensionHandleMm: null,
    });
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.posMmBody[0]).toBeCloseTo(1, 6);
    expect(r.posMmBody[1]).toBeCloseTo(2, 6);
    expect(r.posMmBody[2]).toBeCloseTo(3, 6);
    expect(r.handleMmBody[1]).toBeCloseTo(30, 6);
  });
});

describe("bodyHandleToTensionHandle", () => {
  it("is identity for body-local endpoint handles", () => {
    const original = {
      posMm: [0, 0, 0] as [number, number, number],
      rotDeg: [10, 20, 30] as [number, number, number],
      tensionHandleMm: [5, 25, -8] as [number, number, number],
    };
    const r = resolveEndpointFromKindParams("A", original);
    expect(r).not.toBeNull();
    if (!r) return;
    const recovered = bodyHandleToTensionHandle(original, r.handleMmBody);
    expect(recovered[0]).toBeCloseTo(5, 4);
    expect(recovered[1]).toBeCloseTo(25, 4);
    expect(recovered[2]).toBeCloseTo(-8, 4);
  });
});
