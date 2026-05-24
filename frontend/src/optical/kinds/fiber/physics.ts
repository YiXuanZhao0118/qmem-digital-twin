/**
 * Fiber PhysicsOp — STUB.
 *
 * Real Marcuse coupling + Fresnel facet loss + length attenuation + bend
 * loss along the Bezier spline is TODO; the v2 implementation at
 * src/optical/fiber/ has the algorithms — port into this v3 op.
 *
 * Current stub: pass-through with optional dB/km attenuation from params.
 */

import { type BeamRay, vec3Distance } from "../../beam-ray";
import {
  type PhysicsOp, type PhysicsOpContext, registerKind,
} from "../../registry";

export const fiberPropagateOp: PhysicsOp = (
  rayIn: BeamRay, ctx: PhysicsOpContext,
): BeamRay[] => {
  const thickness = vec3Distance(
    ctx.faceIn.positionMmBodyLocal, ctx.faceOut.positionMmBodyLocal,
  );
  const lengthMm = (ctx.params.lengthMm as number | undefined) ?? thickness;
  const attDbPerKm = (ctx.params.attenuationDbPerKm as number | undefined) ?? 0;
  const lengthKm = lengthMm / 1e6;
  const attDb = attDbPerKm * lengthKm;
  const att = Math.pow(10, -attDb / 10);

  return [{
    ...rayIn,
    origin: ctx.faceOut.positionMmBodyLocal,
    powerMw: rayIn.powerMw * att,
    pathLengthMm: rayIn.pathLengthMm + thickness,
  }];
};

registerKind("fiber", {
  ops: { fiber_propagate: fiberPropagateOp },
  needsAperture: true,
});
