/**
 * Static guard on the PHY Editor's anchor WRITE path.
 * See docs/float64-audit.md §2.1 / §2.3 and docs/objectives.md O-1/O-2.
 *
 * The anchor draft fields ARE the write path: whatever string sits in them is
 * what Save persists. A `toFixed(3)` helper on that path once quantised
 * positions to 1 µm and direction components to ~870 µrad, against a
 * 1 µm / 0.1 µrad budget. It read as harmless display formatting, which is
 * exactly why it needs a test and not just a comment.
 *
 * A source scan rather than a behavioural test: the write paths are closures
 * inside a React component, not exported, and the invariant is about which
 * helper gets called rather than about any single output value.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../Asset3DEditor.tsx", import.meta.url)),
  "utf8",
);

/** Every argument list passed to `fnName(...)`, matched with balanced parens
 *  so nested calls and object literals come back whole. The arrow-function
 *  definition (`const fnName = (...)`) does not match and is skipped. */
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

const LOSSY = /\btoFixed\s*\(|\btoPrecision\s*\(|\bMath\.round\s*\(/;

describe("anchor write path stays lossless", () => {
  it("scans a plausible number of updateAnchor call sites", () => {
    // Sanity check on the scanner itself: if a refactor renames the writer,
    // the assertions below would vacuously pass over an empty list.
    expect(callArguments(SOURCE, "updateAnchor").length).toBeGreaterThanOrEqual(10);
  });

  it("never rounds a value on its way into the anchor draft", () => {
    const lossy = callArguments(SOURCE, "updateAnchor").filter((args) => LOSSY.test(args));
    expect(
      lossy,
      "anchor writes must stay float64. Use the lossless `n()` (String), not " +
        "toFixed/toPrecision/Math.round — 3 decimals costs the whole 1 µm " +
        "position budget and ~870 µrad on a direction component.",
    ).toEqual([]);
  });

  it("has no mmText helper", () => {
    // The specific helper the audit removed. Named explicitly so a revert
    // fails loudly rather than quietly reintroducing the quantisation.
    expect(SOURCE).not.toMatch(/\bmmText\b/);
  });
});

describe("anchor inputs keep their step contract", () => {
  const anchorInputLines = SOURCE.split("\n").filter((line) =>
    line.includes("step={ANCHOR_STEP}"),
  );

  it("applies ANCHOR_STEP to the position and both axis triples", () => {
    // 3 position + 3 axisX + 3 axisY.
    expect(anchorInputLines).toHaveLength(9);
  });

  it("keeps ANCHOR_STEP at or below 1 µm", () => {
    const declared = SOURCE.match(/const ANCHOR_STEP = "([^"]+)"/);
    expect(declared, "ANCHOR_STEP declaration not found").not.toBeNull();
    expect(Number(declared![1])).toBeLessThanOrEqual(0.001);
  });

  it("keeps those inputs controlled", () => {
    // Load-bearing, and not obvious: `step` is also an HTML validity
    // constraint, and the step base falls back to the `value` content
    // attribute when there is no `min`. React mirrors the value into that
    // attribute, so a 17-digit anchor value always sits on its own grid.
    // Going uncontrolled removes the attribute and marks every
    // full-precision anchor :invalid. docs/float64-audit.md §2.3.
    for (const line of anchorInputLines) {
      expect(line).toContain("value={");
      expect(line).not.toContain("defaultValue");
    }
  });
});
