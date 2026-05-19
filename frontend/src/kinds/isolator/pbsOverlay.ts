/**
 * Isolator visualisation — single-file home for the isolator's:
 *   1. Per-model PBS pose table (`ISOLATOR_PBS_DEFAULTS_BY_MODEL`)
 *   2. PBS mini-cube renderer (`buildPbsMiniCube`)
 *   3. PBS overlay group builder (`buildIsolatorPbsOverlay`) — shared
 *      between TORNOS procedural renderer and the Thorlabs IO-series STL
 *      pipeline.
 *   4. Thorlabs STL isolator handler (`isThorlabsIsolatorAsset`,
 *      `buildThorlabsIsolatorObject`) — wraps the IO-series STL with a
 *      semi-transparent housing + PBS overlay.
 *
 * Plugin contract + dev page live in sibling files (`index.ts`,
 * `IsolatorDevPage.tsx`).
 */
import * as THREE from "three";

import type { Anchor, Asset3D, ComponentItem } from "../../types/digitalTwin";

// =============================================================================
// (1) Per-model PBS pose table — `component.model` → custom defaults.
// =============================================================================

/** Polariser type at each end of the isolator. PBS cubes (cement-bonded
 *  thin-film coating) are the default; high-power models (Thorlabs HP
 *  suffix, Newport "HP") use **Glan-Laser** crystal prisms with an air
 *  gap, which have a much higher damage threshold. */
export type IsolatorPrismType = "pbs_cube" | "glan_laser";

export type PbsPoseEntry = {
  /** PBS cube centre, body-local Z-up millimetres. */
  pos: [number, number, number];
  /** **Recommended way.** Cube starts at canonical pose (cement-plane
   *  normal = [1, 1, 0] body-local, 45° in xy plane), then rotates around
   *  body Y axis by this many degrees. Single DOF — every rotation lands
   *  on a face-diagonal normal (y-component stays = 1), i.e. always a
   *  PHYSICALLY valid PBS orientation.
   *
   *  Reference values (cement normal in body-local after rotation):
   *      0° → [ 1, 1,  0]  (canonical)
   *     90° → [ 0, 1, -1]
   *    180° → [-1, 1,  0]  (mirror of 0°)
   *    −90° → [ 0, 1,  1]
   *
   *  Takes precedence over `dir` and `rotationDeg` when set. */
  yRotationDeg?: number;
  /** Free PBS cement-plane normal (body-local Z-up). Use when you need an
   *  orientation that `yRotationDeg` can't reach (e.g. cement normal with
   *  zero y-component). Realistic PBS values have ONE component zero. */
  dir?: [number, number, number];
  /** Free 3-axis Euler [rxDeg, ryDeg, rzDeg] body-local, XYZ order. Only
   *  needed for non-PBS-physical visual tilts. */
  rotationDeg?: [number, number, number];
  /** Polariser type — defaults to `"pbs_cube"`. Set `"glan_laser"` for
   *  high-power models that use two calcite prisms with an air gap
   *  instead of a cement-bonded cube. */
  prismType?: IsolatorPrismType;
};

/** Per-isolator-model PBS pose overrides. Key = `component.model` (e.g.
 *  "IO-3-850-HP", "TORNOS-850-4").
 *
 *  Precedence (highest first):
 *    1. asset.anchors saved via PHY Editor → Save (DB row)
 *    2. This table (when component.model matches a key)
 *    3. Generic algorithmic fallback (±25% of housing length along optical
 *       axis, 45° tilted cement normals 90° apart around optical axis) */
export const ISOLATOR_PBS_DEFAULTS_BY_MODEL: Record<string, {
  front_pbs: PbsPoseEntry;
  back_pbs: PbsPoseEntry;
}> = {
  // All 7 isolators pre-filled. Edit `pos` (body-local Z-up mm) and
  // `yRotationDeg` (degrees, single-DOF rotation around body Y) per row.
  // Canonical pose (yRotationDeg=0) = cement normal [1, 1, 0].
  // `prismType` defaults to "pbs_cube"; HP suffix → "glan_laser".
  "IO-3-850-HP":    { front_pbs: { pos: [0, 70, +13], yRotationDeg: 135, prismType: "glan_laser" },
                      back_pbs:  { pos: [0,  0, +13], yRotationDeg:   0, prismType: "glan_laser" } },
  "IO-3D-850-VLP":  { front_pbs: { pos: [0,   4, 0], yRotationDeg:  0 },
                      back_pbs:  { pos: [0,  27, 0], yRotationDeg: 90 } },
  "IO-5-850-HP":    { front_pbs: { pos: [0, 0, -18], yRotationDeg:  0, prismType: "glan_laser" },
                      back_pbs:  { pos: [0, 0, +18], yRotationDeg: 90, prismType: "glan_laser" } },
  "IO-5-850-VLP":   { front_pbs: { pos: [0,   5, 0], yRotationDeg:  0 },
                      back_pbs:  { pos: [0,  60, 0], yRotationDeg: 90 } },
  "IOT-5-850-VLP":  { front_pbs: { pos: [0, -27, 0], yRotationDeg:  0 },
                      back_pbs:  { pos: [0,  65, 0], yRotationDeg: 90 } },
  "IOT-5-850-MP":   { front_pbs: { pos: [0,  -2, 0], yRotationDeg:  0 },
                      back_pbs:  { pos: [0,  95, 0], yRotationDeg: 90 } },
  "TORNOS-850-4":   { front_pbs: { pos: [0, 0, -13], yRotationDeg:  0 },
                      back_pbs:  { pos: [0, 0, +13], yRotationDeg: 90 } },
};

