"""RF cables and Programmable Pulse Generators — creating, re-snapping,
aligning and removing them, for every client.

This began (2026-09-22) as a port of the web app's browser-side flows
(``frontend/src/store/sceneStore.ts`` and the utils it called), so the
qmem-blender add-on would not grow a third copy. In wave 3b the web app was
pointed at ``POST /api/v3/rf-cables/*`` and ``POST /api/v3/ppg/*`` (routers
``app/routers/v3_rf_cables.py`` / ``v3_ppg.py``) and its TypeScript deleted,
so **this is now the only implementation**.

Layout:

* :mod:`.geometry` — the pure mating / alignment math.
* :mod:`.ppg_mount` — the PPG's mounted pose. ``utils/ppgMounting.ts`` still
  holds the web's copy, because the viewer re-derives the mount at render
  time (between pose commits) while this persists it.
* :mod:`.ports` — the scene slice, binding-tree anchor lookup, port domains,
  and the RF Link panel's port list / occupancy (``RfLinkPanel.tsx``).
* :mod:`.flows` — the flows as pure plans over a scene slice.
* :mod:`.service` — DB load, one transaction per request, ``/ws/scene``
  broadcasts.

``backend/tests/fixtures/rf_cables/`` are the golden fixtures the real
TypeScript wrote before it was deleted, asserted by
``backend/tests/optical/test_rf_cables_parity.py``: a change here must be a
deliberate fixture update, explained in the commit.
"""
