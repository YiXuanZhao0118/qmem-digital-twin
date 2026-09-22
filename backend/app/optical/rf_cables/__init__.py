"""RF cables and Programmable Pulse Generators, served to a second client.

The web app creates, re-snaps, aligns and removes coax cables and PPGs in the
browser (``frontend/src/store/sceneStore.ts`` and the utils it calls). The
qmem-blender add-on needs the same flows, and a third copy there would drift,
so they are ported here and served as ``POST /api/v3/rf-cables/*`` and
``POST /api/v3/ppg/*`` (routers ``app/routers/v3_rf_cables.py`` /
``v3_ppg.py``).

Layout:

* :mod:`.geometry` — the pure mating / alignment math
  (``utils/rfCableAnchorResolver.ts``, ``utils/rfCableAlignment.ts``,
  ``sceneStore.buildRfCableAlignmentProps``).
* :mod:`.ppg_mount` — ``utils/ppgMounting.computePpgMountedThreePose``.
* :mod:`.ports` — the scene slice, binding-tree anchor lookup, port domains,
  and the RF Link panel's port list / occupancy (``RfLinkPanel.tsx``).
* :mod:`.flows` — the store flows as pure plans over a scene slice.
* :mod:`.service` — DB load, one transaction per request, ``/ws/scene``
  broadcasts.

Parity with the TypeScript is pinned by golden fixtures the real TypeScript
generates (``frontend/src/utils/__tests__/rfCableParity.test.ts`` ->
``backend/tests/fixtures/rf_cables/``), asserted by
``backend/tests/optical/test_rf_cables_parity.py``. Change a port only
together with the TypeScript it mirrors.
"""