// =============================================================================
// (2) PBS mini-cube renderer.
// =============================================================================

const ISOLATOR_PBS_CUBE_SIZE_MM = 5;

function buildPbsMiniCube(sizeUnit: number): THREE.Object3D {
  const glass = new THREE.MeshPhysicalMaterial({
    color: "#f4faf6",
    metalness: 0,
    roughness: 0.05,
    transmission: 1.0,
    thickness: sizeUnit * 0.5,
    ior: 1.52,
    attenuationColor: new THREE.Color("#d0e7dc"),
    attenuationDistance: sizeUnit * 2,
    iridescence: 0.4,
    iridescenceIOR: 1.4,
    iridescenceThicknessRange: [220, 580],
    transparent: false,
    opacity: 1,
    envMapIntensity: 1.4,
  });
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(sizeUnit, sizeUnit, sizeUnit),
    glass,
  );

  // Cement interface between the two 45°-45°-90° prisms that make up a PBS
  // cube. Goes edge-to-edge across one face diagonal, splitting the cube into
  // two right-angle triangular prisms. Canonical orientation: plane contains
  // the Y axis and the (+X, +Z) → (-X, -Z) diagonal; normal = (1, 0, 1)/√2.
  // Caller's alignment maps this canonical normal to the anchor's
  // directionBodyLocal so the whole cube (both prisms) rotates together.
  const coatingMat = new THREE.MeshPhysicalMaterial({
    color: "#e89aa8",
    metalness: 0.1,
    roughness: 0.2,
    transmission: 0.35,
    thickness: sizeUnit * 0.05,
    ior: 1.5,
    iridescence: 0.85,
    iridescenceIOR: 1.6,
    iridescenceThicknessRange: [350, 700],
    transparent: false,
    opacity: 1,
    side: THREE.DoubleSide,
    envMapIntensity: 1.2,
  });
  const coating = new THREE.Mesh(
    new THREE.PlaneGeometry(sizeUnit * Math.SQRT2, sizeUnit),
    coatingMat,
  );
  coating.rotation.y = Math.PI / 4;

  const group = new THREE.Group();
  group.add(cube);
  group.add(coating);
  return group;
}

function findAnchorByName(
  asset: Asset3D | null | undefined,
  name: string,
): Anchor | undefined {
  return asset?.anchors?.find(
    (a) => a.name === name || a.id === name,
  );
}

/** Build a physically-accurate Glan-Laser polariser pair — two calcite
 *  right-angle prisms separated by a thin air gap along their hypotenuse
 *  faces.
 *
 *  Geometry (physical frame, before alignment rotation):
 *    - Aperture: `sizeUnit × sizeUnit` (X, Y)
 *    - Length:   `sizeUnit / tan(wedgeAngle)` along Z (optical axis)
 *    - Cut plane: tilts `wedgeAngle` from optical axis. Goes from the
 *                 +Y/-Z edge of the box to the -Y/+Z edge.
 *    - Wedge angle 38° matches calcite Glan-Laser specs at 850 nm
 *      (near-Brewster for E-ray transmission, TIR for O-ray; the rejected
 *      O-ray exits the side at ~68° via the escape window).
 *
 *  The whole assembly is then rotated so the cut-plane outward normal
 *  (from Prism A) aligns with the canonical cement normal (1, 0, 1)/√2 —
 *  this lets the caller's anchor-alignment quaternion logic stay the
 *  same for both `pbs_cube` and `glan_laser` prism types. */
