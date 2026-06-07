"""V3 solver orchestrator — runs the v3 ray tracer over a scene with
caller-supplied initial rays, returning serializable beam segments and
final rays.

In-memory only (no DB persistence). The existing v2 solver
(`solve_chain`) persists BeamSegment rows; v3 deliberately defers that
to a follow-up so the API can be exercised without DB writes.

API contract (consumed by `routers/v3_solver.py`):

    Input:
      - scene: V3Scene  (a list of V3SceneObject placements)
      - initial_rays: list[BeamRay]
      - options: TraceOptions

    Output:
      - V3SolverResult { run_id, segments, final_rays, errors, warnings }
"""

from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass, field
from typing import Optional

from app.optical.beam_ray import BeamRay, Vec3
# ---------------------------------------------------------------------------
# Serialization helpers (turn BeamRay / Vec3 into JSON-safe dicts)
# ---------------------------------------------------------------------------

def _vec3_to_dict(v: Vec3) -> dict:
    return {"x": float(v.x), "y": float(v.y), "z": float(v.z)}


def _complex_to_dict(c: complex) -> dict:
    return {"re": float(c.real), "im": float(c.imag)}


def beam_ray_to_dict(r: BeamRay) -> dict:
    """JSON-safe serialization of a BeamRay."""
    return {
        "origin":         _vec3_to_dict(r.origin),
        "direction":      _vec3_to_dict(r.direction),
        "wavelengthNm":   float(r.wavelength_nm),
        "powerMw":        float(r.power_mw),
        "jones":          [_complex_to_dict(r.jones[0]), _complex_to_dict(r.jones[1])],
        "qx":             _complex_to_dict(r.qx),
        "qy":             _complex_to_dict(r.qy),
        "pathLengthMm":   float(r.path_length_mm),
        "phaseAccumRad":  float(r.phase_accum_rad),
        "freqOffsetHz":   float(r.freq_offset_hz),
        "isGhost":        bool(r.is_ghost),
        "excludeFaceKey": r.exclude_face_key,
        "parentId":       r.parent_id,
    }


# ---------------------------------------------------------------------------
# Beam segment + result types
# ---------------------------------------------------------------------------

@dataclass
class V3BeamSegment:
    """One hit in the trace history — `face_in` was struck by `ray_in`,
    the op produced `out_rays`. Coordinates expressed in body-frame
    (op's input/output)."""
    asset_catalog_id: str
    face_in_id: str
    op: str
    ray_in: dict
    out_rays: list[dict]


@dataclass
class V3LabSegment:
    """Lab-frame straight beam segment for rendering. One per dequeued
    ray's traverse (from its origin to the next face hit, or to an
    escape tail point).

    Phase 7.1: also carries chain provenance + ray state at start so
    the frontend OpticalLinkViewerPanel + beam-scope can pick out a
    chain by emitter and render polarisation / waist without a separate
    legacy raycaster.
    """
    start: Vec3
    end: Vec3
    wavelength_nm: float
    power_mw: float
    scene_object_id: str | None
    binding_id: str | None
    asset_catalog_id: str | None
    face_in_id: str | None
    op: str | None
    is_terminal: bool
    # Phase 7.1 provenance + start-of-segment ray state.
    emitter_scene_object_id: str | None = None
    source_scene_object_id: str | None = None
    jones_re_x: float = 1.0
    jones_im_x: float = 0.0
    jones_re_y: float = 0.0
    jones_im_y: float = 0.0
    qx_re_at_start: float = 0.0
    qx_im_at_start: float = 0.0
    qy_re_at_start: float = 0.0
    qy_im_at_start: float = 0.0
    path_length_mm_at_start: float = 0.0
    freq_offset_hz_at_start: float = 0.0


@dataclass
class V3SolverResult:
    run_id: uuid.UUID
    segments: list[V3BeamSegment] = field(default_factory=list)
    lab_segments: list[V3LabSegment] = field(default_factory=list)
    final_rays: list[dict] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "runId": str(self.run_id),
            "segments": [
                {
                    "assetCatalogId": s.asset_catalog_id,
                    "faceInId": s.face_in_id,
                    "op": s.op,
                    "rayIn": s.ray_in,
                    "outRays": s.out_rays,
                }
                for s in self.segments
            ],
            "labSegments": [
                {
                    "start": _vec3_to_dict(s.start),
                    "end": _vec3_to_dict(s.end),
                    "wavelengthNm": s.wavelength_nm,
                    "powerMw": s.power_mw,
                    "sceneObjectId": s.scene_object_id,
                    "bindingId": s.binding_id,
                    "assetCatalogId": s.asset_catalog_id,
                    "faceInId": s.face_in_id,
                    "op": s.op,
                    "isTerminal": s.is_terminal,
                    "emitterSceneObjectId": s.emitter_scene_object_id,
                    "sourceSceneObjectId": s.source_scene_object_id,
                    "jones": [
                        {"re": s.jones_re_x, "im": s.jones_im_x},
                        {"re": s.jones_re_y, "im": s.jones_im_y},
                    ],
                    "qxAtStart": {"re": s.qx_re_at_start, "im": s.qx_im_at_start},
                    "qyAtStart": {"re": s.qy_re_at_start, "im": s.qy_im_at_start},
                    "pathLengthMmAtStart": s.path_length_mm_at_start,
                    "freqOffsetHz": s.freq_offset_hz_at_start,
                }
                for s in self.lab_segments
            ],
            "finalRays": self.final_rays,
            "errors": self.errors,
            "warnings": self.warnings,
        }


