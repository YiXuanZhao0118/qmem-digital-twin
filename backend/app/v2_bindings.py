"""Helpers for V2 anchor bindings on per-instance SceneObjects.

The V2 schema (docs/optical-schema-v2.md §3) puts per-instance geometry
data into ``objects.properties.anchorBindings[]`` instead of mixing it
with transfer physics in ``optical_elements.kind_params``.

This module:
1. Provides a stable rule for picking which asset anchor a given binding
   should reference (used by both the create-object flow and per-kind
   migrations).
2. Provides accessors that read a per-instance value out of a binding
   payload, defaulting through asset anchor → kind default → final
   fallback the same way the migration backfill did.

Per-kind cutovers (mirror is Phase 2; more follow) call into here so the
selection logic stays in one place.
"""

from __future__ import annotations

from typing import Any

from app.models import Asset3D, Component, SceneObject
from app.uuid7 import uuid7_str


OPTICAL_ANCHOR_ID = "optical_anchor"
OPTICAL_SURFACE_BINDING_KIND = "opticalSurface"


def pick_optical_surface_anchor_id(asset_anchors: list[Any] | None) -> str | None:
    """Pick the anchor an opticalSurface binding should reference.

    Preference (matches the alembic 0028 migration so backfilled rows and
    newly-created rows bind to the same anchor for the same asset):

      1. ``optical_anchor`` (explicit, asset-importer authored)
      2. anchors hinting at an optical surface in id/name
         (``intercept_face`` / ``intercept_in`` / ``intercept_out`` / contains "optical")
      3. first anchor that has an id at all
      4. ``None`` — caller decides whether to skip the binding
    """
    if not asset_anchors:
        return None
    by_id = {a.get("id"): a for a in asset_anchors if isinstance(a, dict)}

    if OPTICAL_ANCHOR_ID in by_id:
        return OPTICAL_ANCHOR_ID

    for hint in ("intercept_face", "intercept_in", "intercept_out", "optical"):
        for a in asset_anchors:
            if not isinstance(a, dict):
                continue
            if a.get("id") == hint:
                return hint
            name = (a.get("name") or "").lower()
            if hint in name:
                return a.get("id")

    for a in asset_anchors:
        if isinstance(a, dict) and a.get("id"):
            return a["id"]
    return None


def make_optical_surface_binding(
    *,
    anchor_id: str,
    normal_body_local: list[float],
    name: str = "Reflective surface",
) -> dict[str, Any]:
    """Build one V2 ``opticalSurface`` binding entry."""
    return {
        "id": uuid7_str(),
        "name": name,
        "anchorId": anchor_id,
        "kind": OPTICAL_SURFACE_BINDING_KIND,
        "frame": "anchorLocalXY",
        "payload": {"normalBodyLocal": list(normal_body_local)},
    }


def append_binding(properties: dict[str, Any] | None, binding: dict[str, Any]) -> dict[str, Any]:
    """Add ``binding`` to the SceneObject ``properties.anchorBindings[]``,
    initialising the list if absent. Returns the (possibly new) properties
    dict so the caller can re-assign it onto the SceneObject."""
    out = dict(properties or {})
    existing = out.get("anchorBindings")
    if not isinstance(existing, list):
        existing = []
    existing.append(binding)
    out["anchorBindings"] = existing
    return out


def find_binding(
    scene_object: SceneObject | dict[str, Any] | None,
    *,
    kind: str,
) -> dict[str, Any] | None:
    """Return the first ``anchorBindings[]`` entry on ``scene_object``
    matching ``kind``, or ``None`` if absent. Accepts either a SQLAlchemy
    SceneObject row or a plain dict shaped like ``{"properties": {...}}``."""
    if scene_object is None:
        return None
    if isinstance(scene_object, dict):
        properties = scene_object.get("properties") or {}
    else:
        properties = scene_object.properties or {}
    bindings = properties.get("anchorBindings") or []
    for b in bindings:
        if isinstance(b, dict) and b.get("kind") == kind:
            return b
    return None


def get_mirror_normal_body_local(scene_object: SceneObject | dict[str, Any] | None) -> list[float] | None:
    """Read the V2 mirror reflective-surface normal off a SceneObject.

    Returns ``None`` if the object has no opticalSurface binding (caller
    falls back to asset anchor or the kind default ``[1, 0, 0]``)."""
    binding = find_binding(scene_object, kind=OPTICAL_SURFACE_BINDING_KIND)
    if binding is None:
        return None
    payload = binding.get("payload") or {}
    raw = payload.get("normalBodyLocal")
    if not isinstance(raw, list) or len(raw) < 3:
        return None
    try:
        return [float(raw[0]), float(raw[1]), float(raw[2])]
    except (TypeError, ValueError):
        return None


async def bootstrap_mirror_default_binding(
    scene_object: SceneObject,
    component: Component,
    asset: Asset3D | None,
) -> bool:
    """If ``scene_object`` is a freshly-created mirror with no
    opticalSurface binding yet, attach a default one (normal=[1,0,0]) bound
    to the asset's preferred anchor. Returns True iff a binding was added.

    Caller is expected to be inside an open async session; the SceneObject
    row's ``properties`` is mutated in-place. ``await session.commit()``
    or refresh is the caller's responsibility.
    """
    if find_binding(scene_object, kind=OPTICAL_SURFACE_BINDING_KIND) is not None:
        return False
    if asset is None:
        return False
    anchor_id = pick_optical_surface_anchor_id(asset.anchors or [])
    if anchor_id is None:
        return False
    binding = make_optical_surface_binding(
        anchor_id=anchor_id,
        normal_body_local=[1.0, 0.0, 0.0],
    )
    scene_object.properties = append_binding(scene_object.properties, binding)
    return True