function buildGlanLaserPrism(sizeUnit: number): THREE.Object3D {
  const wedgeAngleDeg = 38;
  const wedgeRad = (wedgeAngleDeg * Math.PI) / 180;

  const a = sizeUnit;
  const L = a / Math.tan(wedgeRad);
  const ha = a / 2;
  const hL = L / 2;

  // Calcite-like material (clear with a slight cool tint).
  const crystal = new THREE.MeshPhysicalMaterial({
    color: "#e8f3ff",
    metalness: 0,
    roughness: 0.04,
    transmission: 0.92,
    thickness: a * 0.5,
    ior: 1.66,
    attenuationColor: new THREE.Color("#c5dcf2"),
    attenuationDistance: a * 4,
    transparent: false,
    opacity: 1,
    envMapIntensity: 1.5,
  });

  // Box corners (physical frame, optical axis = Z).
  // Bottom (Y = -ha): 0..3; top (Y = +ha): 4..7.
  const c: number[][] = [
    [-ha, -ha, -hL], [+ha, -ha, -hL], [+ha, -ha, +hL], [-ha, -ha, +hL],
    [-ha, +ha, -hL], [+ha, +ha, -hL], [+ha, +ha, +hL], [-ha, +ha, +hL],
  ];
  // Cut plane: L*y + a*z = 0. Passes through corners 2, 3, 4, 5.
  //   Prism A (L*y + a*z > 0, contains 6, 7) — outward cut normal (0,-L,-a)
  //   Prism B (L*y + a*z < 0, contains 0, 1) — outward cut normal (0,+L,+a)

  const buildPrismGeom = (tris: number[][]): THREE.BufferGeometry => {
    const verts: number[] = [];
    for (const t of tris) {
      for (const ci of t) verts.push(c[ci][0], c[ci][1], c[ci][2]);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geom.computeVertexNormals();
    return geom;
  };

  // Prism A face triangulation (CCW from outside):
  //   +X end: (2, 5, 6)
  //   -X end: (3, 7, 4)
  //   +Y face: (4, 6, 5), (4, 7, 6)
  //   +Z face: (2, 7, 3), (2, 6, 7)
  //   cut face (outward -Y-Z): (2, 3, 4), (2, 4, 5)
  const prismAGeom = buildPrismGeom([
    [2, 5, 6], [3, 7, 4],
    [4, 6, 5], [4, 7, 6],
    [2, 7, 3], [2, 6, 7],
    [2, 3, 4], [2, 4, 5],
  ]);
  // Prism B face triangulation:
  //   +X end: (1, 2, 5)
  //   -X end: (0, 4, 3)
  //   -Y face: (0, 1, 2), (0, 2, 3)
  //   -Z face: (0, 5, 1), (0, 4, 5)
  //   cut face (outward +Y+Z): (3, 5, 4), (3, 2, 5)
  const prismBGeom = buildPrismGeom([
    [1, 2, 5], [0, 4, 3],
    [0, 1, 2], [0, 2, 3],
    [0, 5, 1], [0, 4, 5],
    [3, 5, 4], [3, 2, 5],
  ]);

  // Keep geometry in PHYSICAL frame (optical axis = Z, length = L).
  // The caller (buildIsolatorPbsOverlay) does Glan-Laser-specific alignment
  // by composing rotations directly on the returned Group's quaternion —
  // optical axis → body Z, yRotationDeg → rotation around optical axis.
  const prismA = new THREE.Mesh(prismAGeom, crystal);
  const prismB = new THREE.Mesh(prismBGeom, crystal);

  // Air gap: offset each prism along its outward cut normal (physical frame).
  const cutNorm = Math.hypot(L, a);
  const gap = a * 0.03;
  const offY = (gap * L) / cutNorm;
  const offZ = (gap * a) / cutNorm;
  prismA.position.set(0, -offY, -offZ);
  prismB.position.set(0, +offY, +offZ);

  const group = new THREE.Group();
  group.add(prismA);
  group.add(prismB);

  // Escape window marker — pinkish arrow showing the rejected O-polarization
  // exit direction (~68° from optical axis after Snell at the -Y side face).
  // Physical frame: arrow start on -Y face, direction in -Y+Z plane.
  const escapeAngleRad = (68 * Math.PI) / 180;
  const escapeDir = new THREE.Vector3(0, -Math.sin(escapeAngleRad), Math.cos(escapeAngleRad));
  const escapeOrigin = new THREE.Vector3(0, -ha - a * 0.05, 0);
  const arrowLen = a * 1.2;
  const escapeArrow = new THREE.ArrowHelper(
    escapeDir,
    escapeOrigin,
    arrowLen,
    0xff4477,
    arrowLen * 0.25,
    arrowLen * 0.18,
  );
  escapeArrow.traverse((c) => {
    const m = (c as THREE.Mesh | THREE.Line).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    const mats = Array.isArray(m) ? m : [m];
    for (const mat of mats) {
      (mat as THREE.Material & { depthTest?: boolean; depthWrite?: boolean }).depthTest = false;
      (mat as THREE.Material & { depthTest?: boolean; depthWrite?: boolean }).depthWrite = false;
      mat.transparent = true;
    }
  });
  escapeArrow.renderOrder = 2;
  escapeArrow.userData.__glanEscapeArrow = true;
  group.add(escapeArrow);

  return group;
}

/** Wedge angle (cut plane vs optical axis) for the Glan-Laser model.
 *  Exposed so the dispatch in `buildIsolatorPbsOverlay` can compute the
 *  cement-normal body-frame direction for click-inspect / saved anchor
 *  data without duplicating the constant. */
const GLAN_LASER_WEDGE_DEG = 38;

// =============================================================================
// (3) PBS overlay group builder.
// =============================================================================

export function buildIsolatorPbsOverlay(
  asset: Asset3D | null | undefined,
  opts: {
    /** `component.model` for per-model override lookup. Optional — when
     *  unset or no row matches, the generic algorithmic defaults apply. */
    componentModel?: string;
    /** Housing length along the optical axis in millimetres, used to derive
     *  default anchor poses when the asset doesn't specify them. */
    housingLengthMm: number;
    /** Body-local (Z-up convention) axis that is the optical axis. TORNOS
     *  procedural cylinder = "z" (body Z → three Y, matches the renderer's
     *  default CylinderGeometry orientation); STL pipeline derives this
     *  from the bbox longest axis in three-frame (three Y bbox-longest →
     *  body Z, three X → body X, three Z → body Y). */
    opticalAxisBody: "x" | "y" | "z";
    /** Multiplier applied to all mm values before constructing geometry.
     *  Procedural path (already in three units) passes mmToThree(1); STL
     *  path (raw mm frame, scaled later by applyAssetScale) passes 1. */
    unitScale: number;
  },
): THREE.Group {
  const overlay = new THREE.Group();
  overlay.name = "isolator_pbs_overlay";

  const axisIdxBody: 0 | 1 | 2 =
    opts.opticalAxisBody === "x" ? 0
    : opts.opticalAxisBody === "y" ? 1
    : 2;
  const halfLenMm = opts.housingLengthMm / 2;
  const cubeSize = ISOLATOR_PBS_CUBE_SIZE_MM * opts.unitScale;
  const tilt = Math.SQRT1_2;

  type DefaultSpec = {
    name: string;
    posMm: [number, number, number];
    dir: [number, number, number];
    rotationDegBody: [number, number, number] | null;
    yRotationDeg: number | null;
    prismType: IsolatorPrismType;
  };
  const defaults: DefaultSpec[] = [
    { name: "front_pbs", posMm: [0, 0, 0], dir: [0, 0, 0], rotationDegBody: null, yRotationDeg: null, prismType: "pbs_cube" },
    { name: "back_pbs", posMm: [0, 0, 0], dir: [0, 0, 0], rotationDegBody: null, yRotationDeg: null, prismType: "pbs_cube" },
  ];
  defaults[0].posMm[axisIdxBody] = -halfLenMm * 0.5;
  defaults[1].posMm[axisIdxBody] = +halfLenMm * 0.5;
  defaults[0].dir[axisIdxBody] = tilt;
  defaults[0].dir[(axisIdxBody + 1) % 3] = tilt;
  defaults[1].dir[axisIdxBody] = tilt;
  defaults[1].dir[(axisIdxBody + 2) % 3] = tilt;

  const modelOverride = opts.componentModel
    ? ISOLATOR_PBS_DEFAULTS_BY_MODEL[opts.componentModel]
    : undefined;
  if (modelOverride) {
    for (const [idx, entry] of [modelOverride.front_pbs, modelOverride.back_pbs].entries()) {
      defaults[idx].posMm = [...entry.pos];
      if (entry.prismType) defaults[idx].prismType = entry.prismType;
      if (typeof entry.yRotationDeg === "number") {
        defaults[idx].yRotationDeg = entry.yRotationDeg;
        defaults[idx].dir = [0, 0, 0];
      } else if (entry.rotationDeg) {
        defaults[idx].rotationDegBody = [...entry.rotationDeg];
        defaults[idx].dir = [0, 0, 0];
      } else if (entry.dir) {
        defaults[idx].dir = [...entry.dir];
      }
    }
  }

  // body Z-up (x, y, z) → three Y-up (x, z, -y). Same convention as the
  // anchor sphere renderer in ComponentEditor.tsx (line 1245).
  const bodyToThree = (v: [number, number, number]): [number, number, number] => [v[0], v[2], -v[1]];

  for (const spec of defaults) {
    const anchor = findAnchorByName(asset, spec.name);
    const posMm: [number, number, number] = anchor?.positionMmBodyLocal
      ? [anchor.positionMmBodyLocal.x, anchor.positionMmBodyLocal.y, anchor.positionMmBodyLocal.z]
      : spec.posMm;
    let dirForUserData: [number, number, number] = anchor?.directionBodyLocal
      ? [anchor.directionBodyLocal.x, anchor.directionBodyLocal.y, anchor.directionBodyLocal.z]
      : spec.dir;

    const cube = spec.prismType === "glan_laser"
      ? buildGlanLaserPrism(cubeSize)
      : buildPbsMiniCube(cubeSize);
    const [tx, ty, tz] = bodyToThree(posMm);
    cube.position.set(tx * opts.unitScale, ty * opts.unitScale, tz * opts.unitScale);

    if (spec.rotationDegBody && !anchor?.directionBodyLocal) {
      // Free 3-axis Euler — highest priority. Works for both PBS cube
      // and Glan-Laser, lets the user dial in any orientation when the
      // automatic alignment is wrong / not what they want.
      const [rxBody, ryBody, rzBody] = spec.rotationDegBody;
      const toRad = (d: number) => (d * Math.PI) / 180;
      cube.rotation.set(toRad(rxBody), toRad(rzBody), toRad(-ryBody), "XYZ");
    } else if (spec.prismType === "glan_laser" && !anchor?.directionBodyLocal) {
      // Glan-Laser default alignment (used when no `rotationDeg` override):
      //   1) Map physical Z (optical axis) → three Y (= body Z, the
      //      isolator bore axis) by rotating −90° around three X.
      //   2) yRotationDeg = rotation AROUND the optical axis (three Y) →
      //      controls cement plane azimuth (= which polarisation is
      //      reflected; front_pbs and back_pbs typically differ by 90°
      //      because the Faraday rotator turns polarisation 45°).
      const yRad = ((spec.yRotationDeg ?? 0) * Math.PI) / 180;
      const opticalAlign = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
      const yRotAroundOptical = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yRad);
      cube.quaternion.copy(yRotAroundOptical).multiply(opticalAlign);
      const coRad = ((90 - GLAN_LASER_WEDGE_DEG) * Math.PI) / 180;
      const sw = Math.sin(coRad);
      const cw = Math.cos(coRad);
      dirForUserData = [sw * Math.sin(yRad), -sw * Math.cos(yRad), -cw];
    } else if (typeof spec.yRotationDeg === "number" && !anchor?.directionBodyLocal) {
      // PBS cube yRotationDeg mode: canonical cement normal = [1, 1, 0]
      // body-local, then rotate around body Y axis by yRotationDeg.
      //
      // bodyToThree([1, 1, 0]) = [1, 0, -1], so canonical-in-three is the
      // normalised version of that. Body Y = three -Z (axis swap), so the
      // Y-rotation in three frame is around the (0, 0, -1) axis.
      const canonicalRefThree = new THREE.Vector3(1, 0, -1).normalize();
      const canonicalCementInCube = new THREE.Vector3(1, 0, 1).normalize();
      const baseQ = new THREE.Quaternion().setFromUnitVectors(canonicalCementInCube, canonicalRefThree);
      const yRad = (spec.yRotationDeg * Math.PI) / 180;
      const yRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -1), yRad);
      cube.quaternion.copy(yRotation).multiply(baseQ);
      // Cement normal after Y rotation: body [cos(θ), 1, -sin(θ)]. Y stays
      // = 1, so the rotated normal remains a face-diagonal (PBS-valid)
      // direction — the nice property of restricting to Y axis.
      dirForUserData = [Math.cos(yRad), 1, -Math.sin(yRad)];
    } else {
      const [dx, dy, dz] = bodyToThree(dirForUserData);
      const dirVec = new THREE.Vector3(dx, dy, dz);
      if (dirVec.lengthSq() > 1e-6) {
        dirVec.normalize();
        const canonicalCementNormal = new THREE.Vector3(1, 0, 1).normalize();
        cube.quaternion.setFromUnitVectors(canonicalCementNormal, dirVec);
      }
    }

    cube.userData.__pbsAnchorName = spec.name;
    cube.userData.__pbsPosMmBodyLocal = { x: posMm[0], y: posMm[1], z: posMm[2] };
    cube.userData.__pbsDirBodyLocal = { x: dirForUserData[0], y: dirForUserData[1], z: dirForUserData[2] };
    cube.traverse((c) => { c.userData.__pbsAnchorName = spec.name; });

    overlay.add(cube);
  }

  return overlay;
}

