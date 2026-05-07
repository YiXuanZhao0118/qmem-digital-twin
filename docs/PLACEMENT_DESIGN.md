# Placement System — Master Design

**Status:** active rollout (started 2026-05-02)
**Owner doc:** this file. Cross-link from `vibe coding.md` log entries.
**Companion:** `PLACEMENT_PROGRESS.md` — running checklist.

This document is the single source of truth for the redesigned object-positioning
system in the QMEM digital-twin viewer. A fresh agent with no prior context
should be able to pick it up and continue. Every implementation step references
sections of this doc.

---

## 1. Mental model

> "Positions in optical engineering are almost never absolute lab coords. They
> are relative to a beam path, another component, or a symmetry axis. The user
> is dragging a real piece of glass into a real spot."

**Implications:**

- Lab-frame `(xMm, yMm, zMm)` is **the persisted output**, never the
  primary input. Direct numeric typing is the last-resort precision tweak.
- The primary input is **drag with snap intent**: while dragging, the system
  evaluates many candidate snaps and picks the most likely.
- Persistent constraints (the old assembly_relations) **fight the user**.
  We capture *intent metadata* (`placedRelativeTo`) instead — it doesn't
  enforce, it just remembers and is re-applicable on demand.

## 2. Architecture overview

```
                  ┌─────────────────────┐
                  │ User Intent (cursor │   "I'm dragging mirror_002.
                  │ pos, axis, modifier │    Pointer is at world (235,
                  │ keys, key strokes)  │    0, 882). Modifiers: snap on,
                  └──────────┬──────────┘    Shift not held."
                             ▼
       ┌─────────────────────────────────────────┐
       │      Smart Placement Engine              │
       │                                          │
       │  ① collectSnapTargets(scene, target)     │
       │  ② rankByOpticalRelevance(targets, intent)│
       │  ③ applyConstraints(rotation, locks)     │
       └──┬──────────────────────────────────────┘
          ▼
  ┌──────────────────┐
  │  PlacementResult │ → write to SceneObject (xMm…)
  │  • position       │ → also stamp
  │  • rotation       │   properties.placedRelativeTo
  │  • snappedTo[]    │   (intent metadata, NOT a constraint)
  │  • alternatives[] │
  │  • reasoning      │ → render snap visual feedback
  └──────────────────┘
```

The engine is a **pure function**. Every input source (gizmo drag, N-panel
typing, Shift+S cursor menu, multi-select align, "Place along beam") composes
its `intent` and routes through the same engine. No bypasses.

## 3. Data model

### 3.1 SnapTarget (engine input)

```typescript
type SnapTargetKind =
  | "beam_centerline"          // closest point on an OpticalLink line
  | "beam_along"               // sliding along a beam at user-specified mm
  | "beam_intersection"        // two beams crossing
  | "beam_endpoint"            // entry/exit of a link
  | "mesh_vertex"              // STL vertex world position
  | "mesh_edge_midpoint"
  | "mesh_face_centroid"
  | "mesh_bbox_center"
  | "anchor"                   // named asset anchor (+X face, etc.)
  | "cursor"                   // 3D cursor position
  | "world_origin"
  | "object_plane"             // align to another object's X/Y/Z plane
  | "grid";                    // snap to N-mm grid

type SnapTarget = {
  kind: SnapTargetKind;
  point: THREE.Vector3;        // world-space (three units)
  /** Direction associated with the target (beam forward, face normal, ...) */
  direction?: THREE.Vector3;
  /** Free-form payload for re-snap reconstruction */
  ref?: {
    objectId?: string;
    componentId?: string;
    linkId?: string;
    anchorId?: string;
    distanceMm?: number;
    // ...
  };
  /** Human-readable description ("vertex of bb1_e03", "10mm along laser→mirror"). */
  label: string;
  /** Distance from the dragged object's reference point in three units. */
  distanceThree: number;
};
```

### 3.2 PlacementResult (engine output)

```typescript
type PlacementResult = {
  /** The chosen world-space position for the dragged object's anchor (mesh
   * center, after Layer 1's auto-centering). */
  positionLab: { x: number; y: number; z: number };  // mm
  /** Optional rotation override (e.g., "Place along beam" aligns forward to
   * the beam direction). */
  rotationLab?: { rxDeg: number; ryDeg: number; rzDeg: number };
  /** The snap that won — used to render visual feedback + persist intent. */
  snappedTo: SnapTarget | null;
  /** Up to 3 alternative snaps the user can cycle to via Tab during drag. */
  alternatives: SnapTarget[];
  /** Why the engine picked this — for debugging + viewport readout. */
  reasoning: string;
  /** What to write into SceneObject.properties.placedRelativeTo. */
  intentMetadata: PlacedRelativeTo | null;
};
```

