import { describe, expect, it } from "vitest";
import { attenuationDbPerKm, attenuationTransmittance } from "../attenuation";
import { alphaDbPerMeter, bendLossTransmittance } from "../bend_loss";

describe("Attenuation curve interpolation", () => {
  it("clamps below first sample", () => {
    const curve = [
      { wavelengthNm: 770, dbPerKm: 6 },
      { wavelengthNm: 800, dbPerKm: 4 },
    ];
    expect(attenuationDbPerKm(curve, 700)).toBe(6);
  });

  it("clamps above last sample", () => {
    const curve = [
      { wavelengthNm: 770, dbPerKm: 6 },
      { wavelengthNm: 800, dbPerKm: 4 },
    ];
    expect(attenuationDbPerKm(curve, 900)).toBe(4);
  });

  it("interpolates linearly between samples", () => {
    const curve = [
      { wavelengthNm: 770, dbPerKm: 6 },
      { wavelengthNm: 800, dbPerKm: 4 },
    ];
    // 785 nm is halfway: (6+4)/2 = 5
    expect(attenuationDbPerKm(curve, 785)).toBeCloseTo(5, 8);
  });

  it("1 m of 5 dB/km fiber ⇒ T = 10^(-5e-3/10) ≈ 0.99885", () => {
    const curve = [{ wavelengthNm: 780, dbPerKm: 5 }];
    const t = attenuationTransmittance(curve, 780, 1000); // 1 m = 1000 mm
    expect(t).toBeCloseTo(Math.pow(10, -0.005 / 10), 6);
  });
});

describe("Marcuse bend loss", () => {
  const bendConst = {
    vNumber: 2.0,
    coreRadiusUm: 2.2,
    nCore: 1.4506,
    nClad: 1.45,
    criticalRadiusMm: 25.0,
  };

  it("at R = R_crit, α = 0.1 dB/m by calibration", () => {
    expect(alphaDbPerMeter(25, bendConst)).toBeCloseTo(0.1, 4);
  });

  it("at R = 2·R_crit, α = 0.01 dB/m by calibration", () => {
    expect(alphaDbPerMeter(50, bendConst)).toBeCloseTo(0.01, 4);
  });

  it("at R = ∞, α = 0", () => {
    expect(alphaDbPerMeter(Number.POSITIVE_INFINITY, bendConst)).toBe(0);
  });

  it("straight 1 m fiber ⇒ no bend loss (η_bend = 1)", () => {
    const t = bendLossTransmittance(
      () => Number.POSITIVE_INFINITY,
      1000,
      bendConst,
    );
    expect(t).toBeCloseTo(1, 8);
  });

  it("R = R_crit constant bend over 1 m ⇒ η_bend = 10^(-0.01) ≈ 0.977", () => {
    const t = bendLossTransmittance(() => 25, 1000, bendConst);
    // 0.1 dB/m × 1 m = 0.1 dB → T = 10^(-0.01) ≈ 0.97724
    expect(t).toBeCloseTo(Math.pow(10, -0.01), 4);
  });
});
