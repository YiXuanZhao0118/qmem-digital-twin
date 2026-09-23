/**
 * The PHY Editor's anchor READ/WRITE round-trip, as pure data.
 *
 * Split out of `components/Asset3DEditor.tsx` (2026-09-23) so the one
 * invariant that matters here can be tested without mounting a 4000-line
 * React component around a three.js viewer:
 *
 *   **An anchor the user did not edit must be written back exactly as it was
 *   read.** Save sends the WHOLE anchor list (`Asset3DV3Update.anchors` has no
 *   partial form), so every untouched row rides along on any edit — and every
 *   lossy step in `stored → draft → stored` silently rewrites rows nobody
 *   touched. Two such steps were live until this split:
 *
 *   1. `deriveOrthonormalBasis` re-normalised axisX and Gram-Schmidt'd axisY on
 *      every save. Float64 is not idempotent under that, so a no-op save moved
 *      3 of the live catalog's 76 anchors by ~1e-16 per component
 *      (`30126a9_step:fiber_out`, `intercept_face` on `pbs055` and on
 *      `pbs122_step`) — an anchor authored from a device template drifts off the
 *      template and re-grades itself "overridden" (see `gradeAnchor`).
 *      Whether a given frame survives comes down to its last bit:
 *      `pbs252_step` carries the same 45° frame and happened to round-trip.
 *   2. `readNumber("")` is `Number("")` = 0, so a blank aperture field wrote
 *      `apertureMm: 0` — and a synthesised `apertureShape` — onto the 5 anchors
 *      that carry no aperture at all. 8 rewritten rows in total.
 *
 *   `backend/scripts/wire_remaining_device_ids.py`'s docstring is the same
 *   lesson from the API side: it sends the stored anchors back verbatim
 *   precisely so the server's re-materialisation cannot round-trip the frame.
 *
 * The fix is `pristine`: each draft row keeps the stored anchor it was built
 * from, and `anchorPayloadFromDraft` returns that object untouched while the
 * row still reads back identical to it (`anchorDraftIsPristine`). Edit any
 * field and the row is re-derived as before. Invariant, pinned by
 * `utils/__tests__/anchorDraftRoundTrip.test.ts`: for anchors read off a live
 * asset, `anchorPayloadFromDraft(draftAnchorFromStored(a)) === a`.
 */

/** Draft row in the PHY Editor's Anchors table (Phase 9.8 — replaces
 *  the old Faces table). Each anchor has a position + two body-local
 *  axes the user edits directly:
 *    - axisX (nx/ny/nz): propagation / face normal
 *    - axisY (yx/yy/yz): transverse reference (slow axis for PM fiber,
 *                        fast axis for waveplate, transmission axis
 *                        for polarizer, acoustic axis for AOM, etc.)
 *  axisZ is derived as X × Y on save (after Gram-Schmidt orthogonalizing
 *  Y against X), so we don't store it in the draft. */
export type DraftAnchor = {
  id: string;
  px: string;
  py: string;
  pz: string;
  nx: string;
  ny: string;
  nz: string;
  yx: string;
  yy: string;
  yz: string;
  apertureMm: string;
  apertureShape: "rectangle" | "ellipse" | "circle";
  apertureWidthMm: string;
  apertureHeightMm: string;
  /** Coax connector on RF / TTL ports. Empty string = none (optical
   *  anchors). Only edited when the anchor's domain is rf / ttl / trigger
   *  (see the anchor table's per-row gating). */
  connectorType: string;
  /** Display name for anchors sharing an id (rf_switch RF1/RF2, AD9959
   *  CH0..CH3). Empty string = no name (falls back to id on save). The
   *  RF Link panel + solver key throws/channels by this. */
  name: string;
  /** The stored anchor this row was built from, or null for a row the editor
   *  invented (kind-template seed, device seed, "+ Anchor"). While the row
   *  still reads back identical to this, Save writes THIS object — see the
   *  module docstring. */
  pristine: Record<string, unknown> | null;
};

/** Number -> draft-field text. MUST stay lossless (`String`, not `toFixed`):
 * the draft fields are the anchor WRITE path, and anchor poses carry a
 * 1 µm / 0.1 µrad budget (docs/objectives.md O-1/O-2). A previous
 * `toFixed(3)` helper here quantised positions to 1 µm and direction
 * components to ~870 µrad — see docs/float64-audit.md §2.1. */
