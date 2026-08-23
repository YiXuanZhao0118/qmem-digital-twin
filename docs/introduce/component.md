[← Doc index](README.md)

# Component / ComponentBinding — catalog template + binding tree

> Layers 2–3 of the [core data model](data-model.md). Instantiated as a [SceneObject](object.md); the binding tree's render path is in [rendering.md](rendering.md).

## Component

**Component** — the catalog "template". It has a `vendorPart`, a **ComponentBinding tree**, and outward-facing `exposedFaces`. It has **no physics kind and no physics parameters of its own** (migrations 0094/0095 cleared the physics keys off components; physics is decided by the kind of the bound asset). `Component.kind_id` still exists but is only a **catalog classification slug** (not physics): it drives the inner group label in the parts library (`typeKey = kindId || "uncategorized"`), and composites default to the sentinel `"none"`. It is editable directly in the free-text `kind_id` field on the **PHY Editor COMPONENT tab** (empty = null). The outer category in the parts library is instead decided directly by `properties.category` (unset = Uncategorized; it is no longer derived from the kind — see [kinds.md](kinds.md)).

**The COMPONENT section reads from two sources, so it needs an explicit reload (2026-08-19).** The left-hand list is a view of the **scene store**'s `components`, while the selected component's binding tree comes from `ComponentsEditor`'s **own fetch** (`reloadBindings`). Nothing invalidates either after a change made elsewhere — another tab, a migration, a direct DB edit — so the section could sit showing two different vintages with no way out short of reloading the page. The **↻ button** beside the filter box (`ComponentsEditor.tsx`, `handleRefresh`) reloads **both**: `loadScene()` then `reloadBindings(selectedId)`. Refreshing only one would swap the mismatch rather than clear it.

## ComponentBinding

**ComponentBinding** — a node of the binding tree. It hangs an asset (or a sub-component) under a parent node with a local transform (`local_x_mm`/`local_y_mm`/`local_z_mm` + `local_rx_deg`/`local_ry_deg`/`local_rz_deg`, three-axis rotation), plus `tunable_axes`, `role` and `sort_order`. This is what makes composite components possible (e.g. an isolator = Faraday rod + front and back Glan prisms + housing). Table `component_bindings`: `parent_binding_id`, `target_kind` (asset/empty/subcomponent), `asset_3d_id`, … The local transform is **quantized** on write and on read (1 nm / 1e-9°), same contract as the SceneObject Lab pose — see "Pose quantization" in [anchors.md](anchors.md).

### `role` is load-bearing, not a comment

A binding's `role` (or `properties.role_label`, which wins when set) is **matched by substring** for the front/back semantics of a composite optic: `pickPolariserCentre` (`utils/isolatorAlign.ts:89`) resolves the front/back polariser centres from it, the Object panel's Align gate (`ComponentPanel.tsx:1781`) and the "translucent housing" toggle (`BindingTreeAdjustControls.tsx:195`) both key off "a role containing *front* AND a role containing *back*", and the PHY-Editor preview draws its align marker the same way (`ComponentsEditor.tsx:2764`). **A misspelled role silently disables all of them** — the IO-3-850-HP shipped with `"fornt"` / `"fornt Glan-Laser"` (fixed 2026-08-17), which is why its object had no Align section. Invariant: every composite optic must expose one role matching `/front/i` and one matching `/back/i`; nothing validates this, so check the spelling when a composite loses its Align block.

**The Object-panel Align gate mirrors the resolver, in this order**: the object's PhysicsElement kind ∈ `OPTICAL_ALIGN_KINDS` → an explicit `component.properties.alignSpec` with a non-zero `directionMm` → the front/back roles above. The alignSpec branch matters because `AlignToBeamControls` resolves alignSpec *first* (`AlignToBeamControls.tsx:121`); without it in the gate, a composite whose roles are named anything else would have a perfectly usable align spec and no button to press.

### `properties.portAnchor` — a binding that DEFINES an optical port (2026-08-20)

A pigtailed instrument does not have a bare optical face; it has an FC/APC bulkhead you mate a patch cord to. Model it as the hardware is built: bind a `fiber_connector` asset at each port and tag that binding

```json
"properties": { "portAnchor": "intercept_in" }
```

