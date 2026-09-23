"""Surface optics: parts traced through their real faces (docs/surface-optics.md).

Phase 1 — standalone; nothing in the anchor tracer calls this yet.
"""

from app.optical.surfaces.model import SurfaceModel, parse_surface_model
from app.optical.surfaces.trace import ElementTrace, InternalSegment, trace_element

__all__ = [
    "ElementTrace",
    "InternalSegment",
    "SurfaceModel",
    "parse_surface_model",
    "trace_element",
]
