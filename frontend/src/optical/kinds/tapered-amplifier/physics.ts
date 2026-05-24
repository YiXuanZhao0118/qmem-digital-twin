/**
 * Tapered Amplifier (TA) PhysicsOp — STUB.
 *
 * Real physics: small-signal gain × log-saturation P_out = P_sat · log(1 +
 * P_in/P_sat · (G - 1)); spatial mode broadening; ASE noise floor. The v2
 * TaperedAmplifierAdjustControls UI has nominalPowerOutW / driveCurrentA
 * inputs — port to v3 op.
 *
 * Current stub: scalar gainLinear multiplier from params (default 1.0).
 */

import { type BeamRay, vec3Distance } from "../../beam-ray";
import {
  type PhysicsOp, type PhysicsOpContext, registerKind,
} from "../../registry";

export const taAmplifyOp: PhysicsOp = (
  rayIn: BeamRay, ctx: PhysicsOpContext,
): BeamRay[] => {
  const gain = (ctx.params.gainLinear as number | undefined) ?? 1.0;
  const thickness = vec3Distance(
    ctx.faceIn.positionMmBodyLocal, ctx.faceOut.positionMmBodyLocal,
  );
  return [{
    ...rayIn,
    origin: ctx.faceOut.positionMmBodyLocal,
    powerMw: rayIn.powerMw * gain,
    pathLengthMm: rayIn.pathLengthMm + thickness,
  }];
};

registerKind("tapered_amplifier", {
  ops: { ta_amplify: taAmplifyOp },
  needsAperture: true,
});