`db_scene_loader._port_connector_anchors` then re-seats the named anchor of the **sibling device asset** onto that connector's `connect_in` — position, `apertureMm`, and **axisY (the PM slow-axis key)** — before the slot reaches the tracer. So the connector binding is the port's single source of truth: slide it and the coupling face moves, rotate it and the polarization the device accepts rotates with it.

**Why a derivation and not simply using the connector's own anchors:** `connect_in` / `connect_out` are not in `anchor_tracer.PRIMARY_ANCHOR_IDS`, so the tracer can never hit them — a port made of connector anchors alone passes light straight through. `exposedFaces` (below) cannot serve either: it is stored and drawn by the PHY Editor, and **no loader or tracer reads it**. The physics anchor therefore stays `intercept_in` / `intercept_out` on the device asset and the connector supplies its numbers — the same move `_synth_fiber_slot` makes for a patch cord, one level up. See [fiber.md](fiber.md).

**Two things the connector deliberately does not define.** *Direction*: axisX keeps the sense the device authored (the connector's mating normal is sign-flipped to agree), because an input bulkhead faces backwards up the beam and taking it raw would reverse the direction the op emits along. *Scalars* such as `coreMfdUm`: they describe the device's pigtail and the two ports would disagree. Also note an **APC** port is mounted with its 8°-tilted **face normal** on the beam axis, which leaves the ferrule body 8° off — cosmetic, and the alternative (body on axis) would send the output beam 8° off and miss everything downstream.

**The pigtail: `properties.fiberNodes` on the same binding (2026-08-21).** A pigtailed part is not a bulkhead — there is a run of fibre between the device body and that connector. The same binding may carry its own spline:

```json
"properties": {
  "portAnchor": "intercept_in",
  "fiberNodes": [ {"posMm": [0,0,0], "handleOutMm": [...]}, … ],
  "fiberRadiusMm": 0.9
}
```

`bindingTreeObject.buildBindingPigtail` tubes it and hangs it on the **parent** group, so the nodes are in the frame the binding's `localXMm` is expressed in — the parent's CAD frame, **not** the binding's own local frame (applying the binding transform to them would double-count it). Jacket colour follows the bound connector's `defaultParams.fiberType` (PM blue / SM yellow / MM orange, the same table a patch cable uses) unless `fiberJacketColor` overrides it.

**This is what per-binding splines are FOR.** A `fiber` patch cable stores one spline on the Component / SceneObject (`properties.fiberNodes`, single array; `createFiberSplineObject` takes one node list), so a part with **two** pigtails has nowhere to put the second. A binding-scoped spline has no such limit — one Component can hold as many runs as it has bindings.

**Editing it: node-edit mode, per-instance (2026-08-21).** Select the instrument in **node-edit** and every one of its pigtails becomes editable at once — drag an interior anchor, drag a Bezier handle tip, double-click the tube to insert a node, right-click an anchor to delete it. **Both endpoints are locked** (grey, not draggable): node 0 is welded to the device's fibre exit and the last node to the connector's `connect_out`, so moving them would tear the run off the part. Their *handles* stay editable — that is what sets the angle the fibre leaves the boot at.

**The Object panel lists the same nodes (2026-08-21).** The viewer gizmo is the only place a pigtail node can be *created* or *moved*, but it is invisible until you switch modes, so `ComponentPanel.PigtailNodesEditor` mirrors it under **Connections → Pigtails** — gated on `pigtailPortBindings`, one block per port, each listing that run's interior nodes with a **Remove** button and spelling out the right-click / double-click gestures. Removal writes the shortened array through `updatePigtailNodes`, i.e. the same per-instance override the gizmo commits to. A freshly placed pigtail is exactly its two welded ends, so the honest reading of "EOM0 has four nodes and none of them can be removed" is that both of its runs are still undressed — the panel now says so instead of showing nothing at all. The `fiber` and `rf_cable` node lists gained the same one-line gesture hint.

Commits go to **`SceneObject.properties.bindingFiberNodes[bindingId]`**, never back to the binding row. The binding is the catalog baseline shared by every instance; writing a drag there would restyle every EOM in every scene — the exact layer-confusion bug the 2026-05-11 fix in `sceneStore.updateFiberNodes` describes one layer down. `resetPigtailNodes(objectId, bindingId)` drops the override so the instance tracks the catalog shape again. The renderer prefers the override and falls back to the baseline (`buildBindingTreeObject`'s `pigtailNodesFor` resolver, supplied by `bindingRendererGate`).

⚠️ **A per-instance spline must be in the mesh reuse key.** `DigitalTwinViewer`'s `canReuse` compares `componentRef` / `assetRef`, which are both still equal after a drag, so the cached mesh would keep rendering the old shape — `bindingFiberNodes` is folded into `renderHintsKeyNow` for exactly this reason, the same way `translucentHousing` and an annotation's `dynamicSources` are.

**This gizmo is deliberately NOT the fiber one generalised.** That effect (`DigitalTwinViewer.tsx`, ~870 lines, no test coverage) keys on `fiberComponentId` and assumes one spline per Component, and it carries endpoint-drag + Align machinery a pigtail must not have. The pigtail gizmo is separate, additive, and covered by tests.

**Purely visual — the pigtail is never traced.** The optical port is the connector's `connect_in` at the far end, and a pigtailed device's datasheet insertion loss is quoted **fibre-to-fibre**, i.e. it already contains both pigtails; tracing them would double-count. That is also why this needed no loader change at all: `_port_connector_anchors` derives the port from wherever the connector is, so moving it to the end of a 150 mm run moved the port with it and every traced number stayed identical.

**Binding a pigtail: the COMPONENT editor's "Pigtail connectors" picker (2026-08-21; renamed from "Fiber ports" 2026-08-23).** Until this landed, such a binding could only be hand-written — the right `role`, the `portAnchor` tag, and a *solved* pose — which is why the EOSpace was the only part that had any. The COMPONENT pane shows a **Pigtail connectors** section with one connector picker per optical port, the same gesture the `fiber` cable profile uses for End A / End B (`ComponentsEditor.tsx:485` `PIGTAIL_PORT_ANCHORS`, `PigtailConnectorsSection`). It appears for any component whose device asset declares `intercept_in` / `intercept_out` — 7 of the catalog's 45 today, and "— none (bare optical face) —" is the correct answer for the ones that are bare.

**This is NOT the same thing as a chassis bulkhead, and the old name said it was.** The two are different hardware and now have different anchors:

| | pigtail (EOSpace EOM) | bulkhead (Thorlabs RXM15EF) |
|---|---|---|
| what it is | a jacketed fibre coming OUT of the box, ending in its own plug | a socket in the chassis with nothing hanging off it |
| anchor | `intercept_in` / `intercept_out` — the instrument's real optical face, re-seated onto the bound connector's `fiber_out` | `fiber_in`, its own anchor |
| gender | **male** (`fc_apc_male`) — it plugs into things | **female** (`fc_pc_female`) — things plug into it |
| connector asset bound? | yes, that is what this picker does | no; the socket IS the chassis |
| where you connect it | here, in the COMPONENT editor | the Object panel's **Fibre ports** section |

`intercept_*` is correct for a pigtail precisely because the light really does enter the box through that face; the bound connector just moves the face out to the end of the fibre, which is why you can drag it away from the body. See the port section of [fiber.md](fiber.md).

**A pigtail port's device anchor has TWO readings, and which you get depends on who reads it** (documented 2026-08-23; the behaviour is older):

| reader | value | what it means |
|---|---|---|
| `buildPigtailNodes` (`utils/portConnectorPlacement.ts:199`, via `ComponentsEditor.setPortJacket`) | the **authored** coordinate on the `Asset3D` row | where the fibre leaves the package — the pigtail's root, welded to node 0 |
| the tracer, after `db_scene_loader._port_connector_anchors` | **re-seated** onto the bound connector's `fiber_out` | the coupling face |

For the authored EOSpace run those are **91.236 mm apart** (`intercept_in` at the body origin; the `port_in` connector binding dragged to local x = −91.236). This is deliberate, not drift: on a pigtailed part the optical face and the fibre exit ARE the same point on the package, so one anchor carries one physical meaning and the re-seat models the fibre carrying light out to the connector. Splitting them into two anchors would mean authoring the same coordinates twice with an invisible "these must stay equal" rule between them — a worse invariant than one anchor with a documented derivation.

**The trap** it leaves: editing `intercept_in` in the ASSET3D tab looks like it moves the coupling face, but the coupling face is overwritten from the connector at load — what the edit actually moves is the pigtail's root. The Pigtail connectors section says so inline, and both halves are pinned by tests: `portConnectorPlacement.test.ts` ("a pigtail port's device anchor has two readings") for the authored side, `test_the_reseat_does_not_touch_the_authored_anchor` for the loader side.

**When this should become two anchors instead**: the day a pigtailed device appears whose fibre exits the package at a point that is *not* the optical face (say, light in through an end face but the fibre routed out of the side). Then the two coordinates genuinely differ, the single anchor really is overloaded, and the split costs no more then than it would now.

The pose is **seeded, not zeroed**, and that distinction is the whole point: a connector dropped in at the identity would silently DRAG THE PORT with it, because `_port_connector_anchors` puts the port wherever `connect_in` is and `pm_apc_780` carries its `connect_in` 59.3 mm up its own body. `utils/portConnectorPlacement.computePortConnectorPose` solves for

> `R = A_anchor · A_connect_inᵀ`,  `T = p_anchor − R · p_connect_in`

i.e. it maps the connector's whole `connect_in` frame onto the anchor's, so a freshly bound port lands exactly on the face the asset already declared and **changes no traced number** until the user drags it out into a pigtail. Mapping the whole frame (not just axisX) is what pins the roll, and that roll is `connect_in.axisY` — the PM key the device is handed as the polarization axis it accepts. Fed the EOSpace's own anchors, the solver reproduces both hand-authored rotations exactly (`0, −82.007686, −90` and `0, 82.007686, 90`); that is the pinning test, `utils/__tests__/portConnectorPlacement.test.ts`.

Two things worth knowing. **The two axisX end up parallel, not anti-parallel** — the "sign-flipped to agree" above is internal to the loader, and both real ports have `dot = +1`; reading the prose as a statement about the authored geometry gets the placement backwards. And **swapping or clearing a connector deletes the binding row** (the backend makes a binding's target immutable — `schemas.ComponentBindingUpdate`, "delete and recreate"), which orphans every `SceneObject.properties.bindingFiberNodes[bindingId]` keyed on it, so the picker confirms first and says what is lost. The section also flags `fiber_connector` bindings that carry **no** `portAnchor`: they look like ports and are inert, since `connect_*` is not in `PRIMARY_ANCHOR_IDS`.

**The jacket: `+ jacket` on the same row (2026-08-21).** A port is only half a pigtailed part — the other half is the fibre you can see running from the body to the connector. Each port row carries a jacket toggle that writes `properties.fiberNodes` + `fiberRadiusMm` onto the *same* binding. Unlike swapping the connector this is a pure `properties` patch, so the binding id survives and per-instance pigtail drags keyed on it are untouched.

`utils/portConnectorPlacement.buildPigtailNodes` seeds the run in the **parent (Component) frame** — the frame `buildBindingPigtail` reads, since it hangs the tube on the parent group and not the binding's pivot. Node 0 is welded to the device's fibre exit (the port anchor) and the last node to the connector's `connect_out`; the node-edit gizmo locks both, so only the handles and the middle node are draggable. Its shape constants are *measured*, not invented — read back off the hand-authored EOSpace jacket: end handles `0.306 × span` at 30° below horizontal, middle node sagging `0.174 × span` under the chord, a strain-relief droop. "Down" is the Component frame's −Z, right for a Z-up bench part and only a starting shape regardless. It refuses when the connector sits within 5 mm of the anchor, because that is a bare bulkhead with no fibre showing.

**Appearance: the cable editor, per port (2026-08-21).** Each jacketed port row carries the same `CableAppearanceEditor` a `fiber` / `rf_cable` Component gets — jacket colour (picker + the shared swatch table) and visual radius — reused rather than reimplemented, and rendered **per port** because a part's two pigtails are separate runs that may legitimately differ. It writes `properties.fiberJacketColor` / `fiberRadiusMm` on that binding; the editor's *default* button clears the key so the value falls back to what the renderer would pick on its own. To show that fallback truthfully, `bindingTreeObject` now exports `PIGTAIL_JACKET_COLOR` and `PIGTAIL_DEFAULT_RADIUS_MM` (0.9 mm) instead of keeping them private — the alternative was a fourth copy of the fiberType→colour table. Adding a jacket deliberately writes **no** radius, so "default" means something on a fresh run.

**The default colour follows the CONNECTOR's `defaultParams.fiberType`**, not the device's — `buildBindingPigtail` has no view of the instrument. `30126a9_step` declares `single_mode`, so its jacket defaults to yellow even on a PM part like the EOSpace (`pm_apc_780` declares `polarization_maintaining` and defaults to blue). That is a property of the connector asset, so the fix is either an override on the binding or a correction to the asset's `fiberType` — note that field is also the connector's PM-key physics input, not just a colour.

First device built this way: `eospace_az_0s5_20_pfa_pfa_850_900` — gold housing → black strain-relief boot → blue PM fibre → FC/APC ferrule, on both ends. Tests: `backend/tests/optical/test_port_connector_anchors.py` and `frontend/src/three/__tests__/bindingTreeObject.test.ts`.

### Aligning a port: "Align End A / End B", per instance (2026-08-21)

A pigtailed instrument does **not** align as one body, and the Object panel no longer offers to. `AlignToBeamControls` moves the whole SceneObject onto one (point, direction), which for a two-port part means pointing End B at a coupler drags End A off whatever it was already plugged into. So `eom` joins `fiber` in dropping out of `OPTICAL_ALIGN_KINDS` (`alignVariant: "none"`), and its Align section is `PigtailEndAlignControls` instead — one button per port, the same two-phase UX as the patch cable's Align End A/B, with the same 25 mm tolerance and the same picker when several targets cluster.

**What moves is the CONNECTOR, not the instrument.** The port *is* the connector's `connect_in` (that is what `_port_connector_anchors` re-seats onto), the pigtail between body and connector is flexible, and the box stays where it was bolted down. So the align solves `outer · local · connect_in = target` for the binding's local pose — `utils/pigtailAlignment.computeConnectorAlignPose` — where `outer` is the SceneObject pose composed with any parent bindings. Rotation is the **shortest arc** from the face's current axisX onto the target direction, applied on top of the current orientation: a gratuitous spin would re-key `connect_in.axisY`, which is the PM axis the loader hands the device as the polarization it accepts.

**Persisted as an `ObjectBinding` delta**, never back to the ComponentBinding — that row is the catalog baseline shared by every instance, the same layer split `bindingFiberNodes` keeps for the jacket. `effective = baseline + delta` per axis on both sides (`componentBindings._effectiveTransform`, backend `_binding_pose_with_override`), so the delta is just `target − baseline`, wrapped to (−180, 180] on the angles. This needed **no backend change**: `_port_connector_anchors` already composes the override into `_binding_tree_transform`, so the solver's port follows the connector for free.

**The pigtail comes along**: its last node is welded to `connect_out`, so it is re-derived from the new pose and its `handleIn` carried through the same rotation (the boot angle is preserved). Node 0 and the interior nodes stay exactly where the user dressed them — the run simply stretches, which is what the real fibre does.

**Targets, and links.** Both kinds the patch cable offers: a free-space **beam** segment (the face lands on its projection and takes the beam's propagation direction) and a fibre **receptacle** (🔌, mated `FIBER_MATING_GAP_MM` up- or downstream per end). Only a receptacle candidate persists a link, in `SceneObject.properties.pigtailEndpoints[portAnchor]` — keyed by the **port anchor, not the binding id**, because binding rows are recreated whenever a Component is re-authored (EOM0 still carries one orphaned `bindingFiberNodes` key from exactly that) while `intercept_in` / `intercept_out` do not. `resnapPigtailsLinkedTo` re-derives a linked end whenever its target moves, alongside the fibre and coax resnaps.

Which ends a part offers comes from `componentBindings.pigtailPortBindings` — purely the data above (a `fiber_connector` binding tagged `portAnchor`), so any future pigtailed part gets the buttons with no per-kind code. Geometry is pinned in `frontend/src/utils/__tests__/pigtailAlignment.test.ts`, against the authored EOSpace `port_out` binding: feeding it back its own pose must reproduce the template's last node, which is what proves the `connect_out` weld.

## exposedFaces

Through `exposedFaces` a Component maps outward semantic ports (e.g. `optical_in`) onto `assetBindingId + anchorId`, so a composite exposes only semantic optical ports to the outside (faces are retired → anchors, see [anchors.md](anchors.md)).
