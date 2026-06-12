/**
 * Kind Registry — central catalog of PhysicsOps and per-kind metadata.
 *
 * The registry lives in code (not DB): every PhysicsOp implementation
 * is registered here by name, and Asset3D records reference ops by
 * string. This decouples Asset3D data (which faces, which transitions,
 * which op name) from the actual op implementation (TypeScript today,
 * Rust+WASM in Phase 5+).
 *
 * Each op is a pure function: (BeamRay, ctx) → BeamRay[]. The ray
 * tracer is responsible for face-hit detection, frame transforms, and
 * dispatching to the right op based on `transition.op` string.
 */

import type { BeamRay, Vec3 } from "./beam-ray";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Top-level optical kind taxonomy. Extends as new kinds are added. */
export type OpticalKind =
  | "laser_source"
  | "tapered_amplifier"
  | "lens"
  | "mirror"
  | "dichroic_mirror"
  | "polarizer"
  | "waveplate"
  | "beam_splitter"
  | "pbs"
  | "aom"
  | "eom"
  | "faraday_rotator"
  | "fiber_coupler"
  | "fiber"
  | "fiber_end"
  | "isolator"
  | "nonlinear_crystal"
  | "saturable_absorber"
  | "detector"
  | "camera"
  | "spectrometer"
  | "wavemeter"
  | "beam_dump";

/** Face descriptor (from Asset3D.faces). Subset needed by ops. */
export type Face = {
  id: string;
  positionMmBodyLocal: Vec3;
  normalBodyLocal?: Vec3;
  apertureMm: number;
  apertureShape: "rectangle" | "ellipse" | "circle";
};

/** Geometric transfer matrix attached to a transition. Three forms:
 *   - `abcd`:    2×2 (applies equally to qx and qy)
 *   - `abcdXY`:  separate 2×2 for x and y axes (astigmatic elements)
 *   - `matrix5x5`: full 5×5 (with absolute-offset E_x/E_y term)
 *  The op chooses which form to consume. */
export type TransferMatrix =
  | { kind: "abcd"; M: [[number, number], [number, number]] }
  | { kind: "abcdXY";
      Mx: [[number, number], [number, number]];
      My: [[number, number], [number, number]];
    }
  | { kind: "matrix5x5"; M: number[] /* row-major flat, length 25 */ };

/** Free-form parameter bag (merged from asset.defaultParams ⊕ dynamicSources). */
export type KindParams = Record<string, unknown>;

/** Dynamic per-instance state from SceneObject (laser power, AOM freq, ...). */
export type DynamicSources = Record<string, unknown>;

/** Context passed to every PhysicsOp call. */
export type PhysicsOpContext = {
  faceIn: Face;
  faceOut: Face;
  params: KindParams;
  dynamic?: DynamicSources;
  transferMatrix?: TransferMatrix;
  /** Internal face chain for multi-hop reflective elements (see
   *  asset-physics-model.md §3.3). Tracer applies mirror at B*-prefixed
   *  faces, Snell at A*-prefixed. Empty/undefined = 2-port slab. */
  faceVia?: Face[];
};

/** A PhysicsOp transforms one input ray into zero or more output rays.
 *  Pure function (no side effects, no DOM, no THREE). */
export type PhysicsOp = (rayIn: BeamRay, ctx: PhysicsOpContext) => BeamRay[];

/** Per-kind metadata registered alongside ops. */
export type KindEntry = {
  ops: Record<string, PhysicsOp>;     // op name → impl
  needsAperture: boolean;
  defaultWavelengthRangeNm?: [number, number];
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY: Partial<Record<OpticalKind, KindEntry>> = {};

/** Register a kind's metadata and ops. Called once per kind module at
 *  import time (e.g. `kinds/lens/physics.ts` calls `registerKind("lens", ...)`). */
export function registerKind(kind: OpticalKind, entry: KindEntry): void {
  if (REGISTRY[kind]) {
    throw new Error(`kind "${kind}" already registered`);
  }
  REGISTRY[kind] = entry;
}

/** Add additional ops to an already-registered kind without re-declaring
 *  it. Used by variant modules (e.g. `kinds/glan-laser` adds glan_transmit_p
 *  / glan_reject_s under the existing `polarizer` kind). */
export function registerOps(kind: OpticalKind, ops: Record<string, PhysicsOp>): void {
  const entry = REGISTRY[kind];
  if (!entry) {
    throw new Error(
      `registerOps: kind "${kind}" not registered yet — import its base module first`,
    );
  }
  for (const [name, op] of Object.entries(ops)) {
    if (name in entry.ops) {
      throw new Error(
        `registerOps: op "${name}" already registered under kind "${kind}"`,
      );
    }
    entry.ops[name] = op;
  }
}

/** Look up a PhysicsOp by kind + op name. Throws if not found —
 *  callers should validate Asset3D.transitions[].op against registry
 *  at load time, not at trace time. */
export function getOp(kind: OpticalKind, opName: string): PhysicsOp {
  const entry = REGISTRY[kind];
  if (!entry) throw new Error(`kind "${kind}" not registered`);
  const op = entry.ops[opName];
  if (!op) throw new Error(`op "${opName}" not found in kind "${kind}"`);
  return op;
}

/** Predicate version of `getOp` — useful for validation. */
export function hasOp(kind: OpticalKind, opName: string): boolean {
  const entry = REGISTRY[kind];
  return !!entry && opName in entry.ops;
}

/** List all registered kinds (debug / introspection). */
export function listRegisteredKinds(): OpticalKind[] {
  return Object.keys(REGISTRY) as OpticalKind[];
}

/** Test-only: clear registry. Avoid in production code. */
export function _clearRegistryForTests(): void {
  for (const k of Object.keys(REGISTRY)) {
    delete REGISTRY[k as OpticalKind];
  }
}
