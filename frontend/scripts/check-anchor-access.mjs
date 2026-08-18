#!/usr/bin/env node
// Guard: forbid raw access to asset anchor fields outside the canonical
// helpers. Direct reads make dynamic-anchor handling and future field
// renames hard to audit, so we enforce by grep.
//
// Allowed files (raw access OK):
//   - utils/anchorAccess.ts            (the canonical helper)
//   - types/digitalTwin.ts             (schema definition)
//   - utils/fiberAnchorResolver.ts     (returns body-local by design)
//   - utils/rfCableAnchorResolver.ts   (returns body-local by design)
//   - utils/v2Bindings.ts              (V2 binding read, body-local)
//   - store/sceneStore.ts              (raw store / API I/O)
//   - components/Asset3DEditor.tsx     (raw asset editor ??write side)
//   - components/ComponentsEditor.tsx  (same)
//   - components/DevicesEditor.tsx     (device anchor TEMPLATES, not asset
//                                       anchors ??the authoring write side)
//   - optical/__tests__/parity/runner.ts (parity fixture loader)
//   - optical/ray-tracer-v3.ts         (V3 in-browser tracer)
//   - optical/kinds/**/physics.ts      (per-kind physics)
//   - optical/registry.ts              (kinds metadata)
//   - kinds/isolator/pbsOverlay.ts     (PBS overlay reads anchor raw)
//   - kinds/rf_source/index.ts         (TBD audit)
//   - any *.test.ts / *.test.tsx       (tests)
//   - any file under __tests__/
//
// Per-line opt-out: append `/* raw-anchor-ok: <reason> */` to a line
// to suppress the warning for that single line (e.g. AomAdjustControls
// keeps raw values for physics-internal D1/D2/D3 derivation).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..", "src");

const ALLOWED = new Set([
  "utils/anchorAccess.ts",
  "types/digitalTwin.ts",
  "utils/fiberAnchorResolver.ts",
  "utils/rfCableAnchorResolver.ts",
  "utils/v2Bindings.ts",
  "store/sceneStore.ts",
  "components/Asset3DEditor.tsx",
  "components/ComponentsEditor.tsx",
  "components/DevicesEditor.tsx",
  "optical/__tests__/parity/runner.ts",
  "optical/ray-tracer-v3.ts",
  "optical/registry.ts",
  "kinds/isolator/pbsOverlay.ts",
]);

const ALLOWED_PREFIXES = [
  "optical/kinds/",
  "kinds/rf_source/",
];

const FORBIDDEN_PATTERN =
  /\.(positionMmBodyLocal|axisXBodyLocal|axisYBodyLocal|axisZBodyLocal|directionBodyLocal)\b/;

const PERMIT_MARKER = /raw-anchor-ok/;

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

function isAllowed(relPath) {
  const normalized = relPath.replace(/\\/g, "/");
  if (ALLOWED.has(normalized)) return true;
  if (/__tests__\//.test(normalized)) return true;
  if (/\.test\.(ts|tsx)$/.test(normalized)) return true;
  for (const prefix of ALLOWED_PREFIXES) {
    if (normalized.startsWith(prefix)) return true;
  }
  return false;
}

const violations = [];
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (isAllowed(rel)) continue;
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!FORBIDDEN_PATTERN.test(line)) continue;
    if (PERMIT_MARKER.test(line)) continue;
    // Marker may also sit on the immediately preceding line ??handy when
    // the offending expression is inside a template literal that can't
    // host an inline comment.
    if (i > 0 && PERMIT_MARKER.test(lines[i - 1])) continue;
    // Skip JSDoc / single-line comment lines ??they mention the field
    // by name in prose but don't access it.
    const trimmedLine = line.trimStart();
    if (trimmedLine.startsWith("*") || trimmedLine.startsWith("//")) continue;
    // Skip lines that are pure type / interface property declarations:
    //   positionMmBodyLocal: { x: number; y: number; z: number };
    // (these don't actually READ the field). Heuristic: a `:` separates
    // the name from the type, no `.` precedes the field name.
    const trimmed = line.trimStart();
    if (/^\w+\s*\?\s*:/.test(trimmed) || /^(readonly\s+)?\w+\s*:/.test(trimmed)) {
      // Likely a TS field declaration like `positionMmBodyLocal?: { ... }`.
      // Real access would be `.positionMmBodyLocal` ??already matched by the
      // pattern, but a bare declaration starts with the name (no leading dot).
      if (!/\.\s*(positionMmBodyLocal|axisXBodyLocal|axisYBodyLocal|axisZBodyLocal|directionBodyLocal)\b/.test(line)) {
        continue;
      }
    }
    violations.push({ file: rel, line: i + 1, code: line.trim() });
  }
}

if (violations.length === 0) {
  console.log("anchor-access guard: OK");
  process.exit(0);
}

console.error("\nanchor-access guard: VIOLATIONS\n");
console.error(
  "Direct access to body-frame anchor fields detected outside the\n" +
  "allowlist (utils/anchorAccess.ts + a few opt-in writers/physics).\n" +
  "Use anchorObjectLocalPos / anchorObjectLocalAxisX / ... from\n" +
  "utils/anchorAccess.ts instead ??those return values already in the\n" +
  "object-local CAD frame, ready to compose with SceneObject pose.\n" +
  "If you genuinely need raw body-frame access (e.g. body-frame physics),\n" +
  "append `/* raw-anchor-ok: <reason> */` to the offending line.\n",
);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    ${v.code}`);
}
console.error(`\n${violations.length} violation(s).`);
process.exit(1);
