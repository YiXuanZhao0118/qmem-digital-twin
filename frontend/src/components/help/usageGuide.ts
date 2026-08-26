/**
 * Hand-written "how to use the app" pages for the Help modal.
 *
 * Deliberately separate from `helpDocs.ts`: those are the repo's architecture
 * docs (what the system IS), these are operating instructions (what the user
 * DOES). They are markdown strings so both halves of the modal go through the
 * same renderer; `> **Key —** …` blockquotes carry the takeaway of each page.
 *
 * Keep in sync with the UI they describe — the shortcut table mirrors the
 * handler in `App.tsx`, the cursor commands mirror `optical/CursorMenu.tsx`,
 * and the panel list mirrors `PANEL_DEFS` in `workspace/WorkspaceProvider.tsx`.
 */

export type UsagePage = { id: string; title: string; body: string };

const OVERVIEW = `# What this is

**QMsimulation** (qmem-digital-twin) is a **digital twin of a quantum-memory /
cold-atom optics lab**. You place and align optical components, wire up optical
and RF chains, schedule pulses along a timeline, and watch how the beam
propagates and gets acted on — live, in the browser.

> **Key —** *Lab* is where you **build the bench out of parts**. *PHY Editor* is
> where you **define the parts themselves**. Almost all day-to-day work happens
> in Lab.

## Three workspaces

| Workspace | How to get there | What it's for |
|---|---|---|
| **Lab** (main scene) | the default screen | Place hardware, wire optical / RF links, trace beams, schedule timing |
| **PHY Editor** | top bar → **Lab** tab → **PHY Editor** | Edit the catalog: KIND / DEVICE / ASSET3D / COMPONENT definitions |
| **BUILD** | PHY Editor → **BUILD** in the left rail | Convert CAD (STEP) into a coloured GLB in-browser, producing a new Asset3D |

## The top bar

- **Left — project logo.**
- **Lab tab** — click it to drop down the scene menu: **Initial Setup** (room
  length / width / height, in mm) and **PHY Editor**.
- **Middle toolbar**, left to right: add a text annotation (drops a label at the
  3D cursor) · add a rect annotation (drops a rectangular marking on the table
  top, at the cursor's X/Y) · **Display overlays** (eye icon) · single/dual
  viewport toggle · WebSocket connection status.
- **Right — Window menu** (grid icon): re-open panels you closed, or
  **Reset layout**.
- **Right — Help** (question mark): this window.

## Everything you edit is live and shared

> **Key —** There is **no Save button and no draft mode.** Every edit writes
> straight to the backend database and is broadcast over WebSocket to every
> other browser on the same scene. Edits take effect immediately — **Ctrl+Z is
> your undo**, not a discard-changes dialog.

The status pill in the top bar must read \`connected\` for what you see to be the
live scene.
`;

