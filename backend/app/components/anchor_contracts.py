"""Per-component-type anchor contracts — backend accessor.

A *contract* is the locked anchor identity (ids + names, plus the seeded
coordinates) for one catalog componentType. It is not authored anywhere of
its own: it is derived from the device registry, keyed by componentType,
and only for devices whose componentType is a DISTINCT catalog part-form
(``component_type != behavioral_kind``, e.g. ``dds_ad9959_pcb`` vs kind
``rf_source``). Generic-form devices are deliberately excluded because many
devices share one kind and would overwrite each other's entry.

History: the data lived in the frontend plugins' ``componentAnchorContracts``
field, then in ``backend/data/kinds.json::component_anchor_contracts`` (which
``npm run export:kinds`` materialised from the TypeScript device registry).
Devices moved into the ``devices`` table in alembic 0123, so the manifest can
no longer produce this map and it is computed from the DB here instead.

That makes the accessor **async** and uncached — the old
``COMPONENT_ANCHOR_CONTRACTS`` module constant could not survive the move,
because a module-level constant cannot await a session. Callers pass their
session in.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Device
from app.schemas import AssetAnchorId


def _vec3(d: dict[str, float]) -> dict[str, float]:
    return {"x": float(d["x"]), "y": float(d["y"]), "z": float(d["z"])}


def _template(anchor: dict[str, Any]) -> dict[str, Any]:
    """One device anchor as a contract template.

    ``role`` becomes ``id`` (that is the anchor identity the asset stores);
    the snake_case device shape becomes the pydantic-friendly camelCase the
    Asset3D anchor payloads use.
    """
    out: dict[str, Any] = {"id": anchor["role"]}
    if anchor.get("name") is not None:
        out["name"] = anchor["name"]
    if anchor.get("position_mm_body_local") is not None:
        out["positionMmBodyLocal"] = _vec3(anchor["position_mm_body_local"])
    if anchor.get("direction_body_local") is not None:
        out["directionBodyLocal"] = _vec3(anchor["direction_body_local"])
    return out


async def all_anchor_contracts(
    session: AsyncSession,
) -> dict[str, list[dict[str, Any]]]:
    """Full ``componentType -> [AnchorTemplate]`` map, derived from devices."""
    devices = list((await session.scalars(select(Device))).all())
    out: dict[str, list[dict[str, Any]]] = {}
    for device in devices:
        anchors = list(device.anchors or [])
        # An anchorless device (the render-only mechanical fixtures, whose
        # behavioral_kind is null so component_type can never equal it) would
        # otherwise write an empty contract over the key — inert today, but it
        # would silently clobber a real template later. Skip those.
        if device.component_type == device.behavioral_kind or not anchors:
            continue
        out[device.component_type] = [_template(a) for a in anchors]
    return out


async def get_anchor_contract(
    session: AsyncSession, component_type: str
) -> list[dict[str, Any]] | None:
    """The locked anchor template list for one componentType, or None when
    that componentType has no identity lock."""
    return (await all_anchor_contracts(session)).get(component_type)


__all__ = [
    "all_anchor_contracts",
    "get_anchor_contract",
    "AssetAnchorId",  # re-export for downstream type hints
]
