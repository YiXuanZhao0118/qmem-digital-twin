# Placement system rollout — progress checklist

Read `PLACEMENT_DESIGN.md` first for architecture. This file is a running
checklist a fresh agent can use to pick up the work cold.

## State at a glance

| Step | Layer | Status | Notes |
|------|-------|--------|-------|
| 1 | L0a Engine skeleton | ✅ done | engine.ts + snapTargets.ts created, tsc clean |
| 2 | L0b Snap target collectors + ranking | ✅ done | beam/mesh/anchor/cursor/grid all implemented; verified via eval (candidate (100,5,882) snapped to beam_centerline at (100,0,882) with linkId metadata) |
| 3 | L1 Gizmo + orientation toggle | ✅ done | TransformControls wrapper attaches on selection, drag → engine → write back. Toolbar has Move/Rotate, Global/Local/Beam select, Snap popover. Verified in browser: gizmo arrows visible on selected mirror. |
| 4 | L2 Snap visual feedback + Tab cycle | ✅ done | snapOverlay.ts (THREE.LineDashedMaterial + Sprite dot, colour-coded by snap kind), SnapReadout HTML overlay at bottom-left, Tab cycle handled in PlacementGizmo |
| 5 | L3 Cursor extensions | ✅ done | CursorMenu.tsx — Shift+S popover with Selection→Cursor/Active, Cursor→World origin/Active/Selected median/Beam point |
| 6 | L6 placedRelativeTo + Re-snap | ✅ done | PlacedRelativeToReadout sub-component in ComponentPanel; Re-snap currently supported for beam_along (others greyed out, payload incomplete) |
| 7 | L4 Optical-specific tools | ✅ done | PlaceAlongBeamPanel.tsx — opens via toolbar wand button + window event; if "Insert into path" checked, splices link into upstream + downstream |
| 8 | L5 Multi-select Align | ✅ done | AlignPanel.tsx — appears in Object panel when ≥ 2 selected; axis radios + target select (median/min/max/active/cursor) + Distribute evenly |
| 9 | L7 Expression number fields | ✅ done | exprInput.ts (parser: `200`, `+50`, `-50`, `*2`, `/2`, `@200`, `mid(A,B)`); NumberField.tsx (commit on Enter/blur, invalid → red border); wired into Object position grid in ComponentPanel |

Symbol legend: `⏳` not started, `🔧` in progress, `✅` done, `⚠` blocked.

## Per-step prep notes

### Step 1 — Engine skeleton
- [ ] Create `frontend/src/three/placement/engine.ts` with full type set
  (`SnapTarget`, `SnapTargetKind`, `PlacementResult`, `PlacedRelativeTo`,
  `computePlacement`).
- [ ] Engine returns `{ positionLab: candidatePosLab, snappedTo: null,
  alternatives: [], reasoning: 'no snap', intentMetadata: { kind: "absolute",
  recordedAt: ... } }` initially.
- [ ] `frontend/src/three/placement/snapTargets.ts` — empty stubs
  `collectBeamSnaps`, `collectMeshSnaps`, etc., returning `[]`.
- [ ] `tsc --noEmit` clean.

### Step 2 — Snap target collectors
- [ ] `collectBeamSnaps`: walk `scene.opticalLinks`, for each link compute
  closest point on segment to candidate position. Reuse the math from
  `utils/beamSnap.ts` — copy/move it into the new module.
- [ ] `collectMeshSnaps`: traverse `componentGroup`. For each mesh:
  - Vertex: use `geometry.attributes.position` (subsample if > 5k verts —
    nearest-point on a 14k-vertex BB1-E03 STL is too slow per frame; use a
    KD-tree from `three/addons/utils/BufferGeometryUtils` if needed, or
    pre-compute bbox 8 corners + face centroids).
  - Face centroid: iterate `geometry.index` triangles, average the three
    vertex positions.
  - bbox center / corners: from `geometry.boundingBox`.
- [ ] `collectAnchorSnaps`: read `Asset3D.anchors` (existing schema), apply
  the SceneObject's pose to convert to world.
- [ ] `collectGridSnap`: round `candidatePosLab` to nearest multiple of
  `gridStepMm`.
- [ ] Implement `rankByOpticalRelevance` per Section 6 of the design doc.
- [ ] Verify with playwright eval: known scene → known snap result.

### Step 3 — Gizmo + orientation toggle
- [ ] Import `TransformControls` from `three/addons/controls/TransformControls.js`.
- [ ] In `DigitalTwinViewer.tsx`, when an object is selected, attach
  TransformControls to the SceneObject's wrapper Group.
- [ ] On `dragging-changed` event, toggle `controlsRef.current.enabled`.
- [ ] On `objectChange` event:
  1. Read gizmo's current world position.
  2. Convert to lab.
  3. Compute placement via engine.
  4. Set the gizmo back to the snapped position so the user sees the snap.
  5. Throttle backend write to ~30 fps via `requestAnimationFrame` or a
     30 ms debounce — only the FINAL position needs to hit the backend.
