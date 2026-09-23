"""Fibre and pigtail endpoint flows — the ONLY implementation since
2026-09-23.

These began (2026-09-22) as backend ports of the web app's store actions
(``frontend/src/store/sceneStore.ts``) and the pure helpers under them
(``utils/fiberAlignment.ts``, ``utils/pigtailAlignment.ts``,
``utils/fiberAnchorResolver.ts``, ``utils/portConnectorPlacement.ts``). Wave
3b then pointed the web at ``POST /api/v3/fibers|pigtails/*`` and deleted
`fiberAlignment.ts` + `pigtailAlignment.ts`, so this is no longer a second
copy of anything: the web app and the qmem-blender add-on both call it, and a
change here changes what both clients do.

What the web still computes for itself, because neither is alignment: the
BEAM SEGMENTS it sends (only that client has a live trace), and the Object
panel's per-end port-pose editor, which writes an arbitrary pose the user
typed (``utils/fiberAnchorResolver.withFiberPortLabPose``).

The flows live here rather than in each client because the poses have to
satisfy the optics:

* :mod:`.geometry` — the patch-cable maths (spline endpoint <-> optical face,
  beam and port candidates, the linked-end re-derivation).
* :mod:`.pigtail` — the pigtail-connector maths (three.js ``Matrix4`` /
  ``Euler`` transcribed, like ``align/ts_compat``).
* :mod:`.scene` — the scene slice the flows read, and the scene-level lookups
  (effective fibre nodes, connector tip, the fibre-port sweep, pigtail port
  bindings).
* :mod:`.service` — the flows themselves (candidates / apply / disconnect /
  resnap), pure over an in-memory scene, recording what they write.

What the TypeScript answered, at arbitrary object rotations and binding
poses, is kept as FROZEN GOLDEN fixtures in ``backend/tests/fixtures/fibers/``
(written by the real TS while it existed; its generator went with it). A
failure in ``tests/optical/test_fiber_parity.py`` is a regression here, not
drift between two copies. Ports are placed through the tracer's chain (the
binding tree + the SceneObject pose, ``anchor_poses.resolve_anchor_poses_lab``)
— see ``docs/introduce/fiber.md``.
"""