### 3.3 placedRelativeTo (intent metadata, persisted on SceneObject)

```typescript
type PlacedRelativeTo = {
  kind:
    | "beam_along"
    | "face_touch"
    | "anchor_match"
    | "vertex_snap"
    | "cursor"
    | "absolute";
  recordedAt: string;          // ISO8601
  // kind-specific payload — keep small + reproducible
  linkId?: string;
  distanceMm?: number;
  refObjectId?: string;
  refAnchorId?: string;
  axisLockedToBeam?: boolean;
};
```

Stored under `SceneObject.properties.placedRelativeTo`. **Never enforced
by the backend.** Only consumed by the frontend "Re-snap" button.

### 3.4 Engine signature

```typescript
function computePlacement(input: {
  scene: SceneSnapshot;          // light snapshot, not full SceneData
  target: { id: string; componentId: string; currentLab: LabPose };
  intent: {
    candidatePosLab: LabPoint;   // where the user is "trying to go"
    candidateRotLab?: LabRotation;
    forwardLab?: LabVec3;        // optional: target's forward direction
    snapEnabled: boolean;
    snapCategories: SnapCategory[];
    axisLock?: "x" | "y" | "z" | null;
    referenceObjectId?: string;  // for "drag relative to this"
  };
  config: {
    thresholdsMm: Record<SnapTargetKind, number>;
    gridStepMm: number;
  };
  componentGroup: THREE.Group;   // for raycast / mesh queries
}): PlacementResult;
```

## 4. The 7 layers

| Layer | Responsibility | Primary file(s) |
|---|---|---|
| **L0** | Smart Placement Engine (pure) | `three/placement/engine.ts`, `snapTargets.ts` |
| **L1** | Direct gizmo + orientation toggle (Global / Local / Beam) | `three/placement/gizmo.ts`, `DigitalTwinViewer.tsx` |
| **L2** | Snap visual feedback + Tab cycle | `three/placement/snapOverlay.ts` + `DigitalTwinViewer.tsx` |
| **L3** | 3D Cursor extensions (Shift+S menu, "Cursor → Beam point") | `components/optical/CursorMenu.tsx` |
| **L4** | Optical-specific tools (Place along beam, Insert into beam path) | `components/optical/PlaceAlongBeamTool.tsx` |
| **L5** | Multi-select Align panel | `components/AlignPanel.tsx` |
| **L6** | `placedRelativeTo` metadata + Re-snap button | `store/sceneStore.ts` + ComponentPanel |
| **L7** | Expression-driven number fields (`+50`, `*2`, `mid(A,B)`) | `utils/exprInput.ts` + reusable `<NumberField>` |

## 5. Files to create / modify

### Create

- `frontend/src/three/placement/engine.ts` — main engine + types
- `frontend/src/three/placement/snapTargets.ts` — per-kind collector
- `frontend/src/three/placement/snapOverlay.ts` — viewport overlay rendering
- `frontend/src/three/placement/gizmo.ts` — TransformControls wrapper +
  orientation switching + drag-state machine
- `frontend/src/components/optical/CursorMenu.tsx` — Shift+S popover
- `frontend/src/components/optical/PlaceAlongBeamTool.tsx` — "Place along beam"
  panel UI
- `frontend/src/components/AlignPanel.tsx` — multi-select align
- `frontend/src/utils/exprInput.ts` — `parseExpression(text, ctx) → number`
- `frontend/src/components/NumberField.tsx` — reusable expression-aware input
- `qmem-digital-twin/docs/PLACEMENT_PROGRESS.md` — running checklist

### Modify

- `frontend/src/components/DigitalTwinViewer.tsx` — wire gizmo + overlay +
  drag handlers through engine
- `frontend/src/components/ComponentPanel.tsx` — N-panel uses NumberField,
  add "Re-snap" button next to Object pos/rot block, add Align panel mount
- `frontend/src/store/sceneStore.ts` — add `placement` slice
  (snap settings, cursor position is already there as `transformCursorMm`,
  add `gizmoOrientation: 'global'|'local'|'beam'`,
  `lastPlacementResult` for overlay rendering)
- `frontend/src/types/digitalTwin.ts` — add `PlacedRelativeTo` type to
  SceneObject's properties shape
