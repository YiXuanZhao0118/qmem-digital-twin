/** Shared polarization visualization — turns a per-segment Jones vector into
 *  3D marker geometry (linear arrow / ellipse loop / circle). Single source of
 *  truth so the Lab optical link (OpticalLinkViewerPanel) and the PHY Editor
 *  COMPONENT preview (ComponentsEditor) interpret polarization identically.
 *
 *  The Jones vector lives in the SAME beam-local s/p frame the backend solver
 *  uses (see backend jones.beam_local_sp), so callers pass the segment's lab
 *  direction and these helpers rebuild s/p from it. */
import * as THREE from "three";

/** Beam-local s/p unit vectors — MUST match the backend solver frame the Jones
 *  vector lives in (backend `jones.beam_local_sp`, lab Z up):
 *    s = normalize(up − (up·d)·d)   // projection of up onto the plane ⊥ d
 *    p = d × s
 *  NOTE: an earlier version used `s = up × d`, which is a *different* basis
 *  (rotated 90° about d) → it drew the Jones in the wrong frame, so a 45°
 *  linear state looked mirrored (apparent reversed rotation). Keep this in
 *  lockstep with backend jones.py (GLOBAL_UP=(0,0,1), FALLBACK_UP=(1,0,0)). */
export function beamLocalSPThree(beamDir: THREE.Vector3): { s: THREE.Vector3; p: THREE.Vector3 } {
  const d = beamDir.clone().normalize();
  const GLOBAL_UP = new THREE.Vector3(0, 0, 1);
  const FALLBACK_UP = new THREE.Vector3(1, 0, 0);
  const up = Math.abs(d.dot(GLOBAL_UP)) > 0.999 ? FALLBACK_UP : GLOBAL_UP;
  const s = up.clone().addScaledVector(d, -up.dot(d)).normalize();
  const p = new THREE.Vector3().crossVectors(d, s).normalize();
  return { s, p };
}

/** Full polarization ELLIPSE (world/three) from the Jones vector
 *  [E_s.re, E_s.im, E_p.re, E_p.im] and the beam direction. Returns the major
 *  (`u`) and minor (`v`) axis directions in the beam's transverse plane, the
 *  minor/major ratio (`minorFrac` ∈ [0,1]: 0 = linear, 1 = circular), and the
 *  rotation sense (`handed` ±1). Lets the viewer draw a line for linear light,
 *  a circle for circular, and an ellipse in between.
 *      ψ = ½·atan2( 2·Re(E_s·conj(E_p)), |E_s|²−|E_p|² )   (orientation)
 *      χ = ½·asin( 2·Im(E_s·conj(E_p)) / I )               (ellipticity)
 *      minorFrac = |tan χ|,  u = cosψ ŝ + sinψ p̂,  v = −sinψ ŝ + cosψ p̂ */
export function polEllipseFromJones(
  jones: [number, number, number, number],
  beamDir: THREE.Vector3,
): { u: THREE.Vector3; v: THREE.Vector3; minorFrac: number; handed: number } {
  const [sre, sim, pre, pim] = jones;
  const intensity = sre * sre + sim * sim + pre * pre + pim * pim;
  const reCross = sre * pre + sim * pim;                 // Re(E_s·conj(E_p))
  const imCross = sre * pim - sim * pre;                 // Im(E_s·conj(E_p))
  const diff = (sre * sre + sim * sim) - (pre * pre + pim * pim);
  const psi = 0.5 * Math.atan2(2 * reCross, diff);
  const chi = 0.5 * Math.asin(
    intensity > 1e-12 ? Math.max(-1, Math.min(1, (2 * imCross) / intensity)) : 0,
  );
  const { s, p } = beamLocalSPThree(beamDir);
  const cu = Math.cos(psi), su = Math.sin(psi);
  const u = s.clone().multiplyScalar(cu).add(p.clone().multiplyScalar(su)).normalize();
  const v = s.clone().multiplyScalar(-su).add(p.clone().multiplyScalar(cu)).normalize();
  return { u, v, minorFrac: Math.tan(Math.abs(chi)), handed: imCross >= 0 ? 1 : -1 };
}

