/**
 * Outliner search matching.
 *
 * The needle a user types is the part as it is *spoken* ("post spacer 2.0mm");
 * the catalog spells it "Post Spacer 2.0 mm" and the placed object is named
 * something else entirely. Both sides are whitespace-stripped so the two
 * spellings meet — that is the whole reason `normalizeSearchText` exists, so
 * it gets a test rather than a comment.
 */
import { describe, expect, it } from "vitest";

import type { ComponentItem } from "../../types/digitalTwin";
import { normalizeSearchText, objectSearchHaystack } from "../components";

const spacer = {
  id: "c1",
  name: "Post Spacer 2.0 mm",
  componentName: "Post Spacer 2.0 mm",
  kindId: "mechanical",
  brand: "Thorlabs",
  model: "RS2M",
  properties: {},
  physicsCapabilities: [],
} as unknown as ComponentItem;

const object = { name: "spacer under KS1" };

function matches(needle: string, component?: ComponentItem): boolean {
  return objectSearchHaystack(object, component).includes(normalizeSearchText(needle));
}

describe("outliner search", () => {
  it("matches the component name however the user spaces it", () => {
    expect(matches("POST SPACER 2.0MM", spacer)).toBe(true);
    expect(matches("post spacer 2.0 mm", spacer)).toBe(true);
    expect(matches("  Post  Spacer  ", spacer)).toBe(true);
  });

  it("matches brand, model and kind", () => {
    expect(matches("rs2m", spacer)).toBe(true);
    expect(matches("thorlabs", spacer)).toBe(true);
    expect(matches("mechanical", spacer)).toBe(true);
  });

  it("matches the object's own name", () => {
    expect(matches("ks1", spacer)).toBe(true);
    expect(matches("ks1", undefined)).toBe(true);
  });

  it("does not let a needle straddle two fields", () => {
    // "…2.0 mm" + "Thorlabs" are adjacent in the haystack; the NUL join
    // keeps "mmthorlabs" from being a hit.
    expect(matches("mm thorlabs", spacer)).toBe(false);
  });

  it("rejects a non-match", () => {
    expect(matches("mirror mount", spacer)).toBe(false);
  });
});
