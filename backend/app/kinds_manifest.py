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


def intrinsic_keys_by_kind() -> dict[str, list[str]]:
    """`elementKind → list of kindParam keys tagged as intrinsic`. Phase 2
    plugin metadata. Plugins that haven't been migrated yet (the export
    emits ``null`` for those) are omitted from the dict so the caller can
    distinguish "no entry → treat all params as state" from "explicit
    empty list → no intrinsic params at all" (the rf_amplifier case
    inverted)."""
    out: dict[str, list[str]] = {}
    for p in load_manifest()["physics_plugins"]:
        keys = p.get("physics", {}).get("intrinsic_param_keys")
        if isinstance(keys, list):
            out[p["physics"]["element_kind"]] = list(keys)
    return out


def state_keys_by_kind() -> dict[str, list[str]]:
    """Mirror of `intrinsic_keys_by_kind()` for state params. Same
    contract: missing entry = legacy plugin = treat everything as state."""
    out: dict[str, list[str]] = {}
    for p in load_manifest()["physics_plugins"]:
        keys = p.get("physics", {}).get("state_param_keys")
        if isinstance(keys, list):
            out[p["physics"]["element_kind"]] = list(keys)
    return out


def port_domains_by_kind() -> dict[str, dict[str, str]]:
    """`elementKind → {anchor_id: domain_label}`. Phase 2 metadata for
    typed cable connections (rf / optical / trigger / ttl / dc).
    Returns an empty inner dict for plugins that don't declare overrides."""
    out: dict[str, dict[str, str]] = {}
    for p in load_manifest()["physics_plugins"]:
        out[p["physics"]["element_kind"]] = dict(p.get("physics", {}).get("port_domains") or {})
    return out


def partition_kind_params(element_kind: str, kind_params: dict) -> tuple[dict, dict]:
    """Split a kindParams blob into `(intrinsic_params, state_params)`
    using the plugin's declared keys. For un-migrated plugins (no
    intrinsic/state lists in the manifest) this returns ``({}, kp.copy())``
    — every key falls into state, which matches the pre-Phase-2 default.
    Keys present in `kind_params` but listed in NEITHER side are treated
    as state too (defensive fallback so a stray field can't disappear)."""
    intrinsic_lookup = intrinsic_keys_by_kind()
    state_lookup = state_keys_by_kind()
    intrinsic_keys = set(intrinsic_lookup.get(element_kind) or [])
    state_keys = set(state_lookup.get(element_kind) or [])
    if not intrinsic_keys and not state_keys:
        # Legacy plugin: everything is state.
        return {}, dict(kind_params or {})
    intrinsic_out: dict = {}
    state_out: dict = {}
    for k, v in (kind_params or {}).items():
        if k in intrinsic_keys and k not in state_keys:
            intrinsic_out[k] = v
        elif k in state_keys:
            state_out[k] = v
        else:
            # Key in neither list — treat as state (defensive default;
            # `partitionKindParamKeys` in the frontend flags these as
            # `unclassified` and the exhaustiveness test asserts the list
            # is empty for every migrated plugin, so seeing one here in
            # production indicates a real DB row has a stray key).
            state_out[k] = v
    return intrinsic_out, state_out


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
