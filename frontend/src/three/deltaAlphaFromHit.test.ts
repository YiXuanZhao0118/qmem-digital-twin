import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { buildBeamBasis, deltaAlphaFromHit } from "./deltaAlphaFromHit";
import { MM_PER_THREE_UNIT, labMmToThree, labDirToThree } from "../optical/frames";

// Horizontal beam in lab +X. In three frame this is +X (labX → threeX).
const BEAM_DIR_HORIZONTAL_THREE = new THREE.Vector3(1, 0, 0);

describe("buildBeamBasis", () => {
  it("horizontal lab-X beam: e_x ≈ lab+Y, e_y ≈ lab+Z (up)", () => {
    const { ex, ey } = buildBeamBasis(BEAM_DIR_HORIZONTAL_THREE);
    // lab +Y in three frame = (0, 0, -1)
    expect(ex.x).toBeCloseTo(0);
    expect(ex.y).toBeCloseTo(0);
    expect(ex.z).toBeCloseTo(-1);
    // lab +Z in three frame = (0, 1, 0)
    expect(ey.x).toBeCloseTo(0);
    expect(ey.y).toBeCloseTo(1);
    expect(ey.z).toBeCloseTo(0);
  });

  it("vertical lab-Z beam falls back to world-X reference (non-degenerate)", () => {
    const upBeam = labDirToThree({ x: 0, y: 0, z: 1 });
    const { ex, ey } = buildBeamBasis(upBeam);
    // Just verify ex, ey are unit and perpendicular to dir + each other
    expect(ex.length()).toBeCloseTo(1);
    expect(ey.length()).toBeCloseTo(1);
    expect(ex.dot(upBeam)).toBeCloseTo(0);
    expect(ey.dot(upBeam)).toBeCloseTo(0);
    expect(ex.dot(ey)).toBeCloseTo(0);
  });
});

describe("deltaAlphaFromHit — perfectly aligned element", () => {
  it("hit dead-center on lens facing back gives δ=0, α=0", () => {
    const center = labMmToThree({ xMm: 200, yMm: 0, zMm: 0 });
    const result = deltaAlphaFromHit({
      hitPointWorld: center.clone(),
      incomingDir: BEAM_DIR_HORIZONTAL_THREE,
      elementCenterWorld: center,
      elementNormalWorld: new THREE.Vector3(-1, 0, 0), // facing -X (back at beam)
    });
    expect(result.deltaXMm).toBeCloseTo(0);
    expect(result.deltaYMm).toBeCloseTo(0);
    expect(result.alphaXRad).toBeCloseTo(0);
    expect(result.alphaYRad).toBeCloseTo(0);
  });

  it("normal facing forward (same dir as beam) gets auto-flipped — still α=0", () => {
    const center = labMmToThree({ xMm: 200, yMm: 0, zMm: 0 });
    const result = deltaAlphaFromHit({
      hitPointWorld: center.clone(),
      incomingDir: BEAM_DIR_HORIZONTAL_THREE,
      elementCenterWorld: center,
      elementNormalWorld: new THREE.Vector3(1, 0, 0), // forward; should be flipped internally
    });
    expect(result.alphaXRad).toBeCloseTo(0);
    expect(result.alphaYRad).toBeCloseTo(0);
  });
});

describe("deltaAlphaFromHit — decenter", () => {
  it("hit offset lab+Y by 0.5 mm → δ_x = +0.5 mm (beam e_x = lab+Y)", () => {
    const center = labMmToThree({ xMm: 200, yMm: 0, zMm: 0 });
    const hit = labMmToThree({ xMm: 200, yMm: 0.5, zMm: 0 });
    const result = deltaAlphaFromHit({
      hitPointWorld: hit,
      incomingDir: BEAM_DIR_HORIZONTAL_THREE,
      elementCenterWorld: center,
      elementNormalWorld: new THREE.Vector3(-1, 0, 0),
    });
    expect(result.deltaXMm).toBeCloseTo(0.5);
    expect(result.deltaYMm).toBeCloseTo(0);
  });

  it("hit offset lab+Z by 0.3 mm → δ_y = +0.3 mm (beam e_y = lab+Z = up)", () => {
    const center = labMmToThree({ xMm: 200, yMm: 0, zMm: 0 });
    const hit = labMmToThree({ xMm: 200, yMm: 0, zMm: 0.3 });
    const result = deltaAlphaFromHit({
      hitPointWorld: hit,
      incomingDir: BEAM_DIR_HORIZONTAL_THREE,
      elementCenterWorld: center,
      elementNormalWorld: new THREE.Vector3(-1, 0, 0),
    });
    expect(result.deltaXMm).toBeCloseTo(0);
    expect(result.deltaYMm).toBeCloseTo(0.3);
  });
});

describe("deltaAlphaFromHit — tilt α", () => {
  it("tilt about lab-Z by +θ (about beam e_y) → α_y = +θ", () => {
    const theta = 0.02; // rad
    const center = labMmToThree({ xMm: 200, yMm: 0, zMm: 0 });
    // n_aligned = -lab_x. Rotate about lab_z by +θ:
    //   n_rotated_lab ≈ -cos(θ)·lab_x - sin(θ)·lab_y
    const c = Math.cos(theta), s = Math.sin(theta);
    const normalThree = labDirToThree({ x: -c, y: -s, z: 0 });
    const result = deltaAlphaFromHit({
      hitPointWorld: center.clone(),
      incomingDir: BEAM_DIR_HORIZONTAL_THREE,
      elementCenterWorld: center,
      elementNormalWorld: normalThree,
    });
    expect(result.alphaXRad).toBeCloseTo(0);
    expect(result.alphaYRad).toBeCloseTo(theta);
  });

  it("tilt about lab-Y by +θ (about beam e_x) → α_x = +θ", () => {
    const theta = 0.015;
    const center = labMmToThree({ xMm: 200, yMm: 0, zMm: 0 });
    // Rotate about lab_y by +θ (right-hand): lab_x → cos(θ)·lab_x - sin(θ)·lab_z
    // n_aligned = -lab_x → -cos(θ)·lab_x + sin(θ)·lab_z
    const c = Math.cos(theta), s = Math.sin(theta);
    const normalThree = labDirToThree({ x: -c, y: 0, z: s });
    const result = deltaAlphaFromHit({
      hitPointWorld: center.clone(),
      incomingDir: BEAM_DIR_HORIZONTAL_THREE,
      elementCenterWorld: center,
      elementNormalWorld: normalThree,
    });
    expect(result.alphaXRad).toBeCloseTo(theta);
    expect(result.alphaYRad).toBeCloseTo(0);
  });
});

describe("deltaAlphaFromHit — units", () => {
  it("δ scales as lab mm (THREE units × MM_PER_THREE_UNIT)", () => {
    expect(MM_PER_THREE_UNIT).toBe(100);
    const center = labMmToThree({ xMm: 0, yMm: 0, zMm: 0 });
    const hit = labMmToThree({ xMm: 0, yMm: 1.5, zMm: 0 }); // 1.5 mm offset
    const result = deltaAlphaFromHit({
      hitPointWorld: hit,
      incomingDir: BEAM_DIR_HORIZONTAL_THREE,
      elementCenterWorld: center,
      elementNormalWorld: new THREE.Vector3(-1, 0, 0),
    });
    expect(result.deltaXMm).toBeCloseTo(1.5);
  });
});
