"""Backend ports of the frontend's align solvers (compute-only).

  mirror_coupling  <- frontend/src/utils/mirrorCoupling.ts
  point_dir        <- frontend/src/utils/isolatorAlign.ts
  aom_bragg        <- frontend/src/utils/aomAlign.ts
  anchor_poses     <- frontend/src/utils/anchorPose.ts (+ componentBindings.resolveBindingTree)
  service          <- the React call sites around them (MirrorCouplingPanel,
                      AlignToBeamControls), plus the DB load
  ts_compat/frames <- the three.js / JS primitives and SceneObject pose
                      conversions the above need, transcribed

Served by ``app/routers/v3_align.py`` (``POST /api/v3/align/...``). The TS and
Python copies are pinned to each other at 1e-9 by the golden fixtures in
``backend/tests/fixtures/align/``, which ``frontend/src/utils/__tests__/
alignParity.test.ts`` generates from the real TypeScript (and fails on when
they go stale); ``backend/tests/optical/test_align_parity.py`` checks this
package against them. A change to either copy must regenerate the fixtures
and keep both suites green. See ``docs/introduce/mirror-coupling.md``.
"""
