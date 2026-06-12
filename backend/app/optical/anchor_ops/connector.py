"""Cable-connector pass-through ops (connector refactor plan, 2026-06-12).

The fibre / RF cable connectors (kinds ``fiber_connector`` /
``rf_cable_connector``) are catalog assets that terminate a cable end.
They do NOT independently participate in the trace — the cable-body op
reads their physics (MFD / NA / polish / family / gender …) from the two
end-connector params at the spline endpoints.

But a connector Asset3D can be hit standalone (e.g. dropped on the table
on its own, or while authoring). The anchor tracer treats a kind with no
registered op as a *terminal sink* (absorbs the beam, power → 0). That is
wrong for a connector — geometrically it's an open junction. So we
register a pass-through op under both connector kind names: the beam
exits unchanged, the same way ``faraday_anchor_op`` passes through any
anchor that isn't the rod centre.
"""

from __future__ import annotations

from app.optical.anchor_tracer import AnchorOpContext, register_anchor_op
from app.optical.beam_ray import BeamRay


def connector_passthrough_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    """Connector is a geometric junction — pass the beam straight through."""
    return [ray_in]


register_anchor_op("fiber_connector", connector_passthrough_op)
register_anchor_op("rf_cable_connector", connector_passthrough_op)