// =============================================================================
// (4) Thorlabs STL isolator handler — wraps STL geometry with a translucent
//     housing material and PBS overlay. Used by `loadAsset/index.ts` STL
//     dispatch when the asset name matches `thorlabs_io[t]_<part>_stl`.
// =============================================================================

export function isThorlabsIsolatorAsset(asset: Asset3D): boolean {
  return /^thorlabs_iot?_/i.test(asset.name)
    && asset.name.endsWith("_stl")
    || /thorlabs_iot?_[\w-]+\.stl$/i.test(asset.filePath);
}

/** 0.5 mm-grid rounding — coarse enough to survive STL floating-point
 *  drift, fine enough that distinct triangles don't collide on the key. */
export function isolatorCentroidKey(cx: number, cy: number, cz: number): string {
  const r = (n: number) => Math.round(n * 2) / 2;
  return `${r(cx)},${r(cy)},${r(cz)}`;
}

/** A subset of STL triangles linked to rotate together around a body-frame
 *  axis at a body-frame pivot. Used for parts of the housing that
 *  physically rotate with an internal mechanism (e.g. the Thorlabs IOT-
 *  series rotatable input polariser ring). At render time the geometry
 *  is partitioned into static + linked sub-meshes; the linked one is
 *  rotated by `rotationDeg` around the axis at the pivot. */