- `frontend/src/components/SceneToolbar.tsx` — replace single magnet button
  with "Snap categories" popover; add gizmo orientation toggle
- `frontend/src/components/workspace/WorkspaceProvider.tsx` — register
  `align` and `place-along-beam` panels

### Backend changes — minimal

The backend doesn't need to know about placement intent. `placedRelativeTo`
is a JSON property on SceneObject — the existing JSON column accepts it.
Everything is frontend.

(One small backend change is OK: add `properties.placedRelativeTo` to the
SceneObject Pydantic schema as a typed nested model so the API surface
documents it. Not required.)

## 6. Snap relevance ranking

Ranking inside `engine.rankByOpticalRelevance`:

1. If target has an OpticalElement and is within `beamSnapThresholdMm` of any
   beam: **beam snaps win** (highest priority).
2. Otherwise within `meshThresholdMm` of any vertex/face/anchor: geometry
   snaps win.
3. Otherwise within `cursorThresholdMm` of cursor: cursor.
4. Otherwise grid snap if enabled.
5. Otherwise free position (no snap, raw pointer position).

Ties broken by:
- Smaller distance.
- More specific target kind (anchor > face_centroid > bbox_center > vertex).

## 7. Visual feedback contract

During a placement drag, the engine writes `lastPlacementResult` to the
store. `SnapOverlay` (a sibling to the existing `beamGroup`) renders:

- **Snap line**: dashed line from dragged object's mesh-center to the chosen
  `snappedTo.point`. Colour by snap kind:
  - `beam_*` → wavelength colour of the beam
  - `mesh_*` → white
  - `anchor` → cyan
  - `cursor` → red
  - `grid` → grey
- **Snap target dot**: 12 px filled circle at `snappedTo.point`
- **Reasoning readout**: bottom-left HTML overlay
  `snapped: vertex of bb1_e03 (Δ 8.3 mm)   [Tab: 2 alternatives]`

Cleared on drag end (or after 1 s if no follow-up).

## 8. Implementation order (**dependency-driven, not effort**)

> **Each step ends with the change committed and `tsc --noEmit` clean.**
> Each step is independently runnable in browser.

### Step 1 — Engine skeleton (L0a)

Files: `engine.ts` (types + `computePlacement` stub that just returns
absolute position, no snapping), `snapTargets.ts` (empty collector list).

Acceptance: TypeScript types compile. Engine exported. Existing viewer
behaviour unchanged.

### Step 2 — Snap target collectors (L0b)

For each `SnapTargetKind`:
- `collectBeamSnaps(scene)`
- `collectMeshSnaps(componentGroup)` (vertex / edge / face / bbox)
- `collectAnchorSnaps(scene)` — read `Asset3D.anchors`
- `collectCursorSnap(state)` / `collectWorldOriginSnap()`
- `collectGridSnap(candidatePos, gridStepMm)`

Then implement `rankByOpticalRelevance`. Engine now actually snaps.

Acceptance: unit-test (or eval-test in playwright) that engine returns
expected snaps for known scene fixtures.

### Step 3 — Gizmo + orientation toggle (L1)

Add `THREE.TransformControls` (already in three/examples). Wrap it in a
`gizmo.ts` module that:
- Attaches/detaches as selection changes
- Listens to `dragging-changed`, disables OrbitControls during drag
- On `objectChange` event: reads gizmo's world position, runs
  `computePlacement`, writes back the snapped position to the gizmo (so the
  visible drag follows the snap)
- On end: writes to `updateSceneObject` with full intent metadata

Toolbar dropdown: Global / Local / Beam orientation. Beam mode auto-selects
when an OpticalElement is selected.

Acceptance: drag a mirror in the viewer, see snapping work; intent metadata
appears on the SceneObject.

### Step 4 — Snap visual feedback (L2)

Implement `snapOverlay.ts`. Render dashed line + dot + DOM readout. Wire
Tab key in the gizmo drag handler to cycle alternatives.

Acceptance: drag, see clear visual indication of what's being snapped.

### Step 5 — Cursor extensions (L3)

`Shift+S` popover. New cursor commands:
- `Cursor → Beam point` (click any beam segment in viewer first, then Shift+S → command)
- `Cursor → Beam @ N mm from start`
- `Cursor → Intersection`
- `Selection → Cursor / → Active / → Beam`

Acceptance: workflow "click a beam, Shift+S, Cursor→Beam point, drop a new
component there" works.

### Step 6 — placedRelativeTo + Re-snap (L6)

