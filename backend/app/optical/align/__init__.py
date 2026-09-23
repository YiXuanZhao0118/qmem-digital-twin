"""The align solvers (compute-only) - the only copy of them.

They began as frontend TypeScript and were ported here on 2026-09-22; on
2026-09-23 the web app was rewired onto these endpoints and the TypeScript was
deleted, so this package is what the web app AND the qmem-blender add-on run.

  mirror_coupling  <- was frontend/src/utils/mirrorCoupling.ts
  point_dir        <- was frontend/src/utils/isolatorAlign.ts
  aom_bragg        <- was frontend/src/utils/aomAlign.ts
  anchor_poses     <- twin of frontend/src/utils/anchorPose.ts, which STAYS on
                      the web side (the store, the RF cable resolver and the
                      align panels' own picking all read anchor poses with it)
                      (+ componentBindings.resolveBindingTree)
  service          <- what the React call sites did around them
                      (MirrorCouplingPanel, AlignToBeamControls), plus the DB
                      load
  ts_compat/frames <- the three.js / JS primitives and SceneObject pose
                      conversions the above need, transcribed

Served by ``app/routers/v3_align.py`` (``POST /api/v3/align/...``); the web app
calls them through ``frontend/src/api/align.ts``.

``backend/tests/fixtures/align/*.json`` are the FROZEN record of what the
deleted TypeScript answered - ``frontend/src/utils/__tests__/
alignParity.test.ts`` wrote them by running it, and went with it.
``backend/tests/optical/test_align_parity.py`` still asserts this package
reproduces all 415 cases at 1e-9, so they are now a ONE-WAY regression pin:
nothing regenerates them, and a deliberate behaviour change has to re-record
the affected entries by hand and say so. ``test_align_endpoints.py`` covers
the HTTP contract the web app depends on. See
``docs/introduce/mirror-coupling.md``.
"""
