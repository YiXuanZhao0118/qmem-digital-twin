"""Teardown for the RF endpoint benches (``test_rf_cables_endpoints.py``,
``test_rf_ports_binding_chain.py``), which run on a REAL database — the dev
one by default (``tests/conftest.py``) — and drive endpoints that CREATE
rows: ``POST /api/v3/rf-cables/connect`` and ``/api/v3/ppg/attach``.

Keyed by the LINK, not by the Component. An endpoint picks the first
matching catalog Component in scene order, and on the dev database that is
the catalog's own ``RF cable SMA`` / ``PPG BNC MALE``, not the bench's — so
a sweep of "SceneObjects on my Components" never saw what the endpoints
made. Between 2026-09-22 and 09-24 that left 69 dangling cables and 38 PPGs
(with their TimingPrograms) in the live scene, one batch per test run,
which the RF Link panel listed as unused. ``backend/scripts/purge_rf_orphans.py``
is the audit for that state.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import PhysicsElement, SceneObject, TimingProgram


async def purge_bench(db: AsyncSession, host_ids: Iterable[uuid.UUID]) -> list[uuid.UUID]:
    """Delete the bench's SceneObjects and everything an endpoint hung on
    them — every object whose ``rfCableEndpoints`` end or ``ppgAttachment``
    names a doomed object, to a fixpoint (the same closure as
    ``flows.plan_delete_objects``) — and those PPGs' TimingPrograms. Raw
    deletes: a ``locked`` row goes too (the endpoint test locks one cable per
    run), and the PhysicsElement / ObjectBinding / CollectionMember rows
    follow by FK. Does not commit. Returns the deleted object ids."""
    doomed = {str(i) for i in host_ids}
    rows = (await db.scalars(select(SceneObject))).all()
    grew = True
    while grew:
        grew = False
        for o in rows:
            if str(o.id) in doomed:
                continue
            props = o.properties or {}
            ends = props.get("rfCableEndpoints") or {}
            targets = [(ends.get(e) or {}).get("targetObjectId") for e in ("A", "B")]
            targets.append((props.get("ppgAttachment") or {}).get("targetObjectId"))
            if any(t in doomed for t in targets if t):
                doomed.add(str(o.id))
                grew = True
    ids = [uuid.UUID(i) for i in doomed]
    if not ids:
        return []
    pes = (await db.scalars(select(PhysicsElement).where(PhysicsElement.object_id.in_(ids)))).all()
    programs = [
        uuid.UUID(p.kind_params["timingProgramId"])
        for p in pes if (p.kind_params or {}).get("timingProgramId")
    ]
    await db.execute(delete(SceneObject).where(SceneObject.id.in_(ids)))
    if programs:
        await db.execute(delete(TimingProgram).where(TimingProgram.id.in_(programs)))
    return ids
