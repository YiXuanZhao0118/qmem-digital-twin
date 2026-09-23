/**
 * Static guard: the PHY Editor seeds kind-template anchors on a CLICK, never
 * on render.
 *
 * Until 2026-09-23 the seed ran from a `useEffect` keyed on the whole draft,
 * so merely opening an asset appended a blank row for every template anchor id
 * the asset was missing. On the live catalog that was 20 of 64 assets — a
 * blank `intercept_out` at the body origin on all 8 lens assets, plus `out` /
 * `seed` / `fiber_in` / `intercept_in` on 12 more. The row is not inert:
 * `intercept_out` is in `PRIMARY_ANCHOR_IDS`, so the tracer hit-tests it, and
 * a lens saved after nothing more than being looked at gained a fake 1 mm face
 * in its own beam path. Because it was in the draft, ANY save carried it,
 * including a save made for an unrelated field.
 *
 * A source scan rather than a behavioural test, for the same reason as
 * `anchorWritePath.guard.test.ts`: the thing being pinned is *where* the call
 * sits (effect vs handler), not any value it returns. The seed's own output is
 * covered by `utils/__tests__/kindTemplateSeed.test.ts`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../Asset3DEditor.tsx", import.meta.url)),
  "utf8",
);

/** Every argument list passed to `fnName(...)`, matched with balanced parens
 *  so nested calls and object literals come back whole. */
function callArguments(source: string, fnName: string): string[] {
  const out: string[] = [];
  const needle = `${fnName}(`;
  let at = source.indexOf(needle);
  while (at !== -1) {
    let depth = 0;
    let i = at + needle.length - 1;
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")" && --depth === 0) break;
    }
    out.push(source.slice(at + needle.length, i));
    at = source.indexOf(needle, i);
  }
  return out;
}

describe("kind-template anchor seeding is explicit", () => {
  const effects = callArguments(SOURCE, "useEffect");

  it("scans a plausible number of useEffect call sites", () => {
    // Sanity check on the scanner: an empty list would make every assertion
    // below pass vacuously.
    expect(effects.length).toBeGreaterThanOrEqual(3);
  });

  it("no effect computes the kind-template seed", () => {
    const seeding = effects.filter((body) => /kindTemplateSeedPatch/.test(body));
    expect(
      seeding,
      "seeding anchors from the kind template must be a user action. An effect " +
        "that appends template rows puts a hit-tested `intercept_out` at the " +
        "body origin into the draft of every asset the user merely opens.",
    ).toEqual([]);
  });

  it("no effect appends to the anchor list at all", () => {
    // The pre-2026-09-23 shape, named so a revert that inlines the seed again
    // (rather than calling the helper) is caught too.
    const appending = effects.filter((body) => /anchors:\s*\[[\s\S]*?\.\.\.draft\.anchors/.test(body));
    expect(appending).toEqual([]);
  });

  it("wires the seed to a click", () => {
    expect(SOURCE).toMatch(/const seedFromKindTemplate = \(\) => \{/);
    expect(SOURCE).toMatch(/onClick=\{seedFromKindTemplate\}/);
  });
});
