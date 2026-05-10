import { describe, expect, it } from "vitest";
import { brewsterAngleRad, criticalAngleRad, fresnelReflectance } from "../fresnel";

describe("Fresnel reflectance", () => {
  it("normal incidence n = 1.0 → 1.45 ⇒ R ≈ 0.0337", () => {
    const r = fresnelReflectance({
      thetaIRad: 0,
      n1: 1.0,
      n2: 1.4506,
      chiRad: 0,
    });
    // R = ((1.4506-1)/(1.4506+1))² = (0.4506/2.4506)² ≈ 0.0338094
    expect(r.reflectance).toBeCloseTo(0.0338094, 6);
    expect(r.transmittance).toBeCloseTo(1 - 0.0338094, 6);
  });

  it("Brewster angle for n=1→1.5 ⇒ R_p = 0", () => {
    const brewster = brewsterAngleRad(1.0, 1.5);
    const rPure = fresnelReflectance({
      thetaIRad: brewster,
      n1: 1.0,
      n2: 1.5,
      chiRad: Math.PI / 2, // p-polarization
    });
    expect(rPure.rP).toBeLessThan(1e-12);
    expect(rPure.reflectance).toBeLessThan(1e-12);
  });

  it("critical angle (n=1.5→1.0) ⇒ TIR onset", () => {
    const critical = criticalAngleRad(1.5, 1.0);
    expect(critical).toBeCloseTo(Math.asin(1 / 1.5), 6);

    // Just past critical: total internal reflection
    const r = fresnelReflectance({
      thetaIRad: critical + 0.01,
      n1: 1.5,
      n2: 1.0,
      chiRad: 0,
    });
    expect(r.totalInternalReflection).toBe(true);
    expect(r.reflectance).toBe(1.0);
  });

  it("AR coating residual scales R linearly", () => {
    const r0 = fresnelReflectance({
      thetaIRad: 0,
      n1: 1.0,
      n2: 1.4506,
      chiRad: 0,
      arResidual: 1.0,
    });
    const r1 = fresnelReflectance({
      thetaIRad: 0,
      n1: 1.0,
      n2: 1.4506,
      chiRad: 0,
      arResidual: 0.15,
    });
    expect(r1.reflectance).toBeCloseTo(r0.reflectance * 0.15, 6);
  });
});
