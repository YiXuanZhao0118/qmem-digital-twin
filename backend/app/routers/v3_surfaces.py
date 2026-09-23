"""Surface-model authoring helpers — POST /api/v3/surfaces/fit and /sheets.

Both clients (the web PHY Editor and the Blender add-on) call these instead
of carrying their own fit or sag (qmem-blender ARCHITECTURE.md rule 2). See
app/optical/surfaces/fit.py and docs/surface-optics.md, Phase 4.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, status
from pydantic import Field

from app.optical.surfaces.fit import fit_at_triangle, surface_from_fit, surface_sheet
from app.optical.surfaces.model import parse_surface_model
from app.schemas import CamelModel
from app.schemas_v3 import SurfaceModelV3

router = APIRouter(prefix="/v3/surfaces", tags=["v3-surfaces"])


class SurfaceFitRequest(CamelModel):
    """A triangle soup (9 numbers per triangle) in the asset frame, and the
    index of the triangle that was clicked."""
    triangles: list[float] = Field(min_length=9)
    seed: int


@router.post("/fit")
def fit_surface(req: SurfaceFitRequest) -> dict:
    if len(req.triangles) % 9:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "triangles: 9 numbers per triangle")
    fit = fit_at_triangle(req.triangles, req.seed)
    if fit is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "no plane, sphere or cylinder fits the smooth region around that triangle",
        )
    return {
        "shape": fit.shape,
        "radiusMm": fit.radius,
        "rmsMm": fit.rms,
        "triangles": fit.triangles,
        "position": {"x": float(fit.position[0]), "y": float(fit.position[1]), "z": float(fit.position[2])},
        "normal": {"x": float(fit.normal[0]), "y": float(fit.normal[1]), "z": float(fit.normal[2])},
        "surface": surface_from_fit(fit),
    }


class SurfaceSheetsRequest(CamelModel):
    surface_model: SurfaceModelV3
    rings: Optional[int] = Field(default=16, ge=1, le=128)
    segments: Optional[int] = Field(default=48, ge=8, le=512)


@router.post("/sheets")
def surface_sheets(req: SurfaceSheetsRequest) -> dict:
    model = parse_surface_model(req.surface_model.model_dump(by_alias=True, exclude_none=True))
    out = []
    for s in model.surfaces:
        vertices, faces = surface_sheet(s, req.rings or 16, req.segments or 48)
        out.append({"id": s.id, "vertices": vertices, "faces": faces})
    return {"surfaces": out}
