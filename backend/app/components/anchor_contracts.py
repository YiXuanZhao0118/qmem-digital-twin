"""Per-component-type anchor contracts — backend accessor.

Stage H consolidated the contract data into the frontend kinds plugin
definitions (``frontend/src/kinds/<id>/index.ts``'s
``componentAnchorContracts`` field). The frontend ``export:kinds`` step
emits the merged contract dictionary into
``backend/data/kinds.json::component_anchor_contracts``, and this
module is now a thin reader on top of that.

The legacy ``COMPONENT_ANCHOR_CONTRACTS`` constant still exists as a
read-only cached view so callers that iterated the dict continue to
work. New code should prefer :func:`get_anchor_contract` for a single
lookup or :func:`all_anchor_contracts` for the full map (cached).
"""

from __future__ import annotations

from functools import lru_cache

from app.kinds_manifest import component_anchor_contracts
from app.schemas import AssetAnchorId


# Keep the legacy field name shape so existing code that imports
# ``COMPONENT_ANCHOR_CONTRACTS`` directly keeps working. Resolved
# lazily on first access — module load order shouldn't depend on the
# manifest being parsed yet.
def _build_contracts() -> dict[str, list[dict]]:
    raw = component_anchor_contracts()
    out: dict[str, list[dict]] = {}
    for ct, templates in raw.items():
        out[ct] = [
            {
                "id": t["id"],
                **({"name": t["name"]} if "name" in t else {}),
                **(
                    {"positionMmBodyLocal": _vec3(t["position_mm_body_local"])}
                    if "position_mm_body_local" in t
                    else {}
                ),
                **(
                    {"directionBodyLocal": _vec3(t["direction_body_local"])}
                    if "direction_body_local" in t
                    else {}
                ),
            }
            for t in templates
        ]
    return out


def _vec3(d: dict[str, float]) -> dict[str, float]:
    return {"x": float(d["x"]), "y": float(d["y"]), "z": float(d["z"])}


@lru_cache(maxsize=1)
def all_anchor_contracts() -> dict[str, list[dict]]:
    """Full ``componentType → [AnchorTemplate]`` map (cached).

    Pydantic-friendly key shape (``positionMmBodyLocal`` /
    ``directionBodyLocal``) — same as the legacy ``COMPONENT_ANCHOR_CONTRACTS``
    constant.
    """
    return _build_contracts()


COMPONENT_ANCHOR_CONTRACTS: dict[str, list[dict]] = all_anchor_contracts()


def get_anchor_contract(component_type: str) -> list[dict] | None:
    """Return the locked anchor template list for a component_type, or None
    if the component_type isn't in the registry (= no identity lock)."""
    return all_anchor_contracts().get(component_type)


__all__ = [
    "COMPONENT_ANCHOR_CONTRACTS",
    "all_anchor_contracts",
    "get_anchor_contract",
    "AssetAnchorId",  # re-export for downstream type hints
]
