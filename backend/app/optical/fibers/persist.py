"""Write what a fibre / pigtail flow changed — one transaction, then the
same ``/ws/scene`` events the ordinary routers send.

The web store reaches the same end state through two or three REST calls
(``PUT /api/objects/{id}``, ``PUT /api/physics-elements/{id}``,
``POST /api/objects/{id}/object-bindings``); here every row is written in one
commit, through the same schema normalisation those routes apply:

* object ``properties`` — assigned verbatim (``SceneObjectUpdate.properties``
  is a plain JSON dict). Only ``properties``: nothing here writes a
  SceneObject pose, so an object's ``locked`` flag (which freezes its pose,
  ``objects.strip_locked_transform_updates``) is never bypassed.
* fibre PE ``kind_params`` — through ``schemas.OpticalElementBase``, exactly
  as ``physics_elements.update_physics_element`` does (``FiberParams``
  normalises it: defaults filled, unknown keys dropped).
* ``ObjectBinding`` rows — validated as ``schemas.ObjectBindingCreate`` and
  upserted on ``(object_id, component_binding_id)``, like
  ``object_bindings.upsert_object_binding``.

No Kind / Asset3D / Device / Component row is ever written, so ``lock_guard``
has nothing to guard here.
"""

from __future__ import annotations

import copy
import math
import uuid
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.models import ObjectBinding, PhysicsElement, SceneObject
from app.optical.fibers.scene import FiberScene
from app.optical.fibers.service import Writes
from app.routers.object_bindings import binding_payload
from app.routers.objects import object_payload
from app.routers.physics_elements import element_payload
from app.websocket import manager


class PersistError(Exception):
    """A write the schemas refuse (HTTP 422 with ``detail``)."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


@dataclass
class Persisted:
    objects: list[SceneObject] = field(default_factory=list)
    physics_elements: list[PhysicsElement] = field(default_factory=list)
    object_bindings: list[tuple[ObjectBinding, bool]] = field(default_factory=list)  # (row, created)


def _finite(value: Any, where: str) -> None:
    """Postgres JSONB has no NaN / Infinity; refuse instead of a 500."""
    if isinstance(value, float) and not math.isfinite(value):
        raise PersistError(f"{where}: non-finite number from a degenerate geometry.")
    if isinstance(value, dict):
        for k, v in value.items():
            _finite(v, f"{where}.{k}")
    elif isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            _finite(v, f"{where}[{i}]")


async def persist_writes(session: AsyncSession, scene: FiberScene, writes: Writes) -> Persisted:
    """Copy the rows ``writes`` names from ``scene`` onto the database and
    commit ONCE. Raises :class:`PersistError` before anything is committed."""
    out = Persisted()
    for oid in writes.objects:
        row = await session.get(SceneObject, uuid.UUID(oid))
        props = scene.objects[oid].properties
        _finite(props, f"objects[{oid}].properties")
        row.properties = copy.deepcopy(props)
        out.objects.append(row)

    for oid in writes.fiber_elements:
        el = (await session.scalars(
            select(PhysicsElement).where(PhysicsElement.object_id == uuid.UUID(oid))
        )).one()
        kind_params = scene.physics_elements[oid].kind_params
        _finite(kind_params, f"physicsElements[{oid}].kindParams")
        try:
            merged = schemas.OpticalElementBase(
                element_kind=el.element_kind,
                wavelength_range_nm=tuple(el.wavelength_range_nm),
                input_ports=el.input_ports or [],
                output_ports=el.output_ports or [],
                kind_params=kind_params,
            )
        except ValidationError as exc:
            raise PersistError(f"fibre kindParams rejected: {exc.errors()[0].get('msg')}") from exc
        el.element_kind = merged.element_kind
        el.wavelength_range_nm = list(merged.wavelength_range_nm)
        el.input_ports = [p.model_dump(by_alias=True) for p in merged.input_ports]
        el.output_ports = [p.model_dump(by_alias=True) for p in merged.output_ports]
        el.kind_params = merged.kind_params
        # Keep the in-memory scene equal to what is now stored.
        scene.physics_elements[oid].kind_params = copy.deepcopy(merged.kind_params)
        out.physics_elements.append(el)

    for oid, cb in writes.object_bindings:
        ns = scene.object_bindings[oid][cb]
        payload = schemas.ObjectBindingCreate(
            component_binding_id=uuid.UUID(cb),
            local_x_mm_delta=ns.local_x_mm_delta,
            local_y_mm_delta=ns.local_y_mm_delta,
            local_z_mm_delta=ns.local_z_mm_delta,
            local_rx_deg_delta=ns.local_rx_deg_delta,
            local_ry_deg_delta=ns.local_ry_deg_delta,
            local_rz_deg_delta=ns.local_rz_deg_delta,
            asset_3d_id_override=(
                uuid.UUID(str(ns.asset_3d_id_override)) if ns.asset_3d_id_override else None
            ),
            properties=copy.deepcopy(ns.properties or {}),
        )
        values = payload.model_dump()
        _finite(values, f"objectBindings[{oid}/{cb}]")
        existing = await session.scalar(
            select(ObjectBinding)
            .where(ObjectBinding.object_id == uuid.UUID(oid))
            .where(ObjectBinding.component_binding_id == uuid.UUID(cb))
        )
        if existing is None:
            row = ObjectBinding(object_id=uuid.UUID(oid), **values)
            session.add(row)
            out.object_bindings.append((row, True))
        else:
            for key, value in values.items():
                setattr(existing, key, value)
            out.object_bindings.append((existing, False))

    await session.commit()
    for row in out.objects:
        await session.refresh(row)
    for el in out.physics_elements:
        await session.refresh(el)
    for row, _ in out.object_bindings:
        await session.refresh(row)
        scene.object_bindings[str(row.object_id)][str(row.component_binding_id)].id = str(row.id)
    return out


async def broadcast_persisted(p: Persisted) -> None:
    """The events the ordinary routers send for the same writes."""
    for row in p.objects:
        await manager.broadcast("object.updated", object_payload(row))
    for el in p.physics_elements:
        await manager.broadcast("physics_element.updated", element_payload(el))
    for row, created in p.object_bindings:
        await manager.broadcast(
            "object_binding.created" if created else "object_binding.updated",
            binding_payload(row),
        )
