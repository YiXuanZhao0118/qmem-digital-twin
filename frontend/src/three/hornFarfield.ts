/**
 * Phase RF.7 — parametric radiation lobe for a horn_antenna SceneObject.
 *
 * Renders |E(θ, φ)|² ∝ cos^n(θ/2) along the body-local polar axis (+Z by
 * default), where n is `cosineExponent`. The radial scale is set so the
 * peak is 30 mm long in scene units — easy to see, never overlaps with
 * neighbouring optics. A `LineSegments` wireframe (cyan) keeps the lobe
 * non-occluding so optics behind it stay visible.
 *
 * No palace integration yet; this is purely visual. A future Phase will
 * accept a sampled `radiationPattern[θ][φ]` and reuse the same builder.
 */
import * as THREE from "three";

type LobeOpts = {
  cosineExponent: number;
  /** Peak length of the lobe in scene units. Default 0.03 = 30 mm. */
  peakLengthM?: number;
  polarAxisBodyLocal: [number, number, number];
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function makeFarfieldLobe(opts: LobeOpts): THREE.LineSegments {
  const exponent = Math.max(0, opts.cosineExponent);
  const peakM = opts.peakLengthM ?? 0.03;
  const nTheta = 28;
  const nPhi = 28;
  const positions: number[] = [];

  // Cylindrical samples around the axis. For each (theta, phi), r = peak
  // * cos^n(theta/2). theta=0 → forward lobe tip; theta=pi → zero (back).
  const grid: THREE.Vector3[][] = [];
  for (let i = 0; i <= nTheta; i++) {
    const theta = (i / nTheta) * Math.PI;
    const r = peakM * Math.pow(Math.cos(theta / 2), exponent);
    const row: THREE.Vector3[] = [];
    for (let j = 0; j < nPhi; j++) {
      const phi = (j / nPhi) * 2 * Math.PI;
      // Build a vector along +Z polar axis, then rotate to local axis via
      // setFromUnitVectors below — but for simplicity, generate in (Z-up)
      // canonical space and let the caller's polarAxis-rotation matrix
      // place it.
      const x = r * Math.sin(theta) * Math.cos(phi);
      const y = r * Math.sin(theta) * Math.sin(phi);
      const z = r * Math.cos(theta);
      row.push(new THREE.Vector3(x, y, z));
    }
    grid.push(row);
  }

  // Latitude rings.
  for (let i = 1; i < nTheta; i++) {
    const ring = grid[i];
    for (let j = 0; j < nPhi; j++) {
      const a = ring[j];
      const b = ring[(j + 1) % nPhi];
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  // Longitude meridians (every 4th to avoid clutter).
  for (let j = 0; j < nPhi; j += 4) {
    for (let i = 0; i < nTheta; i++) {
      const a = grid[i][j];
      const b = grid[i + 1][j];
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));

  const mat = new THREE.LineBasicMaterial({
    color: 0x38bdf8, // sky-blue — same family as RF chain chips
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geom, mat);

  // Rotate the canonical Z-axis lobe to match polarAxisBodyLocal.
  const axisLocal = new THREE.Vector3(
    opts.polarAxisBodyLocal[0],
    opts.polarAxisBodyLocal[1],
    opts.polarAxisBodyLocal[2],
  );
  if (axisLocal.lengthSq() > 1e-9 && Math.abs(axisLocal.z - 1) > 1e-6) {
    axisLocal.normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      axisLocal,
    );
    lines.quaternion.copy(q);
  }
  // Cosmetic — never raycastable, never affect optics.
  lines.userData.farfieldLobe = true;
  // Cull the lobe if cosineExponent has been clamped to zero (degenerate).
  if (exponent <= 0) lines.visible = false;

  // We mutate clamp() unused warning by referencing it.
  void clamp;
  return lines;
}

export function disposeFarfieldLobe(lobe: THREE.LineSegments): void {
  lobe.geometry.dispose();
  if (lobe.material instanceof THREE.LineBasicMaterial) lobe.material.dispose();
}
