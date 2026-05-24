"""Tapered Amplifier (TA) PhysicsOp — STUB.

Real physics: optical gain with saturation (P_out = P_sat · log(1 + P_in/P_sat ·
(G_small-signal - 1))), spatial mode broadening (output Gaussian beam ~3 µm
fast axis × 200 µm slow axis), spectral selection (free spectral range), ASE
noise. The v2 ``TaperedAmplifierAdjustControls`` UI exposes nominalPowerOutW,
driveCurrentA, but no v3 op yet — port from v2 once gain model is settled.

Current stub: scalar gain factor from params.gainLinear (default 1.0 = no gain).

Op name: ta_amplify
Kind: tapered_amplifier
"""

from __future__ import annotations

from app.optical.beam_ray import BeamRay, vec3_distance
from app.optical.registry import KindEntry, PhysicsOpContext, register_kind


def ta_amplify_op(ray_in: BeamRay, ctx: PhysicsOpContext) -> list[BeamRay]:
    gain = float(ctx.params.get("gainLinear", 1.0))
    thickness = vec3_distance(
        ctx.face_in.position_mm_body_local,
        ctx.face_out.position_mm_body_local,
    )
    return [ray_in.replaced(
        origin=ctx.face_out.position_mm_body_local,
        power_mw=ray_in.power_mw * gain,
        path_length_mm=ray_in.path_length_mm + thickness,
    )]


register_kind("tapered_amplifier", KindEntry(
    ops={"ta_amplify": ta_amplify_op},
    needs_aperture=True,
))