const LAB = `# Working in the Lab scene

## Selecting

- **Left-click an object** to select it; click empty space to deselect.
- The **Object** panel on the right then shows that object's position, rotation
  and tunable parameters.
- The **Outliner** panel lists every object in the scene; select from there too.
- With several objects selected, use the Object panel's **Group delta** fields
  or Align / Distribute to move the whole set at once.

## Placing components

1. Open the **Components** panel on the left and filter with the search box.
2. Click a row to select it, or click the **＋** at the end of the row to drop it
   into the scene.
3. **Exception:** *RF cable*, *SMA cable* and *programmable pulse generator*
   are **not** placed from the catalog — they only come into existence when you
   **drag a connection in the RF link panel**.

## Moving and rotating (gizmo)

- Selecting an object gives you the **Translate** gizmo; the buttons at the top
  left of the viewport switch it to **Rotate**.
- The viewport also carries **X-ray / Rendered** display modes (top left)
  and the XYZ axis gizmo plus the face-touch **Tools pie** (top right).
- For exact values, type into the Object panel. **Number fields accept
  expressions**, not just numbers: \`+50\`, \`*2\`, \`@200\`, \`mid(A,B)\`.

> **Key —** The gizmo **snaps back to Translate every time you re-select**
> something. That is deliberate, not a bug.

In Translate mode an **arrow you are looking straight down disappears** (from
about 14° off-axis) — so in a dead-on front or top view you get two arrows, not
three. That is deliberate too: end-on, an arrow covers the flat XY / YZ / XZ
handles and steals their clicks, and dragging it that way sends the object
flying, because the direction you are pulling barely exists on screen. Orbit a
little and the third arrow comes back. Rotate mode always keeps all three rings.

## Snapping

While you drag, the engine collects nearby snap targets and ranks them roughly
in this order:

**an explicitly picked beam** > beam centreline / endpoint / intersection (for
optical parts) > **anchor** > face centroid > bbox centre > vertex > 3D cursor /
world origin > grid.

- Press **Tab** to cycle through the runner-up candidates.

> **Key —** The snap is stored as an **intent** (e.g. "12 mm along beam …",
> "anchor-matched to …"), not just a number — so it can be replayed later.
> See the *Placement & snapping* architecture doc.

## The 3D cursor (Blender-style)

The 3D cursor is where new objects land and what several align / snap commands
aim at. It is **also the orbit centre**, and the two follow each other both
ways: orbit, pan or zoom and the cursor moves to the middle of your view once
the motion settles; set it explicitly and the view swings onto it.

> **Key —** The cursor means **"the middle of what I'm looking at"**. Frame the
> spot you care about and the cursor is already there — there is normally
> nothing to place by hand, which is why its crosshair marker is **hidden by
> default**.

Press **Shift+S** to open the cursor menu at the pointer:

| Command | Effect |
|---|---|
| Selection → **Cursor** | Move the selected object(s) to the 3D cursor |
| Selection → **Active** | Move the rest of the selection onto the active object |
| Cursor → **World origin** | Reset the cursor to (0, 0, 0) |
| Cursor → **Active** | Cursor jumps to the active object |
| Cursor → **Selected (median)** | Cursor jumps to the median of the selection |
| Cursor → **Beam point** | Cursor jumps to the last beam point you clicked (**click a beam first**) |

## The viewport strip (top left)

Left to right: **display modes** (X-ray / Rendered / …) · **Translate /
Rotate** · the **crosshair** switch · the **Home** controls.

- **Crosshair** — one switch for the whole 3D-cursor feature: it shows the
  cursor marker *and* the **Cursor (mm)** field for typing exact coordinates.
- **Bookmark** — save the current view as **Home**. The **H** button on the
  axis gizmo (top right) then returns to *your* view instead of the default
  framing; a second button clears it again. The **X / Y / Z / -X / -Y / -Z**
  buttons on that same axis gizmo orbit around wherever you are currently
  looking, rather than snapping the view back to the cursor.

## Beams

- Click a beam segment to inspect power, polarization and beam size in the
  **Beam scope** panel.
- If a beam is missing or dies out, the usual cause is a component that isn't
  aligned to its aperture, or an emission hidden on the object's Visualization
  card.

> **Key —** Beams are solved by the **backend** (\`/api/v3/solver\`) and
> **re-trace automatically** whenever the scene changes. There is no
> "Run solver" step to remember.
`;

const PANELS = `# Panels

Panels **dock** left / right / bottom, or **float** as free windows. Drag the
title bar to move, the bottom-right corner to resize.

> **Key —** Closed a panel and can't find it? **Window menu** (top right)
> re-opens it; **Reset layout** restores every default position. The layout is
> remembered per browser.

| Panel | Default | What it does |
|---|---|---|
| **Components** | left, open | The catalog — where objects enter the scene |
| **Outliner** | left, open | Scene object list: select / rename / hide / group (double-click a collection selects all of it) |
| **Object** | right, open | Position, rotation and tunable physics params of the selection |
| **Pulse & Timing** | bottom, closed | Sequences, pulse scheduling, scrub time |
| **Beam scope** | float, closed | Power / polarization / beam profile at the clicked beam point |
| **RF link** | float, closed | RF chain graph — drag a connection to create a cable |
| **Touch coincidence** | float, closed | Face-touch / alignment helper |

> **Beam scope** and **Touch coincidence** are **not** in the Window menu —
> they open themselves when you act in the scene (click a beam, pick a face).

## Display overlays (eye icon)

Toggles scene overlays. The first four have number-key shortcuts: **1**
components · **2** connections · **3** beam segments · **4** anchors. **0**
resets them all.
`;

