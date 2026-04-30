from __future__ import annotations

from pathlib import Path

from app.config import settings


SUPPORTED_ASSET_EXTENSIONS = {".glb", ".gltf", ".obj", ".stl", ".step", ".stp", ".sldprt", ".dxf"}
VIEWER_ASSET_EXTENSIONS = {".glb", ".gltf", ".obj", ".stl"}


def resolve_asset_path(relative_path: str) -> Path:
    path = (settings.asset_root / relative_path).resolve()
    if not path.is_relative_to(settings.asset_root.resolve()):
        raise ValueError("Asset path must stay inside ASSET_ROOT")
    return path


def validate_asset_file(relative_path: str) -> Path:
    path = resolve_asset_path(relative_path)
    if path.suffix.lower() not in SUPPORTED_ASSET_EXTENSIONS:
        raise ValueError(f"Unsupported asset extension: {path.suffix}")
    return path
