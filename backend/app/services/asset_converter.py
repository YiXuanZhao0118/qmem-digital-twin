from __future__ import annotations

from pathlib import Path

from app.config import settings


SUPPORTED_ASSET_EXTENSIONS = {".glb", ".gltf", ".obj", ".stl", ".step", ".stp", ".sldprt", ".dxf"}
VIEWER_ASSET_EXTENSIONS = {".glb", ".gltf", ".obj", ".stl"}
CAD_SOURCE_EXTENSIONS = {".step", ".stp", ".sldprt", ".dxf"}

# Prefixes allowed under ASSET_ROOT (alembic 0063). Anything else gets
# rejected by resolve_asset_path — keeps the static-files mount honest
# and prevents stale ``uploads/`` references from sneaking back in.
ALLOWED_ASSET_PREFIXES: tuple[str, ...] = ("files/", "agent_uploads/")


def subdir_for_ext(suffix: str) -> str:
    """Map a file extension to its subdirectory under ``files/``.

    Viewer-ready extensions get their own subdirectory by name
    (``files/stl/``, ``files/glb/``, ...) so the loader can match on
    path prefix when it needs to. CAD sources collapse into
    ``files/cad_sources/`` because they're never directly rendered —
    they sit there as the original geometry for re-export to a
    viewer-ready format.
    """
    ext = suffix.lower().lstrip(".")
    if f".{ext}" in VIEWER_ASSET_EXTENSIONS:
        return ext
    return "cad_sources"


def resolve_asset_path(relative_path: str) -> Path:
    if not any(relative_path.startswith(p) for p in ALLOWED_ASSET_PREFIXES):
        raise ValueError(
            f"Asset path {relative_path!r} must start with one of "
            f"{ALLOWED_ASSET_PREFIXES}"
        )
    path = (settings.asset_root / relative_path).resolve()
    if not path.is_relative_to(settings.asset_root.resolve()):
        raise ValueError("Asset path must stay inside ASSET_ROOT")
    return path


def validate_asset_file(relative_path: str) -> Path:
    path = resolve_asset_path(relative_path)
    if path.suffix.lower() not in SUPPORTED_ASSET_EXTENSIONS:
        raise ValueError(f"Unsupported asset extension: {path.suffix}")
    return path