const PHY_EDITOR = `# PHY Editor and BUILD

Enter from the top bar: **Lab** tab → **PHY Editor**. It takes over the whole
page; "← Back to scene" at the top left returns you. The left rail has two axes:

- **PHY domain** filter: All / Optical / RF / Mechanical.
- **Catalog**, four sections:

| Section | Contents |
|---|---|
| **KIND** | Contract registry — the parameters and anchor template of each physics kind |
| **BUILD** | Import CAD (STEP) → coloured GLB → produce an Asset3D |
| **DEVICE** | The instrument registry: one concrete part (mesh + named-anchor layout + default params) pinned to one behavioural kind. Picking a device in ASSET3D seeds that asset's anchors and writes its kind through |
| **ASSET3D** | Geometry + physics ground truth: mesh, anchor poses, default params, tunable params |
| **COMPONENT** | Compose one or more Asset3D into a part, with its binding tree |

The data model is four layers — **Kind → Asset3D → Component → SceneObject**.

> **Key —** **Physics parameters live on the Asset3D**, not on the component or
> the scene object; a scene instance only stores the per-instance runtime values
> it is allowed to tune. See the *Data model* architecture doc.

## 🔒 Locked rows cannot be edited

A 🔒 on a row means someone reviewed it, confirmed it complete, and froze it.

> **Key —** The lock is **enforced by the backend, not advisory** — any write to
> a locked row is rejected with **422**. To change one you must click the lock
> icon to unlock it first, which is a deliberate human decision.

## Refreshing the COMPONENT list

The component list and the binding tree of the component you have open are
loaded **separately**, and neither notices a change made somewhere else —
another browser tab, a migration, a direct database edit.

> **Key —** If the COMPONENT section looks out of date, use the **↻** button
> next to the filter box rather than reloading the page. It re-fetches the list
> **and** the open component's bindings, so the whole section comes back on one
> vintage.

## Unsaved changes

While an editor has unsaved edits, **● Unsaved** shows at the top right, and
switching sections or leaving the editor asks for confirmation first.

## BUILD limits

> **Key —** Very large STEP files (hundreds of MB) **hit the browser's WASM
> address-space limit and fail.** Convert those offline and import the GLB
> instead.
`;

const SHORTCUTS = `# Keyboard shortcuts

> **Key —** None of these fire while you are typing in an input, textarea or
> select — so you can safely type "s" or "h" into a field.

## Display

| Key | Action |
|---|---|
| **1** / **2** / **3** / **4** | Toggle overlay: components / connections / beam segments / anchors |
| **0** | Reset all overlays |

## Selection and visibility

| Key | Action |
|---|---|
| **H** | Hide the selected object **for this session only** |
| **Shift+H** | Hide it **permanently** (writes \`visible = false\` to the database) |
| **Esc** | Reveal everything hidden for the session; also closes the cursor menu |
| **S** | Solo the selected object (with only a component template selected, solos every instance of it) |
| **Shift+S** | Open the 3D cursor menu (this also exits solo) |

## Editing

| Key | Action |
|---|---|
| **Del** | Delete every selected object (asks first; locked objects are skipped, and this is *not* undoable) |
| **Ctrl/Cmd + Z** | Undo (also the ↶ button in the top bar's Edit group, whose tooltip names the step it will reverse) |
| **Ctrl/Cmd + Shift + Z** or **Ctrl/Cmd + Y** | Redo |
| **Tab** (while dragging) | Cycle through snap candidates |

## Expressions in number fields

The Object panel's numeric fields take expressions, not just numbers:

| Input | Meaning |
|---|---|
| \`+50\` | Add 50 to the current value |
| \`*2\` | Multiply by 2 |
| \`@200\` | 200 mm along the reference axis |
| \`mid(A,B)\` | The midpoint of A and B |
`;

export const USAGE_PAGES: UsagePage[] = [
  { id: "overview", title: "Getting started", body: OVERVIEW },
  { id: "lab", title: "Working in the Lab", body: LAB },
  { id: "panels", title: "Panels", body: PANELS },
  { id: "phy-editor", title: "PHY Editor / BUILD", body: PHY_EDITOR },
  { id: "shortcuts", title: "Keyboard shortcuts", body: SHORTCUTS },
];
