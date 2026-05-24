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
from app.optical.ray_tracer_v3 import (
    TraceOptions,
    V3Scene,
    emit_scene_source_rays,
    trace_ray_scene,
)


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
class V3SolverResult:
    run_id: uuid.UUID
    segments: list[V3BeamSegment] = field(default_factory=list)
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
            "finalRays": self.final_rays,
            "errors": self.errors,
            "warnings": self.warnings,
        }


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

def solve_v3_scene(
    scene: V3Scene,
    initial_rays: list[BeamRay],
    options: Optional[TraceOptions] = None,
) -> V3SolverResult:
    """Run trace_ray_scene once per initial ray, aggregate results.

    Per-ray failures are caught and reported in `errors`; the loop
    continues so a partial result is returned even if one ray traces
    fail.
    """
    options = options or TraceOptions()
    result = V3SolverResult(run_id=uuid.uuid4())

    if not scene.objects:
        result.warnings.append("scene has no objects — initial rays will escape immediately")

    rays_to_trace = list(initial_rays)
    if not rays_to_trace:
        rays_to_trace = emit_scene_source_rays(scene)

    if not rays_to_trace:
        result.warnings.append("no initial rays or laser_source emitters supplied — solver runs no traces")
        return result

    for i, ray in enumerate(rays_to_trace):
        try:
            trace = trace_ray_scene(ray, scene, options)
        except Exception as exc:  # pragma: no cover - guard for op bugs
            result.errors.append(f"ray[{i}] trace failed: {exc!r}")
            continue

        for step in trace.steps:
            result.segments.append(V3BeamSegment(
                asset_catalog_id=step.asset.catalog_id,
                face_in_id=step.face_in.id,
                op=step.op,
                ray_in=beam_ray_to_dict(step.ray_in),
                out_rays=[beam_ray_to_dict(r) for r in step.out_rays],
            ))
        for r in trace.final_rays:
            result.final_rays.append(beam_ray_to_dict(r))

        if trace.terminated == "max_steps":
            result.warnings.append(f"ray[{i}] terminated by max_steps cap")
        elif trace.terminated == "power_threshold":
            # not an error — quiet termination is normal for absorbed rays
            pass

    return result
