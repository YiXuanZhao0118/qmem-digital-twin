"""JSON schemas exposed to Claude for the binding agent's tool use.

These are the *LLM-facing* shapes — they describe what the model can
ask for. The dispatcher in :mod:`app.services.agent_orchestrator`
maps each ``tool_use`` block to the matching function in
:mod:`app.services.agent_tools` and injects the session-scoped
context (``db``, ``session_id``) that's deliberately *not* part of
the schema.

The last tool definition carries ``cache_control: {type: "ephemeral"}``
so the entire ``tools`` + ``system`` prefix caches across turns
within a session. Adding or reordering tools invalidates the cache;
keep this list stable per release.
"""

from __future__ import annotations

from typing import Any


SYSTEM_PROMPT = """You are a 3D asset binding assistant for a quantum-optics lab digital twin.

Your job: given a user's instruction, create draft Asset3D rows (3D models with anchor metadata) and Component catalog entries (typed by `component_type`, linked to assets via `asset_3d_id`) so they can review and approve the binding.

Tools available:
- `list_kinds()` — every valid `component_type` value. Call this BEFORE create_component if you're not sure the kind exists.
- `list_existing_assets()` / `list_existing_components()` — what's already in the catalog (active rows + your own session's drafts). Use to avoid duplicates and to find existing Asset3D ids to bind to.
- `create_asset(name, asset_type, file_path, ...)` — register a new 3D asset as a draft.
- `create_component(name, component_type, asset_3d_id?, ...)` — register a catalog entry as a draft. `asset_3d_id` should reference either an existing active asset, or one you just created in this session.

Rules:
1. Never invent a `component_type` — call `list_kinds()` first if unsure.
2. Drafts are invisible to the user until they approve. Don't worry about clutter; create what you need.
3. If the user's instruction is ambiguous, ask one clarifying question and stop — don't guess and create the wrong thing.
4. After creating things, summarize what you did in plain language so the user can review.
5. Don't try to update or delete — your role is to propose new bindings only. If the user wants to change an existing locked binding, tell them to unlock it first.
"""


AGENT_TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "list_kinds",
        "description": (
            "Return every valid `component_type` value the agent may pass to "
            "`create_component`. Call this before creating a component if "
            "you're not certain the kind exists."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "list_existing_assets",
        "description": (
            "List every Asset3D the agent can see: all active assets in the "
            "catalog plus drafts created in the current session. Use to find "
            "an existing `asset_3d_id` before creating a duplicate."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "list_existing_components",
        "description": (
            "List every Component the agent can see: all active components "
            "plus drafts created in the current session. Use to avoid "
            "creating a duplicate catalog entry."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "create_asset",
        "description": (
            "Insert a draft Asset3D row. The asset becomes visible to the "
            "rest of the system only after the user approves the session."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Human-readable name. Cannot be empty.",
                },
                "asset_type": {
                    "type": "string",
                    "description": (
                        "File format token, lowercase, no leading dot. "
                        "Common values: glb, stl, step, gltf, fbx."
                    ),
                },
                "file_path": {
                    "type": "string",
                    "description": (
                        "Absolute or repo-relative path where the 3D file "
                        "lives. The orchestrator does not move files — pass "
                        "the path you want stored in the DB."
                    ),
                },
                "unit": {
                    "type": "string",
                    "enum": ["mm", "m"],
                    "description": "Unit of the file's native coordinates. Default mm.",
                },
                "scale_factor": {
                    "type": "number",
                    "description": "Multiplier applied when loading. Default 1.0.",
                },
                "anchors": {
                    "type": "array",
                    "description": (
                        "Anchor metadata (RF / optical port positions). "
                        "Pass [] if unknown — the user can fill in via the "
                        "PHY Editor later."
                    ),
                    "items": {"type": "object"},
                },
                "source": {
                    "type": "string",
                    "description": "Where the file came from (vendor, scan job, manual mesh).",
                },
                "source_url": {
                    "type": "string",
                    "description": "Optional URL the file was downloaded from.",
                },
            },
            "required": ["name", "asset_type", "file_path"],
        },
    },
    {
        "name": "create_component",
        "description": (
            "Insert a draft Component (catalog entry) linked to a kind and "
            "optionally to an Asset3D. The component becomes visible to "
            "the rest of the system only after the user approves the "
            "session."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Human-readable name, must be unique. Cannot be empty.",
                },
                "component_type": {
                    "type": "string",
                    "description": (
                        "Kind identifier from list_kinds() (e.g. 'aom', "
                        "'mirror', 'laser_source'). The orchestrator "
                        "rejects unknown values."
                    ),
                },
                "asset_3d_id": {
                    "type": "string",
                    "description": (
                        "UUID of an existing active Asset3D or a draft "
                        "Asset3D this session created. Omit if the "
                        "component has no 3D representation yet."
                    ),
                },
                "brand": {
                    "type": "string",
                    "description": "Manufacturer brand (e.g. 'Thorlabs').",
                },
                "model": {
                    "type": "string",
                    "description": "Model number (e.g. 'BB1-E03').",
                },
                "properties": {
                    "type": "object",
                    "description": (
                        "Free-form JSONB for kind-specific metadata. Leave "
                        "{} unless the user gave specifics."
                    ),
                },
                "notes": {
                    "type": "string",
                    "description": "Optional human-readable comment.",
                },
            },
            "required": ["name", "component_type"],
        },
        # Caching anchor: marking the LAST tool with cache_control caches
        # the full `tools` block (plus `system`, which renders before
        # `tools` in the prefix). Subsequent turns in the same session
        # re-send the same tools array byte-for-byte and pay ~0.1x for
        # the prefix.
        "cache_control": {"type": "ephemeral"},
    },
]
