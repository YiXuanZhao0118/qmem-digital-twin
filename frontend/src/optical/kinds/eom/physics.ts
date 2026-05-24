/**
 * EOM (electro-optic modulator) PhysicsOp — STUB.
 *
 * Real Pockels-effect physics (RF-driven index modulation, Jones phase
 * shift on the modulated axis) is TODO. Pass-through stub so the catalog
 * entry exists and tracer doesn't crash.
 */

import { type BeamRay, vec3Distance } from "../../beam-ray";
import {
  type PhysicsOp, type PhysicsOpContext, registerKind,
} from "../../registry";

export const eomPassthroughOp: PhysicsOp = (
  rayIn: BeamRay, ctx: PhysicsOpContext,
): BeamRay[] => {
  const thickness = vec3Distance(
    ctx.faceIn.positionMmBodyLocal, ctx.faceOut.positionMmBodyLocal,
  );
  return [{
    ...rayIn,
    origin: ctx.faceOut.positionMmBodyLocal,
    pathLengthMm: rayIn.pathLengthMm + thickness,
  }];
};

registerKind("eom", {
  ops: { eom_passthrough: eomPassthroughOp },
  needsAperture: true,
});
