[← Doc index](README.md)

# Placement & snapping

> Coordinate frames and anchors are in [anchors.md](anchors.md); beam sources in [optics.md](optics.md). The engine lives in `frontend/src/three/placement/` (`engine.ts` / `snapTargets.ts` / `gizmo.ts` / `snapOverlay.ts`).

## Mental model

Optical position is relative (to the beam, to a component, to a symmetry axis), not absolute. The Lab pose is a **persisted output**, not the primary input; the primary input is "a drag carrying snap intent". Rather than assembly_relations that fight the user, we record **intent metadata** (`placedRelativeTo` — remembered, not enforced). Every input source (gizmo drags, numeric entry in the N panel, the Shift+S cursor menu, multi-select alignment, place-along-beam) assembles the same `PlacementIntent` and goes through the same pure-function engine, **with no bypass**.

## The engine pipeline (`computePlacement(input) → PlacementResult`)

A pure function (`engine.ts`), in order:

1. **Axis lock** (`applyAxisLock`): when the user locks a single axis (gizmo / G+X), the candidate position applies only on that axis and the other two revert to the object's current pose.
2. **Early out**: snapping off, or no snap category enabled → land on the candidate point with `intentMetadata.kind = "absolute"`.
3. **Collect SnapTargets**: call the matching collector for each **enabled** category (beam / geometry / anchor / reference / grid, see the table below). The geometry category needs `componentGroup` (the three.js mesh group) to do anything; the reference category currently collects the cursor and the world origin.
4. **Threshold filtering**: each candidate compares its `distanceMm` against a threshold — per-kind override > per-category override (one slider per category in the smart popover) > `DEFAULT_THRESHOLDS_MM`. If everything is out of range → land on the candidate point, `absolute`.
5. **Ranking** (`rankByOpticalRelevance`): the smallest tier is best, ties broken by distance. Returns `snappedTo` = best, `alternatives` = up to 3 runners-up (the UI cycles them with Tab), a `reasoning` string, and `intentMetadata`.

A `PlacementResult` always carries non-empty `intentMetadata` (at minimum `absolute`), which is written into `SceneObject.properties.placedRelativeTo`.

## SnapTarget kinds (13 defined in the type, **12 actually collected**, in 5 categories)

| kind | Category | Default threshold (mm) | Description |
|---|---|---|---|
| `beam_centerline` | beam | 25 | Snap to the nearest point on the beam centreline |
| `beam_along` | beam | 25 | @N mm along an explicitly picked beam (Layer 4; highest priority) |
| `beam_intersection` | beam | 15 | The intersection of two beams |
| `beam_endpoint` | beam | 15 | A beam endpoint (source / hit) |
| `mesh_vertex` | geometry | 10 | A mesh vertex |
| `mesh_edge_midpoint` | geometry | 10 | An edge midpoint (⚠️ the type and tier are defined, but `collectMeshEdgeMidpointSnaps` is **never called by `computePlacement` → currently dead, never collected**) |
| `mesh_face_centroid` | geometry | 15 | A face centroid |
| `mesh_bbox_center` | geometry | 20 | A bounding-box centre |
| `anchor` | anchor | 5 | A component anchor (the most specific, so the tightest threshold) |
| `cursor` | reference | 30 | The 3D cursor (Shift+S) |
| `world_origin` | reference | 30 | The world origin |
| `object_plane` | reference | 5 | An object plane (defined, reserved) |
| `grid` | grid | 1 | Grid points (a fall-through; the threshold is effectively unused) |