export function n(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

export function readNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a finite number`);
  }
  return parsed;
}

export function readOptionalNumber(value: string, label: string): number | null {
  if (value.trim() === "") return null;
  return readNumber(value, label);
}

export function readDraftNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Build an orthonormal body-local basis from user-provided axisX +
 *  axisY. axisX is normalized; axisY is Gram-Schmidt orthogonalized
 *  against axisX (any component along X is projected out) then
 *  normalized; axisZ = axisX × axisY. The user-facing axisY *direction*
 *  is preserved as much as possible — this is the semantic axis (slow
 *  / fast / transmission / acoustic). If axisY is parallel to axisX
 *  (degenerate), fall back to world +Y or +Z whichever is less
 *  parallel to X. */
export function deriveOrthonormalBasis(
  ax: { x: number; y: number; z: number },
  ay: { x: number; y: number; z: number },
): {
  axisX: { x: number; y: number; z: number };
  axisY: { x: number; y: number; z: number };
  axisZ: { x: number; y: number; z: number };
} {
  const xLen = Math.hypot(ax.x, ax.y, ax.z);
  if (xLen < 1e-9) {
    throw new Error("axisX direction must be non-zero (set nx/ny/nz)");
  }
  const X = { x: ax.x / xLen, y: ax.y / xLen, z: ax.z / xLen };

  // Pick the user's axisY; fall back to a world axis if degenerate.
  let Yseed = ay;
  if (Math.hypot(ay.x, ay.y, ay.z) < 1e-9) {
    Yseed = Math.abs(X.y) > 0.95 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  }
  // Gram-Schmidt: Y' = Yseed − (Yseed·X) X
  let dotYX = Yseed.x * X.x + Yseed.y * X.y + Yseed.z * X.z;
  let Yp = {
    x: Yseed.x - dotYX * X.x,
    y: Yseed.y - dotYX * X.y,
    z: Yseed.z - dotYX * X.z,
  };
  let yLen = Math.hypot(Yp.x, Yp.y, Yp.z);
  if (yLen < 1e-9) {
    // axisY collapsed onto axisX — Yseed was parallel to X. Pick a
    // world fallback that's not parallel to X.
    Yseed = Math.abs(X.y) > 0.95 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
    dotYX = Yseed.x * X.x + Yseed.y * X.y + Yseed.z * X.z;
    Yp = {
      x: Yseed.x - dotYX * X.x,
      y: Yseed.y - dotYX * X.y,
      z: Yseed.z - dotYX * X.z,
    };
    yLen = Math.hypot(Yp.x, Yp.y, Yp.z);
  }
  const Y = { x: Yp.x / yLen, y: Yp.y / yLen, z: Yp.z / yLen };
  const Z = {
    x: X.y * Y.z - X.z * Y.y,
    y: X.z * Y.x - X.x * Y.z,
    z: X.x * Y.y - X.y * Y.x,
  };
  return { axisX: X, axisY: Y, axisZ: Z };
}

/** Stored anchor (the `anchors[]` JSONB element) -> editor draft row.
 *
 *  The column has historical schema drift: clean Phase 9.1 rows use camelCase
 *  (`positionMmBodyLocal`, `axisXBodyLocal`), but older backfills wrote
 *  snake_case (`position_mm_body_local`, `direction_body_local`) plus extra
 *  `name` / `type` fields. Read both shapes and project down to the editor's
 *  draft form (position + axisX as the "normal"). */
export function draftAnchorFromStored(rawAnchor: unknown): DraftAnchor {
  const a = (rawAnchor ?? {}) as Record<string, unknown>;
  const pos = (a.positionMmBodyLocal ?? a.position_mm_body_local ?? {}) as {
    x?: number; y?: number; z?: number;
  };
  const axisX = (a.axisXBodyLocal ?? a.direction_body_local ?? {}) as {
    x?: number; y?: number; z?: number;
  };
  const axisY = (a.axisYBodyLocal ?? {}) as {
    x?: number; y?: number; z?: number;
  };
  const apertureMm = (a.apertureMm ?? a.aperture_mm) as number | undefined;
  const apertureShape = (a.apertureShape ?? a.aperture_shape) as
    | DraftAnchor["apertureShape"]
    | undefined;
  const apertureWidthMm = (a.apertureWidthMm ?? a.aperture_width_mm) as
    | number
    | undefined;
  const apertureHeightMm = (a.apertureHeightMm ?? a.aperture_height_mm) as
    | number
    | undefined;
  const connectorType = (a.connectorType ?? a.connector_type) as
    | string
    | undefined;
  const anchorName = a.name as string | undefined;
  // axisY default = world +Y when unset. The serializer will
  // Gram-Schmidt-orthogonalize it against axisX, so as long as Y
  // isn't parallel to X the result is well-defined.
  return {
    id: String(a.id ?? ""),
    px: n(pos.x),
    py: n(pos.y),
    pz: n(pos.z),
    nx: n(axisX.x),
    ny: n(axisX.y),
    nz: n(axisX.z),
    yx: n(axisY.x ?? 0),
    yy: n(axisY.y ?? 1),
    yz: n(axisY.z ?? 0),
    apertureMm: n(apertureMm),
    apertureShape: apertureShape ?? "circle",
    apertureWidthMm: n(apertureWidthMm),
    apertureHeightMm: n(apertureHeightMm),
    connectorType: connectorType ?? "",
    name: anchorName ?? "",
    pristine: (a as Record<string, unknown>) ?? null,
  };
}

/** Every field the anchor table can edit. Two rows that agree on all of them
 *  describe the same anchor, so a row that still equals the one
 *  `draftAnchorFromStored` produced has not been touched. Deliberately NOT
 *  `Object.keys` — `pristine` itself must stay out of the comparison. */
const EDITABLE_FIELDS = [
  "id",
  "px", "py", "pz",
  "nx", "ny", "nz",
  "yx", "yy", "yz",
  "apertureMm", "apertureShape", "apertureWidthMm", "apertureHeightMm",
  "connectorType", "name",
] as const;

/** True when this row still reads back exactly as the anchor it was built
 *  from — i.e. the user has not touched it, so Save must not rewrite it. */
export function anchorDraftIsPristine(anchor: DraftAnchor): boolean {
  if (!anchor.pristine) return false;
  const asRead = draftAnchorFromStored(anchor.pristine);
  return EDITABLE_FIELDS.every((key) => anchor[key] === asRead[key]);
}

/** Draft row -> the anchor to persist.
 *
 *  Untouched rows are returned as read (see the module docstring). An edited
 *  or invented row is re-derived: axisX normalised, axisY Gram-Schmidt'd,
 *  axisZ = X × Y. `index` only names the row in the error message. */
export function anchorPayloadFromDraft(
  anchor: DraftAnchor,
  index: number,
): Record<string, unknown> {
  if (anchorDraftIsPristine(anchor)) return anchor.pristine!;

  const id = anchor.id.trim();
  if (!id) throw new Error(`anchor ${index + 1} id is required`);
  const aperture = readOptionalNumber(anchor.apertureMm, `${id}.apertureMm`);
  const width = readOptionalNumber(anchor.apertureWidthMm, `${id}.apertureWidthMm`);
  const height = readOptionalNumber(anchor.apertureHeightMm, `${id}.apertureHeightMm`);
  const { axisX, axisY, axisZ } = deriveOrthonormalBasis(
    {
      x: readNumber(anchor.nx, `${id}.axisX.x`),
      y: readNumber(anchor.ny, `${id}.axisX.y`),
      z: readNumber(anchor.nz, `${id}.axisX.z`),
    },
    {
      x: readNumber(anchor.yx, `${id}.axisY.x`),
      y: readNumber(anchor.yy, `${id}.axisY.y`),
      z: readNumber(anchor.yz, `${id}.axisY.z`),
    },
  );
  return {
    id,
    positionMmBodyLocal: {
      x: readNumber(anchor.px, `${id}.position.x`),
      y: readNumber(anchor.py, `${id}.position.y`),
      z: readNumber(anchor.pz, `${id}.position.z`),
    },
    axisXBodyLocal: axisX,
    axisYBodyLocal: axisY,
    axisZBodyLocal: axisZ,
    // A blank aperture field means "no aperture", which is what an absent
    // key means to the loader (`db_scene_loader` defaults it to 0, and
    // `anchor_tracer` gates the clear-aperture test on `> 0`). Writing 0
    // would change nothing physically but WOULD add a key the row never had.
    ...(aperture !== null ? { apertureMm: aperture } : {}),
    apertureShape: anchor.apertureShape,
    ...(width !== null ? { apertureWidthMm: width } : {}),
    ...(height !== null ? { apertureHeightMm: height } : {}),
    // Only RF / TTL anchors carry a connector; optical anchors leave
    // it empty and the field is omitted (stays null in the JSONB).
    ...(anchor.connectorType.trim() ? { connectorType: anchor.connectorType.trim() } : {}),
    // Preserve the per-anchor name (RF1/RF2/TTL, CH0..CH3). Omitted when
    // empty so single-port anchors stay nameless and fall back to id.
    ...(anchor.name.trim() ? { name: anchor.name.trim() } : {}),
  };
}
