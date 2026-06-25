/**
 * RF-link role-contract port tests — guard `rfLinkRoleAnchors`, the fallback
 * the RF Link panel uses to surface a mesh-less RF object (a Component with
 * `asset3dId === null`, hence zero Asset3D anchors). Without this fallback the
 * panel silently drops such nodes (ports derived from `asset.anchors` only).
 *
 * Invariants:
 *   - rf_source       → one `rf_out` port (domain "rf").
 *   - rf_amplifier    → `rf_in` + `rf_out` (both "rf").
 *   - rf_switch       → `rf_in` + `rf_out` + `ttl_in`.
 *   - PPG             → `rf_out` resolves to the "rfout" gate domain.
 *   - non-RF / null   → empty (mirror has no RF role; null kind is no-op).
 */

import { describe, expect, it } from "vitest";

import { rfLinkRoleAnchors } from "../rfLinkPorts";

describe("rfLinkRoleAnchors", () => {
  it("synthesizes an rf_out port for an assetless rf_source", () => {
    expect(rfLinkRoleAnchors("rf_source")).toEqual([
      { anchorId: "rf_out", domain: "rf" },
    ]);
  });

  it("synthesizes rf_in + rf_out for an assetless rf_amplifier", () => {
    const anchors = rfLinkRoleAnchors("rf_amplifier");
    expect(anchors).toContainEqual({ anchorId: "rf_in", domain: "rf" });
    expect(anchors).toContainEqual({ anchorId: "rf_out", domain: "rf" });
  });

  it("synthesizes rf_in + rf_out + ttl_in for an assetless rf_switch", () => {
    const ids = rfLinkRoleAnchors("rf_switch").map((a) => a.anchorId);
    expect(ids).toEqual(expect.arrayContaining(["rf_in", "rf_out", "ttl_in"]));
    expect(rfLinkRoleAnchors("rf_switch").find((a) => a.anchorId === "ttl_in")?.domain).toBe("ttl");
  });

  it("maps a PPG rf_out to the 'rfout' gate domain", () => {
    expect(rfLinkRoleAnchors("programmable_pulse_generator")).toEqual([
      { anchorId: "rf_out", domain: "rfout" },
    ]);
  });

  it("returns empty for a non-RF kind and for null", () => {
    expect(rfLinkRoleAnchors("mirror")).toEqual([]);
    expect(rfLinkRoleAnchors(null)).toEqual([]);
  });
});