# ---------------------------------------------------------------------------
# Phase 9.8 — anchor-centric orchestrator (production path)
# ---------------------------------------------------------------------------

def solve_anchor_scene(
    scene,  # V3AnchorScene
    initial_rays: list[BeamRay] | None = None,
    options=None,  # AnchorTraceOptions
) -> V3SolverResult:
    """Run anchor-based trace + emit pass; produce V3SolverResult.

    Output schema unchanged (segments + labSegments + finalRays) so the
    frontend adapter, OpticalLinkViewerPanel, beam-scope etc. keep
    working without modification. ``segments`` is now empty (the new
    tracer doesn't carry the per-face TraceStep record) — adapter uses
    labSegments anyway, so this is harmless.
    """
    from app.optical.anchor_tracer import (
        AnchorTraceOptions,
        trace_ray_anchor_scene,
    )
    from app.optical.anchor_ops.emit_laser_source import (
        emit_anchor_source_rays,
        emit_ta_ase_rays,
    )

    options = options or AnchorTraceOptions()
    result = V3SolverResult(run_id=uuid.uuid4())

    if not scene.slots:
        result.warnings.append("scene has no slots — no anchors to trace against")

    if initial_rays:
        rays_with_prov = [(r, None, None) for r in initial_rays]
    else:
        rays_with_prov = emit_anchor_source_rays(scene)

    if not rays_with_prov:
        result.warnings.append("no laser_source emitters — solver runs no traces")

    def _run(rays: list, label: str) -> None:
        for i, (ray, emitter_id, source_id) in enumerate(rays):
            try:
                trace = trace_ray_anchor_scene(
                    ray, scene, options,
                    emitter_scene_object_id=emitter_id,
                    source_scene_object_id=source_id,
                )
            except Exception as exc:
                result.errors.append(f"{label}[{i}] trace failed: {exc!r}")
                continue
            for ls in trace.lab_segments:
                result.lab_segments.append(V3LabSegment(
                    start=ls.start, end=ls.end,
                    wavelength_nm=ls.wavelength_nm, power_mw=ls.power_mw,
                    scene_object_id=ls.scene_object_id,
                    binding_id=ls.binding_id,
                    asset_catalog_id=ls.asset_catalog_id,
                    face_in_id=ls.anchor_id,  # anchor_id mapped to faceInId for compat
                    op=ls.op_kind,
                    is_terminal=ls.is_terminal,
                    emitter_scene_object_id=ls.emitter_scene_object_id,
                    source_scene_object_id=ls.source_scene_object_id,
                    jones_re_x=ls.jones_re_x, jones_im_x=ls.jones_im_x,
                    jones_re_y=ls.jones_re_y, jones_im_y=ls.jones_im_y,
                    qx_re_at_start=ls.qx_re_at_start, qx_im_at_start=ls.qx_im_at_start,
                    qy_re_at_start=ls.qy_re_at_start, qy_im_at_start=ls.qy_im_at_start,
                    path_length_mm_at_start=ls.path_length_mm_at_start,
                    freq_offset_hz_at_start=ls.freq_offset_hz_at_start,
                ))
            for r in trace.final_rays:
                result.final_rays.append(beam_ray_to_dict(r))
            if trace.terminated == "max_steps":
                result.warnings.append(f"{label}[{i}] terminated by max_steps cap")

    # Seeded pass (laser_source emitters / caller-supplied initial rays).
    _run(rays_with_prov, "ray")

    # Phase C (decision 6b): tapered_amplifiers that received no upstream seed
    # emit ASE out both facets. Seeded TAs (whose object id shows up in the
    # seeded segments) emit nothing.
    seeded_ids = {ls.scene_object_id for ls in result.lab_segments if ls.scene_object_id}
    _run(emit_ta_ase_rays(scene, seeded_ids), "ase_ray")

    return result
