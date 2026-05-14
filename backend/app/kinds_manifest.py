"""Backend-side accessor for the kind metadata manifest.

The manifest at `backend/data/kinds.json` is generated from the frontend
PhysicsPlugin / PassivePlugin registry via
`scripts/export_kinds_manifest.ts`. Backend code that needs to know
"which ElementKind does componentType X map to?" or "what are the valid
ElementKind values?" reads it from here so backend + frontend can never
drift.

Run order:
    1. Frontend plugins are the source of truth.
    2. `npm run export:kinds` (or `make data-bootstrap`) regenerates
       `backend/data/kinds.json`.
    3. Backend imports `kinds_manifest` at module-load time; if the
       file is missing or unparseable, FastAPI startup fails fast
       (M5's fail-loud principle — never silently degrade).

Add the JSON to git so fresh checkouts have working seed/API behaviour
before anyone runs the export script.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

# Located at backend/data/kinds.json relative to repo root.
_MANIFEST_PATH = Path(__file__).resolve().parents[1] / "data" / "kinds.json"


class KindsManifestError(RuntimeError):
    """Raised when the manifest is missing, unreadable, or stale.

    Fail-loud rather than silently degrading — a missing manifest
    today causes the entire kind validation / catalog auto-link to
    return null, which masks real bugs (see the pre-P2 grey-box
    incident: `/c/repos/scripts/thorlabs_cad_manifest.json` lookup
    failed silently, all mechanical models rendered as grey cubes).
    """


@lru_cache(maxsize=1)
def load_manifest() -> dict[str, Any]:
    if not _MANIFEST_PATH.is_file():
        raise KindsManifestError(
            f"kinds.json not found at {_MANIFEST_PATH}. Run "
            "`cd frontend && npm run export:kinds` to regenerate. "
            "This file is the source-of-truth shim between the frontend "
            "plugin registry and backend kind validation."
        )
    try:
        text = _MANIFEST_PATH.read_text(encoding="utf-8")
        data = json.loads(text)
    except Exception as e:
        raise KindsManifestError(f"Failed to read kinds.json: {e}") from e
    if not isinstance(data, dict) or data.get("schema_version") != 1:
        raise KindsManifestError(
            f"kinds.json schema_version mismatch (expected 1, got "
            f"{data.get('schema_version') if isinstance(data, dict) else 'non-object'}). "
            "Regenerate with `npm run export:kinds`."
        )
    return data


def component_type_to_kind() -> dict[str, str]:
    """Replaces the hand-maintained
    `OPTICAL_COMPONENT_TYPE_TO_KIND` constant in
    `routers/components.py`. Same shape; derived from frontend plugins.
    """
    return dict(load_manifest()["component_type_to_kind"])


def element_kinds() -> list[str]:
    """Valid ElementKind values, in plugin registration order. Use this
    to validate incoming `kind` strings or build a Literal type
    dynamically.
    """
    return list(load_manifest()["element_kinds"])


def physics_plugins() -> list[dict[str, Any]]:
    """Full physics-plugin records — anchors, alignVariant, defaults.
    Useful for backend solvers that need to know "what anchors should I
    expect on a kind X component?" without duplicating the contract.
    """
    return list(load_manifest()["physics_plugins"])


def asset_name_patterns() -> dict[str, str]:
    """`componentType → assetNamePattern` for every plugin that
    declared one. M5's API-layer auto-linker (replacing the one-shot
    `link_components_to_stl.py`) uses this to resolve a Component's
    asset_3d_id from its name when the column is null.
    """
    out: dict[str, str] = {}
    manifest = load_manifest()
    for plugin in manifest["physics_plugins"] + manifest["passive_plugins"]:
        pattern = plugin.get("asset_name_pattern")
        if pattern:
            for ct in plugin["component_types"]:
                out[ct] = pattern
    return out