Each SnapTarget carries `pointLab` (where it lands), an optional `directionLab` (beam heading / normal / anchor outward, which Layer 4 uses to align the dragged object's forward axis), `ref` (so a Re-snap can rebuild it), `label` and `distanceMm`.

## Ranking priority (`rankByOpticalRelevance` tiers, lower wins)

`beam_along`(0) > beam_centerline / endpoint / intersection (**→1 when the target is an optical part, otherwise →4**) > `anchor`(2) > `mesh_face_centroid`(3) > `mesh_bbox_center`(3.2) > `mesh_vertex`(3.4) > `mesh_edge_midpoint`(3.6) > `object_plane`(5) > `cursor`(5.2) > `world_origin`(5.4) > `grid`(9). Within a tier, the smaller `distanceMm` wins.

→ The intuition: a beam the user explicitly picked comes first; for an optical part "snap to the beam" beats "snap to mesh geometry", but for a non-optical part (a mechanical mount, say) beams drop far down the list. `anchor` always beats a generic mesh point.

## Intent metadata (`placedRelativeTo`)

The snap result maps into persisted intent (`snapTargetToMetadata`), which a later Re-snap can replay:

| SnapTarget kind | `placedRelativeTo.kind` | Recorded |
|---|---|---|
| `beam_along` | `beam_along` | `linkId` + `distanceMm` |
| beam_centerline / endpoint / intersection | `beam_centerline` | `linkId` |
| `anchor` | `anchor_match` | `refObjectId` + `refAnchorId` |
| mesh_vertex / edge_midpoint | `vertex_snap` | `refObjectId` |
| `mesh_face_centroid` | `face_touch` | `refObjectId` |
| `cursor` | `cursor` | — |
| bbox_center / world_origin / object_plane / grid | `absolute` | — |

`describePlacement()` turns it into human-readable text (e.g. "12 mm along beam ab12cd34", "anchor-matched to …").

## The 7 layers (L0–L7)

- **L0** the pure engine (`computePlacement`, above).
- **L1** the gizmo (Global / Local / Beam orientation, TransformControls).
- **L2** snap visual feedback + Tab-cycling of alternatives.
- **L3** the 3D cursor (the Shift+S menu; state `transformCursorMm`). The cursor **is** the viewer's orbit centre, and since 2026-08-19 the coupling runs both ways: a settled rotate / pan / zoom writes `controls.target` back into it (`syncCursorToViewCenter`, `DigitalTwinViewer.tsx`), so the cursor always means "the middle of what I'm looking at"; an explicit set (Shift+S, snap commands, the Cursor (mm) field) still pulls the view onto it. Its marker therefore defaults to **hidden** (`loadTransformCursorHidden`, storage key `qmem.transformCursorHidden.v2`); the crosshair switch in `.viewer-toolbar` is the single control for the whole feature — it shows the marker *and* mounts the Cursor (mm) editor. The custom-Home buttons (Set Home / clear) ride in that same strip. The axis-gizmo X/Y/Z/-X/-Y/-Z buttons orbit around the *current* `controls.target`; only **H** (factory framing) is absolute (`HOME_CAMERA_POSITION`/`HOME_CAMERA_TARGET`), unless a custom Home pose is saved.
- **L4** optical tools (Place / Insert along beam; the last-clicked beam point `scopeProbe`).
- **L5** multi-select Align.
- **L6** `placedRelativeTo` + Re-snap.
- **L7** expression number fields (`+50` / `*2` / `@200` / `mid(A,B)`, `exprInput.ts` / `NumberField.tsx`).

### The rotation magnet (rotate mode only)

The position snap engine above never sees rotation. Rotate-mode drags instead go through a small magnet in the gizmo itself, `magnetizeRotationDelta` (`frontend/src/three/placement/gizmo.ts:51`, pure + unit-tested in `three/placement/__tests__/rotationMagnet.test.ts`), called from `runEngineFromGizmoPose` before the rigid delta is applied to any wrapper.

- **Sticky points**: every multiple of `ROTATION_MAGNET_STEP_DEG = 45` (0 / 45 / 90 / 135 / …), with a `ROTATION_MAGNET_TOLERANCE_DEG = 5` window on each side. Inside the window the committed angle is *exactly* the multiple; outside it rotation stays free, so the magnet costs no precision away from the sticky points.
- **What is magnetized**: the *stored* Euler triple (`rxDeg` / `ryDeg` / `rzDeg` of the primary object), not the drag delta — so the magnet lands on the numbers shown in the Object panel regardless of gizmo space (global / local / beam) or the object's starting pose.
- **Invariant — untouched axes are never disturbed**: a component whose Euler value moved by less than `ROTATION_MAGNET_MOVED_EPS_DEG = 1e-6` during the drag is passed through unchanged. Without this, turning one ring would yank a hand-tuned 43° on another axis to 45°, silently destroying an alignment.
- **Invariant — the delta stays rigid**: the magnet returns a corrected *delta* quaternion (derived from the primary), which every selected wrapper then rides. Multi-select rotation therefore keeps its relative poses. The proxy quaternion is rewritten to match, so the gizmo ring does not drift away from the objects.
- **Bypass**: hold **Shift** during the drag (`freeRotate`, tracked on document `keydown`/`keyup`). Translate and scale modes are untouched.

## Multi-object changes: write everything first, *then* compute optics / RF

**Iron rule: any change that touches the pose of more than one SceneObject must go through `sceneStore.updateSceneObjects` (`store/sceneStore.ts:3250`) as a single commit — never loop over `updateSceneObject`.**

Why: the optical trace and RF are **scene-driven** — `DigitalTwinViewer`'s debounced effect (`components/DigitalTwinViewer.tsx:1553`, 150 ms, dedup key = `sceneData` identity) re-runs `/api/v3/solver/run-from-db` whenever `scene.objects` changes identity, and the RF schedule is rebuilt inside the same effect. Every `updateSceneObject` call is its own `set()` → a full scene rebuild, a cable re-snap and one undo entry; moving 13 objects together means 13 of each, which is exactly where "dragging a multi-selection is so laggy" came from. The batched version fires all the PATCHes concurrently and **commits only once at the end**, so the recompute runs once, on the settled scene.

The contract of `updateSceneObjects` (pinned by the tests in `store/__tests__/updateSceneObjects.test.ts`):

- N objects → **1 store commit**, **1 undo entry** (described as `Update N objects`), 1 `resnapRfCablesLinkedTo`.
- Locked objects are dropped before any network call (the same contract as the single-object path); duplicate `objectId`s are last-write-wins.
- **Rigid groups expand within the batch**: every explicitly given entry that carries a pose runs its own `expandPoseToRigidGroup` (`utils/rigidGroup.ts:227`); when a derived patch collides with an object the caller patched explicitly, **the explicit patch wins** (a multi-select drag already moves each member itself). When a leading object is rejected because its group contains a locked member, only that one entry is dropped and the rest of the selection still moves.

The entry points currently on the batch path: multi-select gizmo drags (`onDragEnd` in `DigitalTwinViewer.tsx`, primary + followers merged into one call), the Object panel's Group delta fields (`ComponentPanel.MultiSelectTransformPanel`), Align / Distribute (`AlignPanel.tsx`), and the Shift+S cursor menu's Selection→Cursor / →Active (`optical/CursorMenu.tsx`).

### The three leaks that made work double back (all plugged)

Batching the *writes* alone was not enough — measured on 13 objects moved together, it still took **22 commits** at first, and converging to **2** (1 move + 1 cable write-back) took all three of these:

1. **Batched writes** — `updateSceneObjects`, as above.
2. **Batched WebSocket echo + self-echo discard** (`sceneStore.applyEvents` + `WS_FLUSH_MS = 16` buffering in `App.tsx`). Every write is broadcast back by the backend, so 13 PUTs mean 13 `object.updated` events, each committing separately. App now gathers the messages that arrive within a frame into one batch for `applyEvents` (`reduceSceneEvent` folds them event by event, setting state once), and `object.updated` additionally passes two self-echo gates:
   - **The in-flight gate** (`inFlightObjectWrites`): drop broadcasts for an object while our own PATCH is still outstanding — the backend **broadcasts at commit time, before the HTTP response arrives**, so during a batch the echoes of the first few writes land before we have stored the responses and `updatedAt` cannot yet tell them apart. Only the "commit our own response" path registers here; **undo / redo deliberately do not register**, because they call `updateObjectApi` without `set()` and rely on the broadcast to update the store (keep that property if you touch this).
   - **The `updatedAt` gate**: if the store already holds that version, return `state` untouched (without swapping the array). The backend stamps a microsecond-resolution `updatedAt` on every write, so a genuine remote edit always bumps it.
3. **Batched cable write-back** (`resnapRfCablesLinkedTo`): this used to be one PATCH + commit per cable per endpoint (3 cables = 6). It now uses the pure function `buildRfCableAlignmentProps` to fold End A and End B into one properties payload, followed by a single `updateSceneObjects(..., { recordHistory: false })` — `recordHistory: false` because it is a **derived** write, and the move that triggered it already recorded an undo entry.

Measured verification (Lab tab, 13 objects, including 3 rf_cables): commits 22 → 2, `/api/v3/solver/run-from-db` twice per move, and undo went from 13 entries to 1 that restores everything at once.

## Known limitations

- The backend is essentially untouched (`placedRelativeTo` is just JSON on `SceneObject.properties`).
- Re-snap currently supports only `beam_along`.
- Large STLs (>5k vertices, e.g. the 14k BB1-E03) need subsampling for mesh snapping.