- [ ] On end-of-drag: write final `updateSceneObject` with
  `properties.placedRelativeTo` from the result.
- [ ] Toolbar dropdown: Global / Local / Beam. Beam mode reads the
  selected component's nearest beam and constructs a custom local frame
  for the gizmo via `setSpace('local')` + a wrapper rotation.
- [ ] Auto-pick Beam mode when a selected component has an OpticalElement.

### Step 4 — Snap visual feedback + Tab cycle
- [ ] New Three.Group `placementOverlayGroupRef` next to `beamGroupRef`.
- [ ] On `lastPlacementResult` change, render a dashed `THREE.Line` from
  dragged object center to `snappedTo.point`. Colour by kind (see Section 7).
- [ ] Render a 12 px circle at the snap point (use `THREE.Sprite` with a
  procedurally generated canvas texture).
- [ ] HTML overlay (sibling to `<canvas>`) with the reasoning string.
- [ ] Listen to `Tab` key during drag; cycle through `alternatives[]`,
  feed each back through engine. Visual updates accordingly.
- [ ] Clear overlay after 1 s of no movement.

### Step 5 — Cursor extensions
- [ ] `Shift+S` global hotkey in `DigitalTwinViewer.tsx` opens a popover
  positioned at pointer.
- [ ] Commands:
  - `Selection → Cursor` — write each selected object's position to cursor.
  - `Selection → Active` — alignment to active object's position.
  - `Selection → Beam` — engine call with snap force-restricted to
    beam_centerline.
  - `Cursor → Selected / → Active / → World origin / → Beam point /
    → Beam @ N mm / → Intersection`.
- [ ] Cursor → Beam point: needs the user to have clicked a beam first
  (last beam click world position is already stored as `scopeProbe`).
- [ ] All cursor commands write through `setTransformCursorMm`.

### Step 6 — placedRelativeTo + Re-snap
- [ ] Engine already produces `intentMetadata` (Step 1). Just wire it
  through to `updateSceneObject` payload.
- [ ] ComponentPanel: under the Object position section, render
  ```
  Placed by: 200 mm along laser→mirror beam   [Re-snap]
  ```
  - Read `properties.placedRelativeTo`, format human-readable string.
  - On Re-snap click, reconstruct intent from metadata, run engine, write
    back the new pose.
- [ ] Disable button if `refObjectId` no longer exists / `linkId` is gone.

### Step 7 — Optical-specific tools
- [ ] `PlaceAlongBeamTool.tsx`:
  - Toolbar button "Place along beam" toggles a tool mode.
  - In tool mode, click a beam → popup `Distance from start: [___] mm`.
  - Enter → engine call with intent.kind = "beam_along".
  - Checkbox in popup: "Insert into beam path" — if checked, also do the
    link surgery.
- [ ] Link surgery (frontend orchestration):
  ```
  const oldLink = ...;
  await deleteOpticalLink(oldLink.id);
  await createOpticalLink({ from: oldLink.from*, to: newComp, freeSpaceMm: distanceMm });
  await createOpticalLink({ from: newComp, to: oldLink.to*, freeSpaceMm: oldLink.freeSpaceMm - distanceMm });
  ```
  Wrap in try/catch; on failure, restore the old link.

### Step 8 — Multi-select Align panel
- [ ] `AlignPanel.tsx` rendered inside the Object floating panel when
  `selectedObjectIds.length >= 2`.
- [ ] UI: axis radios, target radios, "Apply" button.
- [ ] Compute target value (median/min/max/active/cursor) on the chosen axis.
- [ ] Batch update via Promise.all of `updateSceneObject` calls.

### Step 9 — Expression number fields
- [ ] `utils/exprInput.ts`:
  ```
  parseExpression(input: string, ctx: { current: number; objectsByName: Map<string, SceneObject> }): number
  ```
  Supports `200` `+50` `-50` `*2` `/2` `@200` `mid(name1, name2)`.
- [ ] `<NumberField value onChange ctx>` — replaces `<input type="number">`
  in ComponentPanel's position/rotation/cursor inputs.

## Resumption protocol

If picking this up cold:
1. Read `PLACEMENT_DESIGN.md` end-to-end.
2. Read this file's status table.
3. Find the lowest-numbered ⏳ or 🔧 step.
4. Read its prep notes above.
5. Skim the relevant existing files in the "Files to modify" list of
   PLACEMENT_DESIGN.md to remember current state.
6. Resume.

After each completed step:
1. Update this file's status table.
2. Add a one-line entry to the changelog at the bottom of PLACEMENT_DESIGN.md.
3. Add a vibe coding.md entry per the standard 5-field format.

## Changelog

- **2026-05-02 10:55** — checklist created. Step 1 starting.