/** Build the polarization marker meshes for one beam segment, centred at
 *  `mid` and ⊥ to `beamDir`, from the segment's Jones vector:
 *    - LINEAR (minorFrac < 0.08): a double-headed arrow along the E-field axis.
 *    - ELLIPTICAL / CIRCULAR: the polarization ellipse loop (circle at
 *      minorFrac = 1) plus a small arrowhead showing the rotation sense.
 *  `size` is the major radius / arrow half-length in the caller's scene units;
 *  the caller adds the returned objects to its own group.
 *
 *  `opts.minRadius` floors the arrow SHAFT radius. The default (0.05) suits the
 *  PHY Editor's component-frame preview, where one three-unit ≈ one component;
 *  at Lab scale (1 unit = 100 mm) that floor is ~5 mm of shaft and dominates
 *  `size`, drawing fat clubs instead of arrows — the Lab optical link passes a
 *  span-relative floor instead. */
export function buildPolarizationMarkers(
  jones: [number, number, number, number],
  beamDir: THREE.Vector3,
  mid: THREE.Vector3,
  size: number,
  opts?: { color?: number; renderOrder?: number; minRadius?: number },
): THREE.Object3D[] {
  const color = opts?.color ?? 0x06b6d4; // cyan
  const renderOrder = opts?.renderOrder ?? 2100;
  const minRadius = opts?.minRadius ?? 0.05;
  const yAxis = new THREE.Vector3(0, 1, 0);
  const { u, v, minorFrac, handed } = polEllipseFromJones(jones, beamDir);
  const mat = new THREE.MeshBasicMaterial({
    color, depthTest: false, transparent: true, opacity: 0.95,
  });
  const out: THREE.Object3D[] = [];

  if (minorFrac < 0.08) {
    // LINEAR → double-headed arrow along the E-field axis (= u).
    const markLen = size * 2;
    const markRad = Math.max(size * 0.08, minRadius);
    const headLen = markLen * 0.3;
    const headRad = markRad * 3.0;
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(markRad, markRad, markLen, 8), mat,
    );
    shaft.quaternion.setFromUnitVectors(yAxis, u);
    shaft.position.copy(mid);
    shaft.renderOrder = renderOrder;
    out.push(shaft);
    for (const sign of [1, -1] as const) {
      const head = new THREE.Mesh(new THREE.ConeGeometry(headRad, headLen, 12), mat);
      head.quaternion.setFromUnitVectors(yAxis, u.clone().multiplyScalar(sign));
      head.position.copy(mid).addScaledVector(u, sign * (markLen / 2 + headLen / 2));
      head.renderOrder = renderOrder;
      out.push(head);
    }
  } else {
    // ELLIPTICAL / CIRCULAR → ellipse loop (minorFrac=1 → circle) + sense arrow.
    const semiMajor = size;
    const semiMinor = semiMajor * minorFrac;
    const pts: THREE.Vector3[] = [];
    const N = 48;
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * Math.PI * 2;
      pts.push(mid.clone()
        .addScaledVector(u, Math.cos(t) * semiMajor)
        .addScaledVector(v, Math.sin(t) * semiMinor * handed));
    }
    const loop = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }),
    );
    loop.renderOrder = renderOrder;
    out.push(loop);
    const tA = Math.PI / 2;
    const pos = mid.clone()
      .addScaledVector(u, Math.cos(tA) * semiMajor)
      .addScaledVector(v, Math.sin(tA) * semiMinor * handed);
    const tangent = u.clone().multiplyScalar(-Math.sin(tA) * semiMajor)
      .add(v.clone().multiplyScalar(Math.cos(tA) * semiMinor * handed)).normalize();
    const head = new THREE.Mesh(new THREE.ConeGeometry(semiMajor * 0.16, semiMajor * 0.45, 10), mat);
    head.quaternion.setFromUnitVectors(yAxis, tangent);
    head.position.copy(pos);
    head.renderOrder = renderOrder;
    out.push(head);
  }
  return out;
}
