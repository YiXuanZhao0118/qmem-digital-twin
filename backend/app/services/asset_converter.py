from __future__ import annotations

import os
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path

from app.config import settings


SUPPORTED_ASSET_EXTENSIONS = {".glb", ".gltf", ".obj", ".stl", ".step", ".stp", ".sldprt", ".dxf"}
VIEWER_ASSET_EXTENSIONS = {".glb", ".gltf", ".obj", ".stl"}
CAD_SOURCE_EXTENSIONS = {".step", ".stp", ".sldprt", ".dxf"}
AUTO_CONVERTIBLE_CAD_EXTENSIONS = {".step", ".stp"}

DEFAULT_FREECADCMD_PATH = Path(r"C:\Users\admin\AppData\Local\Programs\FreeCAD 1.1\bin\freecadcmd.exe")

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


@dataclass(frozen=True)
class CadConversionResult:
    ok: bool
    source_relative_path: str
    viewer_relative_path: str | None
    viewer_asset_type: str | None
    message: str


def _freecadcmd_path() -> Path | None:
    configured = os.environ.get("FREECADCMD_PATH")
    if configured:
        path = Path(configured)
        return path if path.is_file() else None
    return DEFAULT_FREECADCMD_PATH if DEFAULT_FREECADCMD_PATH.is_file() else None


def convert_cad_source_to_stl(
    source_relative_path: str,
    *,
    output_stem: str | None = None,
    timeout_sec: int = 180,
) -> CadConversionResult:
    """Convert a CAD source file into a viewer-ready STL via FreeCAD.

    This is the app equivalent of Blender's importer step: browser/WebGL
    still renders triangles, so CAD B-rep geometry must be tessellated
    before the 3D face locator can display it.
    """
    source_path = resolve_asset_path(source_relative_path)
    suffix = source_path.suffix.lower()
    if suffix not in AUTO_CONVERTIBLE_CAD_EXTENSIONS:
        return CadConversionResult(
            ok=False,
            source_relative_path=source_relative_path,
            viewer_relative_path=None,
            viewer_asset_type=None,
            message=f"No automatic converter configured for {suffix}.",
        )

    freecadcmd = _freecadcmd_path()
    if freecadcmd is None:
        return CadConversionResult(
            ok=False,
            source_relative_path=source_relative_path,
            viewer_relative_path=None,
            viewer_asset_type=None,
            message="FreeCAD command-line executable not found. Set FREECADCMD_PATH.",
        )

    repo_root = Path(__file__).resolve().parents[3]
    script = repo_root / "scripts" / "convert_step_to_stl.py"
    if not script.is_file():
        return CadConversionResult(
            ok=False,
            source_relative_path=source_relative_path,
            viewer_relative_path=None,
            viewer_asset_type=None,
            message=f"Converter script not found: {script}",
        )

    safe_stem = "".join(
        ch.lower() if ch.isalnum() else "_"
        for ch in (output_stem or source_path.stem)
    ).strip("_") or "cad_asset"
    output_name = f"{uuid.uuid4()}_{safe_stem}.stl"
    output_dir = settings.asset_root / "files" / "stl"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / output_name

    code = (
        "import sys; "
        f"sys.argv=[r'{script}', r'{source_path}', r'{output_path}']; "
        f"exec(open(r'{script}', encoding='utf-8').read())"
    )
    completed = subprocess.run(
        [str(freecadcmd), "-c", code],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        timeout=timeout_sec,
        check=False,
    )
    if completed.returncode != 0 or not output_path.is_file():
        return CadConversionResult(
            ok=False,
            source_relative_path=source_relative_path,
            viewer_relative_path=None,
            viewer_asset_type=None,
            message=(completed.stderr or completed.stdout or "FreeCAD conversion failed.").strip(),
        )

    return CadConversionResult(
        ok=True,
        source_relative_path=source_relative_path,
        viewer_relative_path=f"files/stl/{output_name}",
        viewer_asset_type="stl",
        message=(completed.stdout or "Converted CAD source to STL.").strip(),
    )
