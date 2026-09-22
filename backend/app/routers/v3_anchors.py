"""Traced anchor poses — POST /api/v3/anchors/traced.

Compute-only (writes nothing). Every anchor in lab mm exactly as the tracer's
loader (``db_scene_loader.load_anchor_scene_from_db``) hands it to the
tracer — the same ``V3AnchorScene`` ``/api/v3/solver/run-from-db`` traces —
so a second client (the qmem-blender add-on) draws the faces the trace
actually hits instead of re-deriving them from the stored anchors. The two
differ in exactly the places the loader rewrites:

* a pigtailed device's ports re-seated onto the fibre connectors bound at
  them (``_port_connector_anchors``: position, axisY, aperture from the
  connector's mating face);
* the AOM's ``interaction_center``, derived as the midpoint of its faces
  when the asset stores none (``synthesized``);
* a connector fibre's coupling ports, built from its PhysicsElement
  ``kindParams.endA/endB`` into a slot of their own (``_synth_fiber_slot``,
  binding id ``fiber_body``, ``synthesized``);
* per-instance asset swaps (``ObjectBinding.asset_3d_id_override``).

and in what it leaves out: bindings that are not ``asset`` targets, and
therefore everything inside a spliced sub-Component, and assets whose
anchors lack the tri-axis frame.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.optical.anchor_tracer import V3AnchorScene
from app.optical.db_scene_loader import load_anchor_scene_from_db
from app.optical.pose import dir_body_to_lab_t, point_body_to_lab_t
from app.schemas import CamelModel


router = APIRouter(prefix="/v3/anchors", tags=["v3-anchors"])


class LabVec(CamelModel):
    x: float
    y: float
    z: float


class TracedAnchorOut(CamelModel):
    object_id: str
    anchor_id: str
    # ``anchor.name ?? anchor.id`` — the port identity cables / links store.
    anchor_name: str
    # The slot's binding id as the trace reports it on every segment
    # (``bindingId``): the ComponentBinding's ``role``, else its UUID;
    # ``fiber_body`` for a synthesized fibre slot.
    binding_id: str
    pos_lab: LabVec
    axis_x_lab: LabVec
    axis_y_lab: LabVec
    # Clear-aperture RADIUS the hit test clips at, in mm; 0 = none declared.
    aperture_mm: float
    # True for an anchor no asset stores (derived AOM interaction_center,
    # synthesized fibre ports). A re-seated pigtail port is the device's own
    # anchor, so False, but its pose is the connector's.
    synthesized: bool


def traced_anchor_poses(scene: V3AnchorScene) -> list[TracedAnchorOut]:
    """Every anchor of every slot, placed through the slot's
    ``effective_transform`` — the transform the tracer hit-tests with."""
    out: list[TracedAnchorOut] = []
    for slot in scene.slots:
        t = slot.effective_transform
        for a in slot.asset.anchors:
            p = point_body_to_lab_t(a.position_body, t)
            x = dir_body_to_lab_t(a.axis_x_body, t)
            y = dir_body_to_lab_t(a.axis_y_body, t)
            out.append(TracedAnchorOut(
                object_id=slot.scene_object_id,
                anchor_id=a.id,
                anchor_name=a.name if a.name is not None else a.id,
                binding_id=slot.binding_id,
                pos_lab=LabVec(x=p.x, y=p.y, z=p.z),
                axis_x_lab=LabVec(x=x.x, y=x.y, z=x.z),
                axis_y_lab=LabVec(x=y.x, y=y.y, z=y.z),
                aperture_mm=a.aperture_mm,
                synthesized=a.synthesized,
            ))
    return out


@router.post("/traced", response_model=list[TracedAnchorOut])
async def anchors_traced(
    session: AsyncSession = Depends(get_session),
) -> list[TracedAnchorOut]:
    """The anchor poses the tracer sees (module docstring). Takes no body;
    poses do not depend on the scrub time, so the rest snapshot is loaded."""
    return traced_anchor_poses(await load_anchor_scene_from_db(session))