export type IsolatorLinkedRotationGroup = {
  /** Centroid keys (via `isolatorCentroidKey`) of triangles in the group. */
  centroids: string[];
  /** Rotation axis in body-local frame (STL native coords). Defaults to
   *  the optical axis if unset by caller. */
  axis: [number, number, number];
  /** Pivot point in body-local mm (STL native coords). */
  pivotMm: [number, number, number];
  /** Current rotation angle, degrees. */
  rotationDeg: number;
  /** Anchor names whose PBS cubes are rigidly bound to this group's
   *  rotation — they keep their `pos` / `yRotationDeg` configuration
   *  (locked at link rotationDeg = 0) and additionally rotate around
   *  `axis` at `pivotMm` by `rotationDeg` when the group rotates.
   *  Example: `["front_pbs"]` for the IOT-series rotatable input
   *  polariser (front crystal rotates with the ring; back doesn't). */
  boundAnchors?: string[];
};

/** Partition `geometry` by membership in `linked.centroids`. Returns the
 *  static remainder as a BufferGeometry, plus an optional already-rotated
 *  Mesh for the linked triangles (pivot translated to origin, then
 *  rotated by `rotationDeg` around `axis`, then translated back to pivot). */
export function partitionIsolatorByLinkedRotation(
  geometry: THREE.BufferGeometry,
  linked: IsolatorLinkedRotationGroup | null | undefined,
  material: THREE.Material,
): { staticGeom: THREE.BufferGeometry; linkedMesh: THREE.Mesh | null } {
  if (!linked || linked.centroids.length === 0) {
    return { staticGeom: geometry, linkedMesh: null };
  }
  const set = new Set(linked.centroids);
  const positions = geometry.attributes.position.array as Float32Array;
  const triangleCount = Math.floor(positions.length / 9);
  const staticVerts: number[] = [];
  const linkedVerts: number[] = [];
  for (let t = 0; t < triangleCount; t += 1) {
    const o = t * 9;
    const cx = (positions[o + 0] + positions[o + 3] + positions[o + 6]) / 3;
    const cy = (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3;
    const cz = (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3;
    const target = set.has(isolatorCentroidKey(cx, cy, cz)) ? linkedVerts : staticVerts;
    for (let k = 0; k < 9; k += 1) target.push(positions[o + k]);
  }
  const staticGeom = new THREE.BufferGeometry();
  staticGeom.setAttribute("position", new THREE.Float32BufferAttribute(staticVerts, 3));
  staticGeom.computeVertexNormals();
  if (linkedVerts.length === 0) {
    return { staticGeom, linkedMesh: null };
  }
  const linkedGeom = new THREE.BufferGeometry();
  linkedGeom.setAttribute("position", new THREE.Float32BufferAttribute(linkedVerts, 3));
  linkedGeom.computeVertexNormals();
  const [px, py, pz] = linked.pivotMm;
  linkedGeom.translate(-px, -py, -pz);
  const mesh = new THREE.Mesh(linkedGeom, material);
  mesh.position.set(px, py, pz);
  const axisVec = new THREE.Vector3(...linked.axis);
  if (axisVec.lengthSq() > 1e-9) {
    axisVec.normalize();
    const angleRad = (linked.rotationDeg * Math.PI) / 180;
    mesh.quaternion.setFromAxisAngle(axisVec, angleRad);
  }
  return { staticGeom, linkedMesh: mesh };
}

/** Drop triangles whose centroid (rounded via `isolatorCentroidKey`) is in
 *  the deletion set. Used by both the dev-page click-to-delete flow and
 *  the Lab viewer (via baked component.properties.isolatorDeletedCentroids). */
export function applyIsolatorDeletionFilter(
  geometry: THREE.BufferGeometry,
  deletedCentroids: ReadonlyArray<string> | Set<string>,
): THREE.BufferGeometry {
  const set = deletedCentroids instanceof Set ? deletedCentroids : new Set(deletedCentroids);
  if (set.size === 0) return geometry;
  const positions = geometry.attributes.position.array as Float32Array;
  const triangleCount = Math.floor(positions.length / 9);
  const out: number[] = [];
  for (let t = 0; t < triangleCount; t += 1) {
    const o = t * 9;
    const cx = (positions[o + 0] + positions[o + 3] + positions[o + 6]) / 3;
    const cy = (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3;
    const cz = (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3;
    if (set.has(isolatorCentroidKey(cx, cy, cz))) continue;
    for (let k = 0; k < 9; k += 1) out.push(positions[o + k]);
  }
  const newGeom = new THREE.BufferGeometry();
  newGeom.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  newGeom.computeVertexNormals();
  return newGeom;
}

/** Drop triangles whose centroid is within `minRadiusMm` of the given STL-
 *  frame axis (the longest bbox dim → the isolator's bore / optical axis).
 *  Used to hide the interior PBS / Faraday rotator mount baffles that
 *  would otherwise show through the semi-transparent housing. */
function filterStlByAxisRadius(
  geometry: THREE.BufferGeometry,
  axisIdx: 0 | 1 | 2,
  minRadiusMm: number,
): THREE.BufferGeometry {
  if (minRadiusMm <= 0) return geometry;
  const positions = geometry.attributes.position.array as Float32Array;
  const triangleCount = Math.floor(positions.length / 9);
  const out: number[] = [];
  const minR2 = minRadiusMm * minRadiusMm;
  const p1 = ((axisIdx + 1) % 3) as 0 | 1 | 2;
  const p2 = ((axisIdx + 2) % 3) as 0 | 1 | 2;
  for (let t = 0; t < triangleCount; t += 1) {
    const o = t * 9;
    const c1 = (positions[o + p1] + positions[o + 3 + p1] + positions[o + 6 + p1]) / 3;
    const c2 = (positions[o + p2] + positions[o + 3 + p2] + positions[o + 6 + p2]) / 3;
    if (c1 * c1 + c2 * c2 < minR2) continue;
    for (let k = 0; k < 9; k += 1) out.push(positions[o + k]);
  }
  const newGeom = new THREE.BufferGeometry();
  newGeom.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  newGeom.computeVertexNormals();
  return newGeom;
}

export function buildThorlabsIsolatorObject(
  geometry: THREE.BufferGeometry,
  component: ComponentItem,
  asset: Asset3D,
  /** Drops STL triangles within this radius (mm) of the optical axis. 0
   *  = no auto-trim (default). Used to bulk-hide interior structure; the
   *  dev page exposes this as a slider. */
  innerFilterRadiusMm: number = 0,
  /** Optional explicit deletion set. When omitted, falls back to
   *  `component.properties.isolatorDeletedCentroids` (the persisted set
   *  baked via the dev page's "💾 Save" button). Centroid keys come from
   *  `isolatorCentroidKey()`. */
  deletedCentroids?: ReadonlyArray<string> | Set<string>,
  /** Optional linked-rotation group — separates the marked triangles into
   *  a sub-mesh and rotates them around a body-frame axis at a pivot.
   *  When omitted, falls back to
   *  `component.properties.isolatorLinkedRotationGroup`. */
  linkedRotationGroup?: IsolatorLinkedRotationGroup | null,
): THREE.Object3D {
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox ?? new THREE.Box3();
  const sizeMm = new THREE.Vector3();
  bbox.getSize(sizeMm);

  // Detect optical axis as the bbox's longest dim (STL frame, raw mm).
  let stlAxisIdx: 0 | 1 | 2 = 0;
  if (sizeMm.y >= sizeMm.x && sizeMm.y >= sizeMm.z) stlAxisIdx = 1;
  else if (sizeMm.z >= sizeMm.x && sizeMm.z > sizeMm.y) stlAxisIdx = 2;

  // Apply user-deleted faces (if any), then the axis-radius bulk filter.
  const resolvedDeletions: ReadonlyArray<string> | Set<string> = deletedCentroids
    ?? ((component.properties as { isolatorDeletedCentroids?: string[] } | null | undefined)?.isolatorDeletedCentroids ?? []);
  const afterDeletion = applyIsolatorDeletionFilter(geometry, resolvedDeletions);
  const filteredGeometry = filterStlByAxisRadius(afterDeletion, stlAxisIdx, innerFilterRadiusMm);

  // bbox is in three.js Y-up frame; map back to body-local Z-up. STL pipeline
  // adds the housing into a group whose children are in three units after
  // applyAssetScale ÷100, so the bbox dimensions are mm (since STL is raw
  // mm before scale).
  let opticalAxisBody: "x" | "y" | "z" = "x";
  let housingLengthMm = sizeMm.x;
  if (stlAxisIdx === 1) {
    opticalAxisBody = "z";
    housingLengthMm = sizeMm.y;
  } else if (stlAxisIdx === 2) {
    opticalAxisBody = "y";
    housingLengthMm = sizeMm.z;
  }

  const housingMat = new THREE.MeshStandardMaterial({
    color: "#1a1a1c",
    metalness: 0.55,
    roughness: 0.5,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  });

  // Linked-rotation: partition the filtered housing geometry into static
  // + linked sub-mesh. Falls back to component.properties when not given.
  const resolvedLinked: IsolatorLinkedRotationGroup | null = linkedRotationGroup
    ?? ((component.properties as { isolatorLinkedRotationGroup?: IsolatorLinkedRotationGroup } | null | undefined)?.isolatorLinkedRotationGroup ?? null);
  const { staticGeom, linkedMesh } = partitionIsolatorByLinkedRotation(
    filteredGeometry,
    resolvedLinked,
    housingMat,
  );

  const housing = new THREE.Mesh(staticGeom, housingMat);
  housing.renderOrder = 0;

  // Stage A''.9 — when an asset opts out of the bundled overlay (via
  // viewerHints.bundledOverlay=false), the legacy PBS-cube overlay
  // is suppressed entirely. The consuming Component's binding tree
  // is expected to add PBS sub-Component bindings instead, avoiding
  // the double-render that would otherwise happen on Components
  // with a populated 5-part binding tree.
  const hints = (asset.properties as { viewerHints?: { bundledOverlay?: boolean } } | undefined)?.viewerHints;
  const suppressOverlay = hints?.bundledOverlay === false;

  const overlay = suppressOverlay ? null : buildIsolatorPbsOverlay(asset, {
    componentModel: component.model ?? undefined,
    housingLengthMm,
    opticalAxisBody,
    unitScale: 1,
  });
  if (overlay) overlay.renderOrder = 1;

  // Apply the link rotation to PBS cubes whose anchor name is in
  // `boundAnchors`. The cube keeps its base pose (pos + yRotationDeg)
  // set at link rotationDeg = 0; this additional rotation moves the
  // crystal together with the rotatable mechanical component.
  if (overlay
      && resolvedLinked
      && resolvedLinked.rotationDeg !== 0
      && resolvedLinked.boundAnchors
      && resolvedLinked.boundAnchors.length > 0) {
    const axisVec = new THREE.Vector3(...resolvedLinked.axis);
    if (axisVec.lengthSq() > 1e-9) {
      axisVec.normalize();
      const angleRad = (resolvedLinked.rotationDeg * Math.PI) / 180;
      const pivot = new THREE.Vector3(...resolvedLinked.pivotMm);
      const rotQ = new THREE.Quaternion().setFromAxisAngle(axisVec, angleRad);
      const boundSet = new Set(resolvedLinked.boundAnchors);
      for (const cube of overlay.children) {
        const anchorName = cube.userData.__pbsAnchorName as string | undefined;
        if (!anchorName || !boundSet.has(anchorName)) continue;
        const pos = cube.position.clone().sub(pivot);
        pos.applyAxisAngle(axisVec, angleRad);
        pos.add(pivot);
        cube.position.copy(pos);
        cube.quaternion.premultiply(rotQ);
      }
    }
  }

  const group = new THREE.Group();
  group.add(housing);
  if (linkedMesh) {
    linkedMesh.renderOrder = 0;
    linkedMesh.userData.__isolatorLinkedRotation = true;
    group.add(linkedMesh);
  }
  if (overlay) group.add(overlay);
  return group;
}
