"""Fibre and pigtail endpoint flows — backend ports of the web app's store
actions (``frontend/src/store/sceneStore.ts``) and the pure helpers under them
(``utils/fiberAlignment.ts``, ``utils/fiberAnchorResolver.ts``,
``utils/pigtailAlignment.ts``, ``utils/portConnectorPlacement.ts``).

A second client (the qmem-blender add-on) plugs patch cables into
instruments and aligns pigtail ends too, and those poses must satisfy the
optics, so they are computed here rather than re-written in that client:

* :mod:`.geometry` — the patch-cable maths (spline endpoint <-> optical face,
  beam and port candidates, the linked-end re-derivation).
* :mod:`.pigtail` — the pigtail-connector maths (three.js ``Matrix4`` /
  ``Euler`` transcribed, like ``align/ts_compat``).
* :mod:`.scene` — the scene slice the flows read, and the scene-level lookups
  (effective fibre nodes, connector tip, the fibre-port sweep, pigtail port
  bindings).
* :mod:`.service` — the flows themselves (candidates / apply / disconnect /
  resnap), pure over an in-memory scene, recording what they write.

Parity with the TypeScript is pinned by golden fixtures the real TypeScript
writes (``frontend/src/utils/__tests__/fiberParity.test.ts`` ->
``backend/tests/fixtures/fibers/``), at arbitrary object rotations and
binding poses. Both copies place a port through the tracer's chain (the
binding tree + the SceneObject pose, ``anchor_poses.resolve_anchor_poses_lab``
here, ``anchorPose.resolveAnchorPosesLab`` there) — see
``docs/introduce/fiber.md``.
"""