- ComponentPanel: under Object position/rotation, show
  `Placed by: <human readable>` + `[Re-snap]` button.
- Re-snap reads `placedRelativeTo`, reruns the engine with same intent,
  writes the new pose. Useful when upstream beam moves.

Acceptance: place a lens 200mm along a laser beam; move the laser; press
Re-snap; lens is now 200mm along the new beam position.

### Step 7 — Optical-specific tools (L4)

`PlaceAlongBeamTool.tsx`:
- Toolbar button "Place along beam"
- Workflow: select an element → click a beam segment → small popup
  "Distance from start: [____] mm" → Enter → element moved + forward axis
  aligned to beam + (optional checkbox) "Insert into beam path" creates the
  link surgery.

`Insert into beam path`:
- Take the OpticalLink the user dropped onto. Split it: source → element
  becomes the new "first half" (with computed `freeSpaceMm`); element →
  original target becomes the new "second half".
- All in one transaction (frontend orchestrates two `createOpticalLink` +
  one `deleteOpticalLink`).

Acceptance: drop a lens onto a laser→mirror beam → it's now sandwiched, two
links cover the path, Run Solver still works.

### Step 8 — Multi-select Align (L5)

`AlignPanel.tsx`. Show only when ≥ 2 objects selected. Compute
median/min/max/active/cursor along chosen axis, batch update.

Acceptance: select 4 mirrors, align Y to median → all four end up at the
same Y.

### Step 9 — Expression number fields (L7)

`utils/exprInput.ts` parses `200`, `+50`, `*2`, `@200`, `mid(A, B)`.
`<NumberField>` component wraps `<input type="number">`, parses on Enter.
Migrate ComponentPanel's position/rotation inputs to use it.

Acceptance: type `+50` in X field → object moves +50mm along X. `mid(A,B)`
moves to the median position of two specified objects.

## 9. What dies / changes

| Old | New |
|---|---|
| `apply_relations_for_object` auto-enforcement (already gone) | — |
| "Apply & consume" relation button | Replaced by Layer 4 + Layer 6 Re-snap |
| Single magnet beam-snap toggle | Multi-target snap popover (Layer 2) |
| Plain numeric inputs in ComponentPanel | `<NumberField>` with expressions |
| Drag-only positioning via panel typing | Drag via gizmo, panel for precision |

The persistent `assembly_relations` table stays in the DB (for old data) but
is no longer the recommended workflow. Existing rows are still apply-once-able
through the existing UI; we won't actively migrate them.

## 10. Testing strategy

- **Engine pure-function tests**: ideal but no test runner currently in the
  frontend. Use `playwright` ad-hoc evals against a known scene fixture for
  now. Consider adding `vitest` as a follow-up.
- **Visual regression**: take playwright screenshots after each step,
  compare key elements via DOM eval.
- **No backend tests** are needed for this work — backend is unchanged.

## 11. Open questions / deferred

- **Vitest setup** — would let the engine be properly unit-tested. Defer to
  a follow-up after the layers ship.
- **Undo/redo** — placement actions should be undoable. Current store has
  no undo machinery. Defer; users currently `git revert` via reading the
  log if needed.
- **Constraint relations as different layer** — if we ever genuinely need
  rigid kinematic linkages (post-mounted optics that should follow the post),
  add a `Constraint` table separate from `AssemblyRelation` rather than
  reviving relation auto-enforcement.

---

## Append-only changelog

- **2026-05-02 10:55** — doc created. Step 1 starting.
- **2026-05-02 11:00** — Step 1 (L0a) done: `engine.ts` + `snapTargets.ts`
  scaffolded with full type set + stub collectors. tsc clean. Step 2 starting.
- **2026-05-02 11:55** — All 9 steps complete:
  - L0a engine, L0b collectors (beam/mesh/anchor/cursor/grid + ranking)
  - L1 PlacementGizmo (TransformControls wrapper, Global/Local/Beam orientation, mode toggle)
  - L2 SnapOverlay (dashed line + sprite dot + bottom-left HTML readout)
  - L3 CursorMenu (Shift+S — Selection→Cursor/Active, Cursor→origin/active/selected median/beam point)
  - L4 PlaceAlongBeamPanel (toolbar wand button → distance + insert-into-path checkbox)
  - L5 AlignPanel (axis radios + target select + distribute evenly)
  - L6 PlacedRelativeToReadout (intent metadata stamped per drag, Re-snap for beam_along)
  - L7 NumberField + exprInput parser (+50, *2, @200, mid(A,B))
  - tsc clean throughout. Browser verified at each step.
