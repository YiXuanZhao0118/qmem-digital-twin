/**
 * ComponentsV2Editor — PHY Editor's "▼ Optical → COMPONENTS" pane.
 *
 * Composes multiple Asset3D into a single Component by adding child
 * bindings, each with a relative local pose (x/y/z mm + rx/ry/rz deg).
 *
 * MVP scope:
 *   - List / create / delete Components
 *   - Add / edit (pose) / remove Asset3D child bindings
 *   - New asset bindings use a flat structure (`parentBindingId=null`)
 *     under the Component. Legacy `target_kind="empty"` bindings created
 *     by older seed/migration paths are hidden from the UI.
 *
 * Known limitations (intentional — out of MVP scope):
 *   - We do NOT auto-create an "empty" root binding when creating a
 *     Component: the backend route at
 *     ``backend/app/routers/component_bindings.py`` line 145–154 has an
 *     unreachable ``assert payload.sub_component_id is not None`` in the
 *     else branch that fires for ``target_kind="empty"``. Fixing that
 *     handler is out of scope for this editor. As a side-effect,
 *     ``shouldRenderViaBindings()`` returns false for Components built
 *     here (no non-root binding), so the 3D viewer falls back to the
 *     legacy single-asset path until a separate task addresses it.
 *   - exposedFaces editing — re-defined later
 *   - subcomponent target_kind (Component inside Component)
 *   - tunable_axes declaration
 *   - Swapping asset3dId on an existing binding — backend treats target
 *     as immutable; user removes + re-adds for now
 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import {
  createComponentApi,
  updateComponentApi,
  deleteComponentApi,
  listComponentBindingsApi,
  createComponentBindingApi,
  updateComponentBindingApi,
  deleteComponentBindingApi,
  resolveAssetUrl,
  type ComponentBindingUpdatePayload,
} from "../api/client";
import { useKindsStore } from "../store/kindsStore";
import { useSceneStore } from "../store/sceneStore";
import { applyAssetScale } from "../three/loadAsset/primitive";
import { applyViewerHintsToGeometry } from "../three/loadAsset/viewerHints";
import {
  GLAN_POLARIZER_PRISM_FILEPATH,
  buildGlanPolarizerPrismObject,
} from "../three/loadAsset/procedural/glan_polarizer_prism";
import { createSmaShortCable } from "../three/loadAsset/rf_cable";
import { createFiberSplineObject } from "../three/loadAsset/fiber/spline";
import type { FiberNode } from "../three/loadAsset/fiber";
import { anchorObjectLocalAxisX, anchorObjectLocalPos } from "../utils/anchorAccess";
import { getNumericProperty } from "../three/transformUtils";
import type {
  Anchor,
  Asset3D,
  AssetViewerHints,
  ComponentBinding,
  ComponentItem,
  ElementKind,
  PhysicsCapability,
} from "../types/digitalTwin";
import {
  kindIdToElementKind,
  domainForElementKind,
} from "../utils/elementDefaults";
import { mThinLens } from "../optical/generalizedAbcd";
import {
  ASIDE_STYLE,
  asideItemStyle,
  ERROR_BANNER,
  INPUT,
  MAIN_BODY_STYLE,
  PRIMARY_BUTTON,
  SECTION_LABEL,
  SHELL_STYLE,
  TD,
  TH,
} from "./phyEditorTheme";

export type ComposerDomain = "optical" | "rf" | "mechanical";

/** Build a physics-face overlay for a binding's asset, so the Component
 *  preview shows WHERE/HOW each optic acts on the beam — mirroring the
 *  Optical Link panel's PBS coating overlay:
 *    - beam_splitter (Glan / PBS): a translucent PINK quad in the coating
 *      plane (perpendicular to the intercept_face anchor's axisX = the
 *      coating normal) → the reflective surface.
 *    - faraday_rotator: a translucent AMBER disk perpendicular to the
 *      optical axis (optical_center axisX) + a curved arrow spanning the
 *      asset's rotationDeg → the polarization-rotation plane.
 *  Positions/orientations come through anchorAccess so R_body / bfp are
 *  honoured (same frame as the meshes). Returns null for other kinds.
 *  Geometry is authored in a local frame with +Z = the face normal, then
 *  the group is oriented onto that normal in CAD/body mm. */
function buildPhysicsFaceOverlay(asset: Asset3D): THREE.Object3D | null {
  const anchorById = (id: string): Anchor | undefined =>
    (asset.anchors ?? []).find((a) => a.id === id);
  const orientAt = (
    group: THREE.Group, normal: { x: number; y: number; z: number },
    pos: { x: number; y: number; z: number },
  ): void => {
    const n = new THREE.Vector3(normal.x, normal.y, normal.z);
    if (n.lengthSq() < 1e-9) return;
    n.normalize();
    group.position.set(pos.x, pos.y, pos.z);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  };

  if (asset.kindId === "beam_splitter") {
    const anc = anchorById("intercept_face");
    const n = anc ? anchorObjectLocalAxisX(anc, asset) : null;
    if (!anc || !n) return null;
    const params = { ...(asset.defaultParams ?? {}), ...(asset.properties ?? {}) };
    const sizeMm = getNumericProperty(params, "sizeMm", 6.5);
    const lengthMm = getNumericProperty(params, "lengthMm", 7.5);
    const w = sizeMm * 1.1;
    const h = Math.hypot(sizeMm, lengthMm) * 1.05; // span the diagonal cut
    const group = new THREE.Group();
    group.name = "reflection-face";
    group.add(new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({
        color: 0xf472b6, transparent: true, opacity: 0.28,
        side: THREE.DoubleSide, depthWrite: false, depthTest: false,
      }),
    ));
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, h)),
      new THREE.LineBasicMaterial({ color: 0xf9a8d4, transparent: true, opacity: 0.95, depthTest: false }),
    );
    group.add(outline);
    group.children.forEach((c) => { c.renderOrder = 40; });
    orientAt(group, n, anchorObjectLocalPos(anc, asset));
    return group;
  }

  if (asset.kindId === "faraday_rotator") {
    const anc = anchorById("optical_center");
    const axis = anc ? anchorObjectLocalAxisX(anc, asset) : null;
    if (!anc || !axis) return null;
    const r = Math.min(anc.apertureMm ?? 6, 8); // clear-aperture radius, capped
    const rotDeg = getNumericProperty(asset.defaultParams ?? {}, "rotationDeg", 45);
    const group = new THREE.Group();
    group.name = "faraday-rotation-face";
    const AMBER = 0xf59e0b;
    group.add(new THREE.Mesh(
      new THREE.CircleGeometry(r, 48),
      new THREE.MeshBasicMaterial({
        color: AMBER, transparent: true, opacity: 0.22,
        side: THREE.DoubleSide, depthWrite: false, depthTest: false,
      }),
    ));
    const ringPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 48; i += 1) {
      const t = (i / 48) * Math.PI * 2;
      ringPts.push(new THREE.Vector3(r * Math.cos(t), r * Math.sin(t), 0));
    }
    const lineMat = new THREE.LineBasicMaterial({ color: AMBER, transparent: true, opacity: 0.95, depthTest: false });
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPts), lineMat));
    // Curved rotation arrow spanning rotationDeg (caps the visual at 90°).
    const arcR = r * 0.62;
    const arcDeg = Math.min(Math.abs(rotDeg), 90);
    const arcPts: THREE.Vector3[] = [];
    const segs = 28;
    for (let i = 0; i <= segs; i += 1) {
      const t = (i / segs) * arcDeg * Math.PI / 180;
      arcPts.push(new THREE.Vector3(arcR * Math.cos(t), arcR * Math.sin(t), 0));
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(arcPts), lineMat));
    const endT = arcDeg * Math.PI / 180;
    const head = new THREE.Mesh(
      new THREE.ConeGeometry(arcR * 0.16, arcR * 0.4, 10),
      new THREE.MeshBasicMaterial({ color: AMBER, depthTest: false }),
    );
    head.position.set(arcR * Math.cos(endT), arcR * Math.sin(endT), 0);
    head.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(-Math.sin(endT), Math.cos(endT), 0), // arc tangent (CCW)
    );
    group.add(head);
    group.children.forEach((c) => { c.renderOrder = 40; });
    orientAt(group, axis, anchorObjectLocalPos(anc, asset));
    return group;
  }

  return null;
}

/** Walks a procedural tube/jacket wrapper, finds the mesh tagged
 *  `userData[roleKey] === "tube"`, and swaps its TubeGeometry for a
 *  CylinderGeometry of equivalent length + radius (Y-axis cylinder
 *  rotated to lie along the longest extent). three.js TubeGeometry
 *  twists the cross-section vertices 360° around a straight Bezier
 *  curve due to Frenet-frame fallback (mrdoob/three.js#16040) — the
 *  twist is invisible on uniform-colour smooth cylinders but shows up
 *  as a spiral on fibers, which is what makes the PHY editor preview
 *  look curved when the underlying geometry is actually straight. The
 *  cylindrical replacement is rotationally symmetric so it can never
 *  twist regardless of camera angle. Duplicated in Asset3DV3Editor —
 *  keep in sync. */
function replaceSpiralTubeWithCylinder(
  root: THREE.Object3D,
  roleKey: "fiberRole" | "rfCableRole",
): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    if (node.userData?.[roleKey] !== "tube") return;
    const bbox = new THREE.Box3().setFromBufferAttribute(
      node.geometry.attributes.position as THREE.BufferAttribute,
    );
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    const axes: Array<["x" | "y" | "z", number]> = [
      ["x", size.x], ["y", size.y], ["z", size.z],
    ];
    axes.sort((a, b) => b[1] - a[1]);
    const heightAxis = axes[0][0];
    const length = axes[0][1];
    const radius = (axes[1][1] + axes[2][1]) / 4;
    const cyl = new THREE.CylinderGeometry(radius, radius, length, 18);
    if (heightAxis === "x") cyl.rotateZ(Math.PI / 2);
    else if (heightAxis === "z") cyl.rotateX(Math.PI / 2);
    cyl.translate(center.x, center.y, center.z);
    node.geometry.dispose();
    node.geometry = cyl;
  });
}

/**
 * Classify a Component into one of three composer domains.
 *
 * Priority:
 *   1. `physicsCapabilities` — explicit declaration (only ~21/290 today)
 *   2. `componentType` → ElementKind → ElementDomain (optical/rf via kinds
 *      registry; covers most components that have a physics kind)
 *   3. Fallback "mechanical" — posts, mounts, annotations, chassis, etc.
 *      that don't map to any kind.
 */
function classifyComponentDomain(c: ComponentItem): ComposerDomain {
  const caps = c.physicsCapabilities as readonly string[];
  if (caps.includes("optical")) return "optical";
  if (caps.includes("rf")) return "rf";
  const kind = c.kindId != null ? kindIdToElementKind(c.kindId) : null;
  if (kind) return domainForElementKind(kind);
  return "mechanical";
}

/** Mirrors the Asset3DV3Editor `domainAssets` bucketing, but returns the
 *  full list rather than a per-domain boolean — used to render badges on
 *  each component binding row so the user can see at a glance which rail
 *  to find the asset in. */
function assetDomains(asset: Asset3D): ComposerDomain[] {
  const explicit = (asset.properties as { domains?: string[] } | undefined)?.domains;
  if (Array.isArray(explicit) && explicit.length > 0) {
    return explicit.filter(
      (d): d is ComposerDomain => d === "optical" || d === "rf" || d === "mechanical",
    );
  }
  const rawKind = asset.kindId;
  if (!rawKind || rawKind === "none") return ["mechanical"];
  const out = new Set<ComposerDomain>();
  out.add(domainForElementKind(rawKind as ElementKind));
  for (const f of (asset.faces ?? []) as Array<{ domain?: string }>) {
    const fd = f.domain ?? "optical";
    if (fd === "optical" || fd === "rf") out.add(fd);
    if (fd === "ttl") out.add("rf");
  }
  return Array.from(out);
}

const DOMAIN_BADGE_COLORS: Record<ComposerDomain, { bg: string; fg: string }> = {
  optical:    { bg: "#dbeafe", fg: "#1d4ed8" },
  rf:         { bg: "#fed7aa", fg: "#9a3412" },
  mechanical: { bg: "#e5e7eb", fg: "#374151" },
};

/** Return the set of binding ids that are descendants of `bindingId`
 *  (children, grandchildren, ...). Used to compute a cycle-safe list of
 *  candidate parents in the bindings table — a binding can never be its
 *  own ancestor's parent. */
function descendantBindingIds(
  bindings: ComponentBinding[],
  bindingId: string,
): Set<string> {
  const out = new Set<string>();
  const stack = [bindingId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const b of bindings) {
      if (b.parentBindingId === current && !out.has(b.id)) {
        out.add(b.id);
        stack.push(b.id);
      }
    }
  }
  return out;
}

function DomainBadge({ domain }: { domain: ComposerDomain }) {
  const c = DOMAIN_BADGE_COLORS[domain];
  return (
    <span
      style={{
        background: c.bg,
        color: c.fg,
        fontSize: 9,
        padding: "1px 5px",
        borderRadius: 3,
        lineHeight: 1.4,
        fontFamily: "ui-monospace, monospace",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.3,
      }}
    >
      {domain}
    </span>
  );
}

// Local style aliases — wire the long-standing names in this file to
// the shared phy-editor theme so all three editors render with the
// same colors / font / spacing.
const inputStyle = INPUT;
const btnPrimary = PRIMARY_BUTTON;
const btnDanger: React.CSSProperties = {
  ...PRIMARY_BUTTON,
  background: "transparent",
  color: "#f87171",
  borderColor: "#7f1d1d",
};
const thStyle = TH;
const tdStyle = TD;

/** Editor mode — controls which fields are editable.
 *  - "binding-dev": catalog editor. Compose bindings (add/remove + role +
 *    asset target), edit name/type/brand/model. Pose columns are hidden;
 *    pose tuning belongs to PHY Editor.
 *  - "phy-editor": physics-tuning editor. Adjust each binding's pose
 *    (localXYZ + localRxRyRz). Add/remove + name/type/brand/model are
 *    hidden; composition is fixed in binding-dev.
 *  Both modes share the 3D preview + probe-beam viz. */
export type ComponentsV2EditorMode = "binding-dev" | "phy-editor";

export function ComponentsV2Editor({
  domain,
  mode = "binding-dev",
}: {
  domain: ComposerDomain;
  mode?: ComponentsV2EditorMode;
}) {
  const isBindingDev = mode === "binding-dev";
  const allComponents = useSceneStore((s) => s.scene.components);
  const assets = useSceneStore((s) => s.scene.assets);
  const loadScene = useSceneStore((s) => s.loadScene);

  // Show only Components whose classification matches this editor's domain.
  // The same source list (`scene.components`) is filtered three different
  // ways by the three rail items (Optical / RF / Mechanical COMPONENTS).
  const components = useMemo(
    () => allComponents.filter((c) => classifyComponentDomain(c) === domain),
    [allComponents, domain],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [bindings, setBindings] = useState<ComponentBinding[]>([]);
  const [bindingsLoading, setBindingsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The binding whose orientation gizmo (+ PBS beam viz) is shown in the
  // 3D preview. Auto-targets the first asset-binding when the user picks
  // a component, but the user can click a different row to switch.
  const [selectedBindingId, setSelectedBindingId] = useState<string | null>(null);
  // Asset picker for "+ Add binding". Was previously hardcoded to
  // assets[0]; now opens a filterable modal so the user can attach any
  // asset, not just the alphabetically-first one.
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [assetPickerFilter, setAssetPickerFilter] = useState("");

  const reloadBindings = async (componentId: string): Promise<void> => {
    setBindingsLoading(true);
    try {
      const list = await listComponentBindingsApi(componentId);
      setBindings(list);
    } catch (e) {
      setError(`Failed to load bindings: ${String(e)}`);
    } finally {
      setBindingsLoading(false);
    }
  };

  useEffect(() => {
    if (selectedId) void reloadBindings(selectedId);
    else setBindings([]);
  }, [selectedId]);

  // Bootstrap the Kind registry once — populates the kind_id <select>
  // and the same store is reused by Asset3DV3Editor.
  const kinds = useKindsStore((s) => s.kinds);
  const kindsStatus = useKindsStore((s) => s.status);
  const fetchKinds = useKindsStore((s) => s.fetchAll);
  useEffect(() => {
    if (kindsStatus === "idle") void fetchKinds();
  }, [kindsStatus, fetchKinds]);

  const selected = useMemo(
    () => components.find((c) => c.id === selectedId) ?? null,
    [components, selectedId],
  );

  const filtered = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    const base = q
      ? components.filter((c) =>
          `${c.name} ${c.kindId ?? ""}`.toLowerCase().includes(q),
        )
      : components;
    return [...base].sort((a, b) => a.name.localeCompare(b.name));
  }, [components, filterText]);

  const assetById = useMemo(
    () => new Map(assets.map((a) => [a.id, a] as const)),
    [assets],
  );

  // Show only target_kind="asset" bindings. Legacy "empty" roots created
  // by seed/migration are infrastructure and not user-relevant in this view.
  const childBindings = useMemo(
    () =>
      bindings
        .filter((b) => b.targetKind === "asset")
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [bindings],
  );

  // Default-select the first asset binding for the gizmo when bindings
  // change; clear if the currently selected one disappeared.
  useEffect(() => {
    if (childBindings.length === 0) {
      setSelectedBindingId(null);
      return;
    }
    if (!selectedBindingId || !childBindings.some((b) => b.id === selectedBindingId)) {
      setSelectedBindingId(childBindings[0].id);
    }
  }, [childBindings, selectedBindingId]);

  const handleCreateComponent = async (): Promise<void> => {
    const name = window.prompt("Component name:")?.trim();
    if (!name) return;
    const kindId = window
      .prompt("Kind id (e.g. lens, mirror, isolator):")
      ?.trim();
    if (!kindId) return;
    try {
      const created = await createComponentApi({ name, kindId });
      await loadScene();
      setSelectedId(created.id);
    } catch (e) {
      setError(`Create failed: ${String(e)}`);
    }
  };

  const handleDeleteComponent = async (): Promise<void> => {
    if (!selected) return;
    if (
      !window.confirm(
        `Delete Component "${selected.name}"? All child bindings will be removed.`,
      )
    )
      return;
    try {
      await deleteComponentApi(selected.id);
      await loadScene();
      setSelectedId(null);
    } catch (e) {
      setError(`Delete failed: ${String(e)}`);
    }
  };

  const handlePatchComponent = async (
    patch: Parameters<typeof updateComponentApi>[1],
  ): Promise<void> => {
    if (!selected) return;
    try {
      await updateComponentApi(selected.id, patch);
      await loadScene();
    } catch (e) {
      setError(`Update failed: ${String(e)}`);
    }
  };

  const handleAddBinding = (): void => {
    if (!selected) return;
    if (assets.length === 0) {
      setError(
        "No Asset3D available. Create one in ▼ Optical → ASSET3D first.",
      );
      return;
    }
    setAssetPickerFilter("");
    setAssetPickerOpen(true);
  };

  const handlePickAsset = async (asset3dId: string): Promise<void> => {
    if (!selected) return;
    const asset = assets.find((a) => a.id === asset3dId);
    if (!asset) {
      setError("Picked asset is no longer in the catalog ??refresh and try again.");
      return;
    }
    setAssetPickerOpen(false);
    try {
      await createComponentBindingApi(selected.id, {
        targetKind: "asset",
        parentBindingId: null,
        asset3dId: asset.id,
        role: asset.name,
        localXMm: 0,
        localYMm: 0,
        localZMm: 0,
        localRxDeg: 0,
        localRyDeg: 0,
        localRzDeg: 0,
        sortOrder: childBindings.length,
      });
      await reloadBindings(selected.id);
    } catch (e) {
      setError(`Add binding failed: ${String(e)}`);
    }
  };

  // Filter + sort for the picker modal. Searches across name,
  // catalog_id, physics_kind so the user can type any identifier they
  // remember; sort by name for predictable ordering.
  const pickerFiltered = useMemo(() => {
    const q = assetPickerFilter.trim().toLowerCase();
    const base = q
      ? assets.filter((a) =>
          `${a.name} ${a.catalogId ?? ""} ${a.kindId ?? ""}`.toLowerCase().includes(q),
        )
      : assets;
    return [...base].sort((a, b) => a.name.localeCompare(b.name));
  }, [assets, assetPickerFilter]);

  // Esc closes the picker; matches the rest of this codebase's modal
  // conventions (Asset3DV3Editor's New Asset modal handles its own
  // backdrop-click close the same way).
  useEffect(() => {
    if (!assetPickerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAssetPickerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [assetPickerOpen]);

  const handleRemoveBinding = async (bindingId: string): Promise<void> => {
    if (!window.confirm("Remove this binding?")) return;
    try {
      await deleteComponentBindingApi(bindingId);
      if (selected) await reloadBindings(selected.id);
    } catch (e) {
      setError(`Remove binding failed: ${String(e)}`);
    }
  };

  const handlePatchBinding = async (
    bindingId: string,
    patch: ComponentBindingUpdatePayload,
  ): Promise<void> => {
    try {
      await updateComponentBindingApi(bindingId, patch);
      if (selected) await reloadBindings(selected.id);
    } catch (e) {
      setError(`Update binding failed: ${String(e)}`);
    }
  };

  return (
    // SHELL_STYLE (shared with Asset3DV3Editor + KindsEditor) uses CSS
    // grid with `minmax(0, 1fr)` for the main column so the aside and
    // main both stay bounded by the viewport — required for their own
    // overflow-y: auto to actually scroll when the catalog grows.
    <div style={SHELL_STYLE}>
      {/* LEFT: components list */}
      <aside style={ASIDE_STYLE}>
        {isBindingDev && (
          <button
            type="button"
            onClick={handleCreateComponent}
            style={{ ...PRIMARY_BUTTON, width: "100%", marginBottom: 6 }}
          >
            + New Component
          </button>
        )}
        <input
          type="text"
          placeholder="filter by name / type"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          style={{ ...inputStyle, marginBottom: 6 }}
        />
        <div style={{ fontSize: 10, color: "#4b5563", marginBottom: 6 }}>
          {filtered.length} of {components.length} components
        </div>
        {filtered.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setSelectedId(c.id)}
            style={asideItemStyle(c.id === selectedId)}
          >
            <div style={{ fontWeight: 700 }}>{c.name}</div>
            <div style={{ fontSize: 10, color: "#6b7280" }}>
              kind: {c.kindId ?? ""}
            </div>
          </button>
        ))}
      </aside>

      {/* RIGHT: detail */}
      <main style={{ ...MAIN_BODY_STYLE }}>
        {error && (
          <div style={ERROR_BANNER}>
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              style={{
                background: "transparent",
                color: ERROR_BANNER.color,
                border: "none",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              ×
            </button>
          </div>
        )}
        {!selected && (
          <div style={{ opacity: 0.6, padding: 16, fontSize: 13 }}>
            Pick a Component from the left, or click "+ New Component".
          </div>
        )}
        {selected && (
          <>
            <header
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 8,
              }}
            >
              <h2
                style={{
                  margin: 0,
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 16,
                }}
              >
                {selected.name}
              </h2>
              {isBindingDev && (
                <button
                  type="button"
                  onClick={handleDeleteComponent}
                  style={btnDanger}
                >
                  Delete Component
                </button>
              )}
            </header>

            <div style={SECTION_LABEL}>Identity</div>
            <IdentityField
              label="name"
              value={selected.name}
              onCommit={(v) => handlePatchComponent({ name: v })}
            />
            {/* kind_id / brand / model are catalog-classification fields
                edited only in Binding dev; PHY Editor only sees them. */}
            {isBindingDev && (
              <>
                <KindSelectField
                  label="kind_id"
                  value={selected.kindId ?? ""}
                  kinds={kinds}
                  onCommit={(v) => handlePatchComponent({ kindId: v })}
                />
                <IdentityField
                  label="brand"
                  value={selected.brand ?? ""}
                  onCommit={(v) =>
                    handlePatchComponent({ brand: v ? v : null })
                  }
                />
                <IdentityField
                  label="model"
                  value={selected.model ?? ""}
                  onCommit={(v) =>
                    handlePatchComponent({ model: v ? v : null })
                  }
                />
                <DomainToggleField
                  capabilities={selected.physicsCapabilities ?? []}
                  onCommit={(next) =>
                    handlePatchComponent({ physicsCapabilities: next })
                  }
                />
              </>
            )}

            <div style={SECTION_LABEL}>3D preview</div>
            <ComponentPreview3D
              bindings={bindings}
              assetById={assetById}
              parentComponent={selected ?? null}
              selectedBindingId={selectedBindingId}
              onSelectBinding={setSelectedBindingId}
              onPatchBinding={handlePatchBinding}
            />

            <div
              style={{
                ...SECTION_LABEL,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span>Bindings ({childBindings.length})</span>
                {isBindingDev && (
                  <button
                    type="button"
                    onClick={handleAddBinding}
                    style={btnPrimary}
                    disabled={assets.length === 0}
                    title={assets.length === 0 ? "No Asset3D available" : ""}
                  >
                    + Add binding
                  </button>
                )}
              </div>
              {bindingsLoading && (
                <div style={{ fontSize: 11, opacity: 0.6 }}>Loading…</div>
              )}
              {!bindingsLoading && childBindings.length === 0 && (
                <div style={{ fontSize: 11, opacity: 0.6, padding: 8 }}>
                  No bindings yet. Click "+ Add binding" to attach an Asset3D.
                </div>
              )}
              {childBindings.length > 0 && (
                <table
                  style={{
                    width: "100%",
                    fontSize: 11,
                    fontFamily: "ui-monospace, monospace",
                    marginTop: 8,
                    borderCollapse: "collapse",
                  }}
                >
                  <thead>
                    <tr style={{ borderBottom: "1px solid #e9ece9" }}>
                      <th style={thStyle}>role</th>
                      <th style={thStyle}>asset3d</th>
                      <th style={thStyle} title="Pick a parent binding to attach this one to. Children move/rotate together with their parent — picking a root and parenting everything else under it lets the whole composite move as a unit when placed as an object.">parent</th>
                      <th style={thStyle}>x mm</th>
                      <th style={thStyle}>y mm</th>
                      <th style={thStyle}>z mm</th>
                      <th style={thStyle}>rx°</th>
                      <th style={thStyle}>ry°</th>
                      <th style={thStyle}>rz°</th>
                      {isBindingDev && <th style={thStyle}></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {childBindings.map((b) => (
                      <BindingRow
                        key={b.id}
                        binding={b}
                        assets={assets}
                        siblingBindings={childBindings}
                        mode={mode}
                        isSelected={b.id === selectedBindingId}
                        onSelect={() => setSelectedBindingId(b.id)}
                        onPatch={(patch) => handlePatchBinding(b.id, patch)}
                        onRemove={() => handleRemoveBinding(b.id)}
                      />
                    ))}
                  </tbody>
                </table>
              )}
          </>
        )}
      </main>

      {assetPickerOpen && (
        <div
          onClick={() => setAssetPickerOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#ffffff",
              color: "#1f2937",
              minWidth: 480,
              maxWidth: 640,
              width: "60vw",
              maxHeight: "80vh",
              border: "1px solid #d8ded8",
              borderRadius: 4,
              padding: 16,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              minHeight: 0,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Pick an Asset3D</h3>
              <span style={{ fontSize: 11, color: "#6b7280" }}>
                {pickerFiltered.length} of {assets.length}
              </span>
            </div>
            <input
              autoFocus
              placeholder="filter by name / catalog_id / kind"
              value={assetPickerFilter}
              onChange={(e) => setAssetPickerFilter(e.target.value)}
              style={inputStyle}
            />
            <div
              style={{
                overflowY: "auto",
                border: "1px solid #e9ece9",
                borderRadius: 2,
                minHeight: 0,
                flex: 1,
              }}
            >
              {pickerFiltered.length === 0 && (
                <div style={{ padding: 16, color: "#6b7280", fontSize: 11 }}>
                  No assets match the filter.
                </div>
              )}
              {pickerFiltered.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => void handlePickAsset(asset.id)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    alignItems: "flex-start",
                    width: "100%",
                    padding: "8px 10px",
                    border: "none",
                    borderBottom: "1px solid #f3f4f1",
                    background: "#ffffff",
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "inherit",
                    color: "#1f2937",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "#f9fafb";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "#ffffff";
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: 12 }}>{asset.name}</span>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    {asset.catalogId && (
                      <code style={{ fontSize: 10, color: "#6b7280" }}>{asset.catalogId}</code>
                    )}
                    {asset.kindId && asset.kindId !== "none" && (
                      <span
                        style={{
                          fontSize: 10,
                          color: "#4ec9b0",
                          fontFamily: "ui-monospace, monospace",
                        }}
                      >
                        {asset.kindId}
                      </span>
                    )}
                    {assetDomains(asset).map((d) => (
                      <DomainBadge key={d} domain={d} />
                    ))}
                  </div>
                </button>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
              <button
                type="button"
                onClick={() => setAssetPickerOpen(false)}
                style={btnPrimary}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Single-line text field with on-blur commit. Local draft state mirrors
 * the prop until blur (so the user's typing isn't lost on re-render).
 */
function IdentityField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "60px 1fr",
        gap: 8,
        alignItems: "center",
        marginBottom: 4,
        fontSize: 12,
      }}
    >
      <span style={{ color: "#4b5563", fontFamily: "ui-monospace, monospace" }}>
        {label}
      </span>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
        }}
        style={{ ...inputStyle, width: "100%" }}
      />
    </div>
  );
}

/** Drop-down picker for Component.kindId / Asset3D.kindId. Options
 *  come from the Kind registry (/api/kinds), grouped by domain. The
 *  current value is appended as a free-text fallback when it doesn't
 *  match any registered kind — needed for legacy values like
 *  ``optical_component`` / ``optical_table`` that pre-date the
 *  registry. */
function KindSelectField({
  label,
  value,
  kinds,
  onCommit,
}: {
  label: string;
  value: string;
  kinds: Array<{ name: string; displayName: string; domain: string }>;
  onCommit: (v: string) => void;
}) {
  const byDomain = useMemo(() => {
    const out: Record<string, typeof kinds> = { optical: [], rf: [], mechanical: [] };
    for (const k of kinds) {
      (out[k.domain] ?? (out[k.domain] = [])).push(k);
    }
    for (const arr of Object.values(out)) arr.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [kinds]);
  const valueInRegistry = kinds.some((k) => k.name === value);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "60px 1fr",
        gap: 8,
        alignItems: "center",
        marginBottom: 4,
        fontSize: 12,
      }}
    >
      <span style={{ color: "#4b5563", fontFamily: "ui-monospace, monospace" }}>
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onCommit(e.target.value)}
        style={{ ...inputStyle, width: "100%" }}
      >
        {!valueInRegistry && value && (
          <option value={value}>{value} (legacy)</option>
        )}
        {!value && <option value="">(unset)</option>}
        {(["optical", "rf", "mechanical"] as const).map((domain) =>
          (byDomain[domain] ?? []).length > 0 ? (
            <optgroup key={domain} label={domain}>
              {byDomain[domain].map((k) => (
                <option key={k.name} value={k.name}>
                  {k.name}
                </option>
              ))}
            </optgroup>
          ) : null,
        )}
      </select>
    </div>
  );
}

/** Multi-select domain chips for Component.physicsCapabilities. The
 *  composer-domain classifier reads this list first, so checking
 *  "optical" forces a Component into the Optical rail even if its
 *  componentType doesn't map to a known optical kind. */
type DomainCapability = Extract<PhysicsCapability, "optical" | "rf" | "mechanical">;

function DomainToggleField({
  capabilities,
  onCommit,
}: {
  capabilities: ReadonlyArray<PhysicsCapability>;
  onCommit: (next: PhysicsCapability[]) => void;
}) {
  const set = new Set<PhysicsCapability>(capabilities);
  const toggle = (cap: DomainCapability) => {
    const next = new Set<PhysicsCapability>(set);
    if (next.has(cap)) next.delete(cap);
    else next.add(cap);
    onCommit([...next]);
  };
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "60px 1fr",
        gap: 8,
        alignItems: "center",
        marginBottom: 4,
        fontSize: 12,
      }}
    >
      <span
        style={{ color: "#4b5563", fontFamily: "ui-monospace, monospace" }}
        title="physicsCapabilities — drives which composer rail (Optical / RF / Mechanical) this component appears under. Multi-select: a component can belong to several."
      >
        domain
      </span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(["optical", "rf", "mechanical"] as const).map((cap) => {
          const on = set.has(cap);
          return (
            <button
              key={cap}
              type="button"
              onClick={() => toggle(cap)}
              style={{
                fontSize: 11,
                padding: "3px 10px",
                background: on ? "#0f766e" : "transparent",
                color: on ? "#ffffff" : "#242726",
                border: `1px solid ${on ? "#115e59" : "#d8ded8"}`,
                borderRadius: 4,
                cursor: "pointer",
                fontFamily: "'Menlo', 'Consolas', monospace",
              }}
            >
              {cap}
            </button>
          );
        })}
        {capabilities.length === 0 && (
          <span style={{ fontSize: 10, color: "#9ca3af" }}>
            (none — falls back to componentType inference)
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * One row per child binding. Six pose fields commit on blur; the asset
 * label is read-only (target is immutable per backend contract — to swap
 * asset, remove + re-add).
 */
function BindingRow({
  binding,
  assets,
  siblingBindings,
  mode,
  isSelected,
  onSelect,
  onPatch,
  onRemove,
}: {
  binding: ComponentBinding;
  assets: Asset3D[];
  /** Every binding in the same component, including this one. Used to
   *  populate the parent dropdown (filtering out self + descendants to
   *  prevent cycles). */
  siblingBindings: ComponentBinding[];
  mode: ComponentsV2EditorMode;
  isSelected: boolean;
  onSelect: () => void;
  onPatch: (patch: ComponentBindingUpdatePayload) => void;
  onRemove: () => void;
}) {
  const isBindingDev = mode === "binding-dev";
  const asset = assets.find((a) => a.id === binding.asset3dId);
  // Candidate parents = every other binding except this one's own
  // descendants. Picking a descendant would create a cycle the backend
  // would reject; filtering here just keeps the UI honest.
  const cycleBlocked = useMemo(
    () => descendantBindingIds(siblingBindings, binding.id),
    [siblingBindings, binding.id],
  );
  const parentOptions = useMemo(
    () => siblingBindings.filter(
      (b) => b.id !== binding.id && !cycleBlocked.has(b.id),
    ),
    [siblingBindings, binding.id, cycleBlocked],
  );
  // Per-axis lock: each of the 6 pose fields has its own 🔒/🔓.
  // - 🔓 = axis is in `tunableAxes`. Catalog field editable, AND when
  //        placed as object the axis can be overridden per-instance
  //        via bindingOverrides.
  // - 🔒 = axis is NOT in `tunableAxes`. Catalog field disabled, AND
  //        baked-in at object-level (no override).
  // Reuses the existing schema (alembic 0062 tunableAxes) so the lock
  // state propagates to per-instance object editors via the same
  // contract.
  const tunable = (binding.tunableAxes ?? {}) as Record<string, unknown>;
  const isAxisLocked = (key: string): boolean => !(key in tunable);
  const toggleAxisLock = (key: string): void => {
    const next: Record<string, ComponentBinding["tunableAxes"][string]> = {
      ...(binding.tunableAxes ?? {}),
    };
    if (key in next) {
      delete next[key];
    } else {
      // Default to "parent" frame ??localXMm/RyDeg/etc. are already
      // stored as offsets in the parent binding's frame, so an
      // override delta in the same frame is the least-surprising
      // default. User can edit min/max later if a slider UI surfaces.
      next[key] = { frame: "parent" };
    }
    onPatch({ tunableAxes: next });
  };

  const poseField = (
    key: keyof Pick<
      ComponentBinding,
      | "localXMm"
      | "localYMm"
      | "localZMm"
      | "localRxDeg"
      | "localRyDeg"
      | "localRzDeg"
    >,
  ) => {
    const locked = isAxisLocked(key);
    return (
      <td style={tdStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleAxisLock(key); }}
            title={locked
              ? `${key} locked: catalog field is read-only and the axis is baked-in at object-level. Click to unlock.`
              : `${key} unlocked: catalog field is editable and the axis can be tweaked per-instance when this component is placed as an object. Click to lock.`}
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              fontSize: 11,
              lineHeight: 1,
              padding: "0 2px",
              color: locked ? "#b45309" : "#9ca3af",
            }}
          >
            {locked ? "🔒" : "🔓"}
          </button>
          <NumberField
            value={binding[key]}
            onCommit={(v) => onPatch({ [key]: v } as ComponentBindingUpdatePayload)}
            disabled={locked}
          />
        </div>
      </td>
    );
  };
  return (
    <tr
      onClick={onSelect}
      style={{
        cursor: "pointer",
        background: isSelected ? "#fef3c7" : "transparent",
      }}
    >
      <td style={tdStyle}>
        <TextField
          value={binding.role}
          onCommit={(v) => onPatch({ role: v })}
        />
      </td>
      <td
        style={{
          ...tdStyle,
          color: asset ? "#374151" : "#f87171",
          maxWidth: 240,
        }}
        title={asset
          ? `${asset.catalogId ?? "(no catalog_id)"} — ${asset.name}`
          : `missing asset ${binding.asset3dId ?? ""}`}
      >
        {asset ? (
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2, gap: 2 }}>
            <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {asset.name}
            </span>
            {asset.catalogId && (
              <code style={{ fontSize: 10, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {asset.catalogId}
              </code>
            )}
            <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
              {assetDomains(asset).map((d) => (
                <DomainBadge key={d} domain={d} />
              ))}
            </div>
          </div>
        ) : (
          `⚠ ${binding.asset3dId ?? "(none)"}`
        )}
      </td>
      <td style={tdStyle}>
        <select
          value={binding.parentBindingId ?? ""}
          onChange={(e) => {
            const next = e.target.value === "" ? null : e.target.value;
            onPatch({ parentBindingId: next });
          }}
          style={{
            ...inputStyle,
            width: 110,
            padding: "3px 4px",
          }}
          title={
            binding.parentBindingId
              ? "Child binding — pose is relative to the parent's body frame. Moving the parent moves this one with it."
              : "Root binding — pose is in the component's root frame. Other bindings can be parented under this one."
          }
        >
          <option value="">(root)</option>
          {parentOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.role || p.id.slice(0, 6)}
            </option>
          ))}
        </select>
      </td>
      {poseField("localXMm")}
      {poseField("localYMm")}
      {poseField("localZMm")}
      {poseField("localRxDeg")}
      {poseField("localRyDeg")}
      {poseField("localRzDeg")}
      {isBindingDev && (
        <td style={tdStyle}>
          <button
            type="button"
            onClick={onRemove}
            style={{
              background: "transparent",
              color: "#f87171",
              border: "none",
              cursor: "pointer",
              fontSize: 14,
            }}
            title="Remove binding"
          >
            ✗
          </button>
        </td>
      )}
    </tr>
  );
}

function NumberField({
  value,
  onCommit,
  disabled = false,
}: {
  value: number;
  onCommit: (v: number) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <input
      type="number"
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const parsed = Number(draft);
        if (Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
        else setDraft(String(value));
      }}
      style={{
        ...inputStyle,
        width: 70,
        textAlign: "right",
        background: disabled ? "#f3f4f1" : inputStyle.background,
        color: disabled ? "#9ca3af" : inputStyle.color,
        cursor: disabled ? "not-allowed" : "text",
      }}
      title={disabled ? "Pose locked — click the 🔒 to unlock" : undefined}
    />
  );
}

function TextField({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      style={{ ...inputStyle, width: 110 }}
    />
  );
}

const stlLoader = new STLLoader();
const gltfLoader = new GLTFLoader();

/**
 * 3D preview of a Component: loads each ``targetKind="asset"`` binding's
 * STL/GLB at its local pose and renders the composed result in a dark
 * three.js scene with bright fill lighting. Sub-component bindings are
 * shown as small placeholder wireframe boxes so the user still sees their
 * position (recursive sub-component asset rendering is a follow-up).
 */
function ComponentPreview3D({
  bindings,
  assetById,
  parentComponent,
  selectedBindingId,
  onSelectBinding,
  onPatchBinding,
}: {
  bindings: ComponentBinding[];
  assetById: Map<string, Asset3D>;
  /** The Component being edited. Procedural builders (Glan prism etc.)
   *  read sizing properties from here, so passing it lets a "Glan-Laser
   *  Calcite Prism" component render with the right dimensions. */
  parentComponent: ComponentItem | null;
  selectedBindingId: string | null;
  onSelectBinding: (id: string | null) => void;
  onPatchBinding: (id: string, patch: ComponentBindingUpdatePayload) => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  // Probe-beam visualization state (PBS preview only). Position is in
  // body-frame mm; direction is a free vector (normalized at use site);
  // polarizationDeg is the s↔p mix where 0° = pure s (along body +Y)
  // and 90° = pure p (along body +X).
  const [beamPos, setBeamPos] = useState({ x: 0, y: 0, z: -40 });
  const [beamDir, setBeamDir] = useState({ x: 0, y: 0, z: 1 });
  const [beamPolDeg, setBeamPolDeg] = useState(45);
  const beamRef = useRef({ pos: beamPos, dir: beamDir, polDeg: beamPolDeg });
  beamRef.current = { pos: beamPos, dir: beamDir, polDeg: beamPolDeg };
  // Refs so the long-lived scene useEffect doesn't have to rebuild when
  // the selection / callbacks change.
  const selectedBindingIdRef = useRef(selectedBindingId);
  const bindingsRef = useRef(bindings);
  const onPatchBindingRef = useRef(onPatchBinding);
  const onSelectBindingRef = useRef(onSelectBinding);
  selectedBindingIdRef.current = selectedBindingId;
  bindingsRef.current = bindings;
  onPatchBindingRef.current = onPatchBinding;
  onSelectBindingRef.current = onSelectBinding;
  // The gizmo pivot is the orientation control: its local rotation matches
  // the selected binding's Euler triple. PBS beam visualization (when the
  // bound asset is kind=pbs) is attached to it so the +Z incoming /
  // transmitted and +X reflected arrows rotate together with the device.
  const gizmoPivotRef = useRef<THREE.Group | null>(null);
  const rebuildGizmoRef = useRef<() => void>(() => {});
  // Per-binding pivot lookup, refreshed each scene rebuild. rebuildGizmo
  // uses it to re-parent the gizmo under the selected binding's parent
  // chain so orientation drags compose correctly across nested levels.
  const pivotByBindingIdRef = useRef<Map<string, THREE.Object3D>>(new Map());
  // Probe-beam visualization lives in component frame (under `root`) so
  // the beam is traced through *every* binding's faces, not just the
  // selected one. Rebuilt when bindings or beam controls change.
  const probeBeamGroupRef = useRef<THREE.Group | null>(null);
  const rebuildProbeBeamRef = useRef<() => void>(() => {});
  // Camera-pose snapshot across scene rebuilds. Pose edits in the
  // bindings table change `bindings`, which retriggers the big scene
  // useEffect — without this the camera would re-fit on every keystroke
  // and the user would lose whatever view they'd orbited to. We only
  // re-fit when the user picks a different component (forComponentId
  // mismatch).
  const cameraStateRef = useRef<{
    position: THREE.Vector3;
    target: THREE.Vector3;
    near: number;
    far: number;
    forComponentId: string | null;
  } | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;
    let cancelled = false;

    const width = Math.max(420, mount.clientWidth || 760);
    const height = 360;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#07111f");
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    scene.add(new THREE.HemisphereLight("#dbeafe", "#1a2435", 2.4));
    scene.add(new THREE.AmbientLight("#ffffff", 0.5));
    const key = new THREE.DirectionalLight("#ffffff", 2.4);
    key.position.set(30, 40, 60);
    scene.add(key);
    const fill = new THREE.DirectionalLight("#ffe7c4", 1.2);
    fill.position.set(-40, 20, -30);
    scene.add(fill);
    const rim = new THREE.DirectionalLight("#bfdbfe", 0.9);
    rim.position.set(0, -50, 30);
    scene.add(rim);

    const root = new THREE.Group();
    scene.add(root);

    // Gizmo pivot — placed at the selected binding's local position and
    // rotated by its Euler triple. Body axes triad lives inside it so
    // they follow the device as the user rotates.
    const gizmoPivot = new THREE.Group();
    root.add(gizmoPivot);
    gizmoPivotRef.current = gizmoPivot;

    // Probe-beam container — sits under root (component frame), so the
    // beam source/direction inputs are interpreted in component
    // coordinates and a single trace runs through every binding's
    // faces. Independent of binding selection.
    const probeBeamGroup = new THREE.Group();
    probeBeamGroup.name = "probe-beam";
    root.add(probeBeamGroup);
    probeBeamGroupRef.current = probeBeamGroup;

    // Bounding box of every mesh under `root` *except* the subtrees
    // in `skip`. Needed because both rebuildGizmo and rebuildProbeBeam
    // size their arrows off the scene bbox and must exclude each
    // other (and themselves) ??otherwise gizmo axes grown for one
    // bbox feed into the next bbox and the arrows grow unbounded
    // every time the user clicks between nested bindings.
    function bboxExcluding(skip: ReadonlySet<THREE.Object3D>): THREE.Box3 {
      const out = new THREE.Box3();
      const scratch = new THREE.Box3();
      const visit = (obj: THREE.Object3D): void => {
        if (skip.has(obj)) return;
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry) {
          mesh.updateWorldMatrix(true, false);
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
          scratch.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
          out.union(scratch);
        }
        for (const child of obj.children) visit(child);
      };
      for (const child of root.children) visit(child);
      return out;
    }

    function fitCamera() {
      const bbox = new THREE.Box3().setFromObject(root);
      if (bbox.isEmpty()) {
        camera.position.set(60, -60, 60);
        controls.target.set(0, 0, 0);
        camera.near = 0.1;
        camera.far = 2000;
        camera.updateProjectionMatrix();
        controls.update();
        return;
      }
      bbox.expandByScalar(8);
      const center = bbox.getCenter(new THREE.Vector3());
      const size = Math.max(...bbox.getSize(new THREE.Vector3()).toArray(), 8);
      camera.position.set(center.x + size * 0.9, center.y - size * 1.2, center.z + size * 0.75);
      camera.near = Math.max(size / 1200, 0.01);
      camera.far = size * 120;
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
    }

    function poseFromBinding(b: ComponentBinding): THREE.Object3D {
      const pivot = new THREE.Group();
      pivot.position.set(b.localXMm, b.localYMm, b.localZMm);
      pivot.rotation.set(
        THREE.MathUtils.degToRad(b.localRxDeg),
        THREE.MathUtils.degToRad(b.localRyDeg),
        THREE.MathUtils.degToRad(b.localRzDeg),
        "XYZ",
      );
      return pivot;
    }

    // Build the body-axes triad + PBS beam viz inside `gizmoPivot`. Sized
    // off the loaded scene so it's visible without dwarfing it.
    function rebuildGizmo() {
      while (gizmoPivot.children.length > 0) {
        const c = gizmoPivot.children[0];
        gizmoPivot.remove(c);
        c.traverse((node) => {
          const m = node as THREE.Mesh;
          m.geometry?.dispose();
          const mat = m.material;
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else mat?.dispose?.();
        });
      }
      const selId = selectedBindingIdRef.current;
      const selBinding = selId
        ? bindingsRef.current.find((b) => b.id === selId)
        : null;
      if (!selBinding) return;

      // Re-parent the gizmo under the selected binding's parent so its
      // local pose composes through the binding tree (matches how the
      // binding's own pivot is attached). Root-level bindings land
      // directly under the scene root, same as before nesting existed.
      const parentBindingId = selBinding.parentBindingId;
      const desiredParent = parentBindingId
        ? pivotByBindingIdRef.current.get(parentBindingId) ?? root
        : root;
      if (gizmoPivot.parent !== desiredParent) {
        gizmoPivot.parent?.remove(gizmoPivot);
        desiredParent.add(gizmoPivot);
      }

      // Place / orient the pivot to match the binding's pose.
      gizmoPivot.position.set(selBinding.localXMm, selBinding.localYMm, selBinding.localZMm);
      gizmoPivot.rotation.set(
        THREE.MathUtils.degToRad(selBinding.localRxDeg),
        THREE.MathUtils.degToRad(selBinding.localRyDeg),
        THREE.MathUtils.degToRad(selBinding.localRzDeg),
        "XYZ",
      );

      // Size from scene bbox, skipping the gizmo itself AND the
      // probe-beam arrows (their length is computed from the same
      // bbox, so including them would create a positive-feedback
      // loop where each rebuild bumps the arrow size).
      const bbox = bboxExcluding(new Set([gizmoPivot, probeBeamGroup]));
      const size = bbox.isEmpty()
        ? 30
        : Math.max(...bbox.getSize(new THREE.Vector3()).toArray(), 20);
      const armLen = Math.max(size * 0.6, 25);

      // Body axes triad (X red, Y green, Z blue).
      const axes: Array<[THREE.Vector3, string]> = [
        [new THREE.Vector3(1, 0, 0), "#ef4444"],
        [new THREE.Vector3(0, 1, 0), "#22c55e"],
        [new THREE.Vector3(0, 0, 1), "#3b82f6"],
      ];
      for (const [dir, color] of axes) {
        const shaftLen = armLen * 0.85;
        const shaftRad = armLen * 0.015;
        const shaft = new THREE.Mesh(
          new THREE.CylinderGeometry(shaftRad, shaftRad, shaftLen, 12),
          new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }),
        );
        shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        shaft.position.copy(dir.clone().multiplyScalar(shaftLen / 2));
        shaft.renderOrder = 50;
        gizmoPivot.add(shaft);
        const headLen = armLen * 0.13;
        const headRad = armLen * 0.045;
        const head = new THREE.Mesh(
          new THREE.ConeGeometry(headRad, headLen, 16),
          new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }),
        );
        head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        head.position.copy(dir.clone().multiplyScalar(shaftLen + headLen / 2));
        head.renderOrder = 50;
        gizmoPivot.add(head);
      }

      // (Probe beam viz moved out — now rendered by rebuildProbeBeam()
      // under `probeBeamGroup` so the beam traces through every binding
      // in the component, not just the selected one.)
    }
    rebuildGizmoRef.current = rebuildGizmo;

    /** Trace the probe beam through every binding's faces in component
     *  frame. At each hit: draw the incoming segment to the hit, a
     *  short reflect arrow off the face normal, then continue the
     *  transmit ray through subsequent faces. Up to MAX_HITS steps to
     *  avoid runaway loops on coincident planes.
     *
     *  Coordinate system: pos / dir from `beamRef.current` are in
     *  component (root) frame. Each binding's face position + normal
     *  is computed via pivot.matrixWorld so nested parent transforms
     *  are honoured automatically.
     *
     *  Colours mirror the previous per-binding probe:
     *    incoming/transmit segments = orange #fb923c → gold #fde68a
     *    reflect arrow at each hit  = magenta #d946ef
     */
    function rebuildProbeBeam() {
      const group = probeBeamGroupRef.current;
      if (!group) return;
      while (group.children.length > 0) {
        const c = group.children[0];
        group.remove(c);
        c.traverse((node) => {
          const m = node as THREE.Mesh;
          m.geometry?.dispose();
          const mat = m.material;
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else mat?.dispose?.();
        });
      }

      const beam = beamRef.current;
      const dirInit = new THREE.Vector3(beam.dir.x, beam.dir.y, beam.dir.z);
      if (dirInit.lengthSq() < 1e-12) dirInit.set(0, 0, 1);
      dirInit.normalize();
      const sourceInit = new THREE.Vector3(beam.pos.x, beam.pos.y, beam.pos.z);

      // Size the arrows off the current scene bbox so they're visible
      // without dwarfing the geometry. Skip both groups recursively
      // (gizmoPivot may be nested under a binding pivot when the
      // selected binding has a parent ??see bboxExcluding for why
      // a direct sibling filter wasn't enough).
      const bbox = bboxExcluding(new Set([gizmoPivot, probeBeamGroup]));
      const size = bbox.isEmpty()
        ? 30
        : Math.max(...bbox.getSize(new THREE.Vector3()).toArray(), 20);
      const armLen = Math.max(size * 0.6, 25);
      const beamRad = Math.max(size * 0.006, 0.4);
      const reflectArmLen = armLen * 0.6;

      // Collect every (face, owner binding) triple along with its
      // world-frame pose AND its aperture + tangent basis so the trace
      // can (a) intersect the face plane, (b) check the hit is inside
      // the aperture (else the element doesn't see the beam), and (c)
      // build the body-frame (x, x', y, y', 1) state vector for the
      // 5×5 ABCD transitions defined on the asset.
      root.updateMatrixWorld(true);
      type RawFace = {
        id: string;
        positionMmBodyLocal: { x: number; y: number; z: number };
        normalBodyLocal?: { x: number; y: number; z: number } | null;
        apertureMm?: number;
        apertureShape?: "circle" | "rectangle" | "ellipse";
        apertureWidthMm?: number | null;
        apertureHeightMm?: number | null;
      };
      type Transition = {
        in: string;
        out: string | string[];
        op?: string;
        matrix5x5?: number[][] | null;
        via?: string[] | null;
      };
      type FaceHit = {
        bindingId: string;
        faceId: string;
        pivot: THREE.Object3D;
        rawFace: RawFace;
        posWorld: THREE.Vector3;
        normalWorld: THREE.Vector3;
        // Tangent basis perpendicular to the face normal (world frame).
        // Used for the aperture inside-test.
        uWorld: THREE.Vector3;
        vWorld: THREE.Vector3;
      };
      const allFaces: FaceHit[] = [];
      const facesByBinding = new Map<string, FaceHit[]>();
      const transitionsByBinding = new Map<string, Transition[]>();
      for (const [bId, pivot] of pivotByBindingIdRef.current) {
        const binding = bindingsRef.current.find((b) => b.id === bId);
        if (!binding || binding.targetKind !== "asset" || !binding.asset3dId) continue;
        const asset = assetById.get(binding.asset3dId);
        if (!asset || !asset.faces) continue;
        transitionsByBinding.set(
          bId,
          (asset.transitions ?? []) as unknown as Transition[],
        );
        const bindingFaces: FaceHit[] = [];
        for (const rawFace of asset.faces as unknown as RawFace[]) {
          const p = rawFace.positionMmBodyLocal;
          const posWorld = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(pivot.matrixWorld);
          const n = rawFace.normalBodyLocal;
          const normalLocal = n
            ? new THREE.Vector3(n.x, n.y, n.z)
            : new THREE.Vector3(0, 0, 1);
          if (normalLocal.lengthSq() < 1e-12) normalLocal.set(0, 0, 1);
          normalLocal.normalize();
          const normalWorld = normalLocal.clone()
            .transformDirection(pivot.matrixWorld)
            .normalize();
          // Build a tangent basis perpendicular to the normal. Pick
          // body +x as the seed unless the normal is parallel to it
          // (then fall back to body +y) — keeps the basis consistent
          // across faces of the same asset for symmetric apertures.
          let seedBody = new THREE.Vector3(1, 0, 0);
          if (Math.abs(seedBody.dot(normalLocal)) > 0.99) {
            seedBody = new THREE.Vector3(0, 1, 0);
          }
          const uBody = seedBody.clone()
            .sub(normalLocal.clone().multiplyScalar(seedBody.dot(normalLocal)))
            .normalize();
          const vBody = normalLocal.clone().cross(uBody).normalize();
          const uWorld = uBody.clone().transformDirection(pivot.matrixWorld).normalize();
          const vWorld = vBody.clone().transformDirection(pivot.matrixWorld).normalize();
          const hit: FaceHit = {
            bindingId: bId,
            faceId: rawFace.id ?? "",
            pivot,
            rawFace,
            posWorld,
            normalWorld,
            uWorld,
            vWorld,
          };
          allFaces.push(hit);
          bindingFaces.push(hit);
        }
        facesByBinding.set(bId, bindingFaces);
      }

      // Aperture inside-test. Centerline must cross within the face's
      // declared aperture for the element to see the beam.
      // - circle:    x² + y² ≤ apertureMm²       (apertureMm = radius)
      // - rectangle: |x| ≤ W/2, |y| ≤ H/2         (W,H = width/height;
      //              fall back to 2·apertureMm when not declared)
      // - ellipse:   (x/(W/2))² + (y/(H/2))² ≤ 1
      const apertureContains = (face: FaceHit, hitWorld: THREE.Vector3): boolean => {
        const offset = hitWorld.clone().sub(face.posWorld);
        const x = offset.dot(face.uWorld);
        const y = offset.dot(face.vWorld);
        const ap = face.rawFace.apertureMm ?? 0;
        const shape = face.rawFace.apertureShape ?? "circle";
        if (ap <= 0) return true;  // no aperture declared → don't filter
        if (shape === "circle") return x * x + y * y <= ap * ap;
        const halfW = (face.rawFace.apertureWidthMm ?? ap * 2) * 0.5;
        const halfH = (face.rawFace.apertureHeightMm ?? ap * 2) * 0.5;
        if (shape === "rectangle") return Math.abs(x) <= halfW && Math.abs(y) <= halfH;
        // ellipse
        const ex = halfW > 0 ? x / halfW : 0;
        const ey = halfH > 0 ? y / halfH : 0;
        return ex * ex + ey * ey <= 1;
      };

      // Apply a 5×5 ABCD transition (in: face A → out: face B) to a
      // ray currently at `hitWorld` going `dirWorld`. Returns the
      // teleported (origin, direction) at the output face in world
      // frame, or null if the matrix can't be applied (degenerate
      // axis, missing output face, etc.).
      //
      // State vector convention: [x, θx, y, θy, 1] in BODY frame with
      // body +z as the optical axis. (x, y) are transverse offsets
      // from the face centre in mm; (θx, θy) are tilt angles in
      // radians measured from the +z axis ??derived from dir via
      // atan2 so they remain valid for arbitrary tilts (not just the
      // small-angle approximation). Output direction is reconstructed
      // with sin/cos so the same trigonometric round-trip holds.
      const applyMatrix5x5 = (
        face: FaceHit,
        transition: Transition,
        hitWorld: THREE.Vector3,
        dirWorld: THREE.Vector3,
      ): { origin: THREE.Vector3; direction: THREE.Vector3; outFaceId: string } | null => {
        const M = transition.matrix5x5;
        if (!M || M.length < 4 || M.some((row) => !row || row.length < 4)) return null;
        const outFaceId = Array.isArray(transition.out) ? transition.out[0] : transition.out;
        if (!outFaceId) return null;
        const outFace = facesByBinding.get(face.bindingId)?.find((f) => f.faceId === outFaceId);
        if (!outFace) return null;

        const pivot = face.pivot;
        const inverse = pivot.matrixWorld.clone().invert();
        const hitBody = hitWorld.clone().applyMatrix4(inverse);
        const dirBody = dirWorld.clone().transformDirection(inverse).normalize();
        if (Math.abs(dirBody.z) < 1e-6) return null;
        const sign = Math.sign(dirBody.z);

        const inPosBody = new THREE.Vector3(
          face.rawFace.positionMmBodyLocal.x,
          face.rawFace.positionMmBodyLocal.y,
          face.rawFace.positionMmBodyLocal.z,
        );
        const x = hitBody.x - inPosBody.x;
        const y = hitBody.y - inPosBody.y;
        // Tilt angles in radians from the optical axis. atan2 handles
        // any direction (including grazing) without the dx/dz blowup.
        const absZ = Math.abs(dirBody.z);
        const thetaX = Math.atan2(dirBody.x, absZ);
        const thetaY = Math.atan2(dirBody.y, absZ);

        const v = [x, thetaX, y, thetaY, 1];
        const row = (i: number) =>
          (M[i][0] ?? 0) * v[0] + (M[i][1] ?? 0) * v[1] + (M[i][2] ?? 0) * v[2]
          + (M[i][3] ?? 0) * v[3] + (M[i][4] ?? 0) * v[4];
        const xOut = row(0);
        const thetaXOut = row(1);
        const yOut = row(2);
        const thetaYOut = row(3);

        const outPosBody = new THREE.Vector3(
          outFace.rawFace.positionMmBodyLocal.x + xOut,
          outFace.rawFace.positionMmBodyLocal.y + yOut,
          outFace.rawFace.positionMmBodyLocal.z,
        );
        // Reconstruct direction from output tilts via sin/cos.
        //
        // Sign handling: θ_out is in the matrix's local frame where
        // +z_matrix is the beam's propagation direction. Body +z and
        // matrix +z are the same only when the beam already goes +z
        // (sign = +1). For a -z body beam the matrix frame has
        // matrix +z = body -z, so the transverse axes (body x, body
        // y) stay unflipped — only body z flips. Earlier code
        // multiplied the transverse components by `sign` too, which
        // inverted the focusing direction for -z beams (a positive
        // lens looked divergent).
        const sinX = Math.sin(thetaXOut);
        const sinY = Math.sin(thetaYOut);
        const cosZSquared = Math.max(0, 1 - sinX * sinX - sinY * sinY);
        const cosZ = Math.sqrt(cosZSquared);
        const newDirBody = new THREE.Vector3(sinX, sinY, sign * cosZ);
        if (newDirBody.lengthSq() < 1e-12) return null;
        newDirBody.normalize();

        const newOriginWorld = outPosBody.clone().applyMatrix4(pivot.matrixWorld);
        const newDirWorld = newDirBody.clone()
          .transformDirection(pivot.matrixWorld)
          .normalize();
        return { origin: newOriginWorld, direction: newDirWorld, outFaceId };
      };

      const makeBeam = (
        origin: THREE.Vector3,
        direction: THREE.Vector3,
        length: number,
        radius: number,
        color: string,
      ) => {
        const shaft = new THREE.Mesh(
          new THREE.CylinderGeometry(radius, radius, length, 12),
          new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }),
        );
        shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
        shaft.position.copy(origin).add(direction.clone().multiplyScalar(length / 2));
        shaft.renderOrder = 60;
        group.add(shaft);
        const head = new THREE.Mesh(
          new THREE.ConeGeometry(radius * 3, armLen * 0.12, 12),
          new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }),
        );
        head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
        head.position.copy(origin).add(direction.clone().multiplyScalar(length + armLen * 0.06));
        head.renderOrder = 60;
        group.add(head);
      };

      // Compute beam-local s and p unit vectors (jones.ts
      // beam_local_sp convention). Reused by drawPolMark and by the
      // pbs power split.
      const beamLocalSP = (beamDir: THREE.Vector3): { s: THREE.Vector3; p: THREE.Vector3 } => {
        const d = beamDir.clone().normalize();
        const GLOBAL_UP = new THREE.Vector3(0, 0, 1);
        const FALLBACK_UP = new THREE.Vector3(1, 0, 0);
        const up = Math.abs(d.dot(GLOBAL_UP)) > 0.999 ? FALLBACK_UP : GLOBAL_UP;
        const s = up.clone().sub(d.clone().multiplyScalar(d.dot(up))).normalize();
        const p = d.clone().cross(s).normalize();
        return { s, p };
      };

      // Linear polarization mark — cyan double-headed arrow drawn
      // perpendicular to the beam direction at the start of each
      // segment. Length scales with sqrt(power) so a half-power beam
      // shows a noticeably shorter mark; orientation rotates when the
      // beam passes through a faraday rotator.
      const drawPolMark = (
        origin: THREE.Vector3, beamDir: THREE.Vector3, polDeg: number, power: number,
      ): void => {
        if (power < 0.01) return;  // skip near-dark beams
        const { s, p } = beamLocalSP(beamDir);
        const polRad = (polDeg * Math.PI) / 180;
        const polDir = s.clone().multiplyScalar(Math.cos(polRad))
          .add(p.clone().multiplyScalar(Math.sin(polRad)))
          .normalize();

        const scale = Math.sqrt(power);
        const markLen = Math.max(beamRad * 14, armLen * 0.08) * scale;
        const markRad = beamRad * 0.55 * scale;
        const color = "#06b6d4";

        const shaft = new THREE.Mesh(
          new THREE.CylinderGeometry(markRad, markRad, markLen, 10),
          new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }),
        );
        shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), polDir);
        shaft.position.copy(origin);
        shaft.renderOrder = 65;
        group.add(shaft);

        const coneLen = markLen * 0.25;
        const coneRad = markRad * 2.2;
        for (const sign of [1, -1] as const) {
          const axis = polDir.clone().multiplyScalar(sign);
          const cone = new THREE.Mesh(
            new THREE.ConeGeometry(coneRad, coneLen, 10),
            new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }),
          );
          cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
          cone.position.copy(origin).add(axis.clone().multiplyScalar(markLen / 2 + coneLen / 2));
          cone.renderOrder = 65;
          group.add(cone);
        }
      };

      // Power-aware beam draw: arrows share a single gold colour;
      // radius = base · √power so the visual cross-section is
      // proportional to power. Below 1 % the segment is skipped so the
      // viz doesn't spam invisibly-thin arrows.
      const BEAM_COLOR = "#fbbf24";
      const drawBeam = (
        origin: THREE.Vector3, direction: THREE.Vector3, length: number, power: number,
      ): void => {
        if (power < 0.01) return;
        const radius = Math.max(beamRad * Math.sqrt(power), beamRad * 0.15);
        makeBeam(origin, direction, length, radius, BEAM_COLOR);
      };

      // Trace the transmit chain forward up to MAX_HITS interfaces.
      // Reflect arrows draw only for reflective kinds — faraday /
      // lens / waveplate are transmissive in this preview and a
      // splitter arrow at their face normal misled the user into
      // reading a transmission as a split.
      const reflectiveKinds = new Set([
        "mirror", "pbs", "beam_splitter", "dichroic_mirror",
      ]);
      const MAX_HITS = 12;
      const EPS = 1e-4;
      let source = sourceInit.clone();
      let dir = dirInit.clone();
      let lastFaceKey: string | null = null;
      let hits = 0;
      // Polarization + power state evolve as the beam crosses
      // elements. Faraday adds rotationDeg with no power loss; pbs
      // splits power based on the projection of the polarization onto
      // the polarizer's transmission axis. Lens applies a paraxial
      // thin-lens kick to the direction so off-axis rays converge.
      let currentPolDeg = beam.polDeg;
      let currentPower = 1.0;
      const enteredFaradays = new Set<string>();

      // Pol mark at the very start of the beam.
      drawPolMark(sourceInit.clone(), dir, currentPolDeg, currentPower);

      while (hits < MAX_HITS) {
        let bestT = Infinity;
        let bestFace: FaceHit | null = null;
        for (const face of allFaces) {
          const faceKey = `${face.bindingId}/${face.faceId}`;
          if (faceKey === lastFaceKey) continue;  // skip the face we just exited
          const denom = dir.dot(face.normalWorld);
          if (Math.abs(denom) < 1e-9) continue;
          const t = face.posWorld.clone().sub(source).dot(face.normalWorld) / denom;
          if (t <= EPS || t >= bestT) continue;
          // Aperture filter: the element only sees the beam if the
          // centreline crosses inside its declared aperture. Beams
          // skirting past the clear aperture pass through unaffected
          // (the loop falls through to the next face hit).
          const candidateHit = source.clone().add(dir.clone().multiplyScalar(t));
          if (!apertureContains(face, candidateHit)) continue;
          bestT = t;
          bestFace = face;
        }
        if (!bestFace) break;

        const hitPoint = source.clone().add(dir.clone().multiplyScalar(bestT));
        // Incoming segment ??single gold colour, radius scales with
        // the current beam power.
        drawBeam(source.clone(), dir, bestT, currentPower);

        // Resolve the hit binding's asset kind so we can decide
        // whether to split power and whether to update the
        // polarization state.
        const hitBinding = bindingsRef.current.find((b) => b.id === bestFace!.bindingId);
        const hitAsset = hitBinding?.asset3dId ? assetById.get(hitBinding.asset3dId) : undefined;
        const hitKind = hitAsset?.kindId ?? null;

        // Power split per kind:
        //   mirror          — 100 % reflect (no transmit)
        //   dichroic_mirror — 100 % reflect (wavelength-dependent in
        //                       reality; we don't track lambda here)
        //   beam_splitter   — Malus' law against the anchor's
        //                       axisZ (p-pol / transmission axis,
        //                       per Phase 9.1 anchor convention).
        //                       Falls back to 50/50 if the asset
        //                       lacks tri-axis anchor data.
        // Anything not in reflectiveKinds defaults to full transmit
        // with no reject branch (lens, waveplate, faraday, ...).
        let transmitFrac = 1.0;
        let rejectFrac = 0.0;
        if (hitKind === "mirror" || hitKind === "dichroic_mirror") {
          transmitFrac = 0.0;
          rejectFrac = 1.0;
        } else if (hitKind === "beam_splitter") {
          // PBS / Glan-Laser: split by polarization. Transmission axis
          // = asset anchor's axisZ (in body frame). axisY is s-pol →
          // reflects, axisZ is p-pol → transmits.
          const anchors = (hitAsset?.anchors ?? []) as ReadonlyArray<{
            id?: string;
            axisZBodyLocal?: { x: number; y: number; z: number };
          }>;
          const matchAnchor = anchors.find(
            (a) => a.id === bestFace!.faceId && a.axisZBodyLocal,
          ) ?? anchors.find((a) => a.axisZBodyLocal);
          const zLocal = matchAnchor?.axisZBodyLocal;
          const pivot = pivotByBindingIdRef.current.get(bestFace.bindingId);
          if (zLocal && pivot) {
            pivot.updateWorldMatrix(true, false);
            const transAxisWorld = new THREE.Vector3(zLocal.x, zLocal.y, zLocal.z)
              .transformDirection(pivot.matrixWorld);
            const projected = transAxisWorld.clone()
              .sub(dir.clone().multiplyScalar(dir.dot(transAxisWorld)));
            if (projected.lengthSq() > 1e-12) {
              projected.normalize();
              const { s, p } = beamLocalSP(dir);
              const sComp = projected.dot(s);
              const pComp = projected.dot(p);
              const polAxisDeg = Math.atan2(pComp, sComp) * 180 / Math.PI;
              const deltaRad = (currentPolDeg - polAxisDeg) * Math.PI / 180;
              transmitFrac = Math.cos(deltaRad) ** 2;
              rejectFrac = 1 - transmitFrac;
            } else {
              // Beam direction parallel to transmission axis (rare
              // edge case) — fall back to 50/50 so the viz doesn't
              // silently flatten one branch.
              transmitFrac = 0.5;
              rejectFrac = 0.5;
            }
          } else {
            // Legacy / non-polarizing beam_splitter — keep equal split.
            transmitFrac = 0.5;
            rejectFrac = 0.5;
          }
        }

        // Reflect/reject arrow ??sized by the rejected power so the
        // viz reflects how much actually bounces off.
        if (hitKind && reflectiveKinds.has(hitKind) && rejectFrac > 0) {
          const reflectDir = dir.clone()
            .sub(bestFace.normalWorld.clone().multiplyScalar(2 * dir.dot(bestFace.normalWorld)))
            .normalize();
          drawBeam(hitPoint.clone(), reflectDir, reflectArmLen, currentPower * rejectFrac);
        }

        // Power into the transmit branch.
        currentPower *= transmitFrac;

        // Faraday: rotate polarization once per binding (on the first
        // face we hit for that binding). Both A and B faces will be
        // crossed in a straight-through transit but the rod only
        // contributes one rotation in total.
        if (hitKind === "faraday_rotator" && !enteredFaradays.has(bestFace.bindingId)) {
          enteredFaradays.add(bestFace.bindingId);
          const rotDeg = Number(
            (hitAsset?.defaultParams as { rotationDeg?: unknown } | undefined | null)?.rotationDeg ?? 45,
          );
          currentPolDeg += rotDeg;
        }

        // 5×5 ABCD transition. Pick a transition whose `in` matches
        // the hit face AND which carries a matrix5x5 (so we know how
        // to transform the state). For pbs assets that have a reject
        // transition with no matrix (op = glan_reject_s), `find`
        // prefers the matrix-bearing transmit branch.
        const transitions = transitionsByBinding.get(bestFace.bindingId) ?? [];
        let transition = transitions.find(
          (t) => t.in === bestFace!.faceId && t.matrix5x5 && t.matrix5x5.length >= 4,
        );
        // Lens fallback: when no explicit transition is defined, dispatch
        // through the generalized-ABCD operator (1aba98a-style). Build
        // mThinLens(focalLengthMm) on the fly from the asset's defaultParams
        // and apply it at the same face (input = output).
        if (!transition && (hitKind === "lens_plano_convex" || hitKind === "lens_biconvex")) {
          const focalLengthMm = (
            hitAsset?.defaultParams as { focalLengthMm?: number } | undefined | null
          )?.focalLengthMm;
          if (typeof focalLengthMm === "number" && Math.abs(focalLengthMm) > 1e-12) {
            const flat = mThinLens(focalLengthMm);
            const nested: number[][] = [
              flat.slice(0, 5),
              flat.slice(5, 10),
              flat.slice(10, 15),
              flat.slice(15, 20),
              flat.slice(20, 25),
            ];
            transition = {
              in: bestFace.faceId,
              out: bestFace.faceId,
              matrix5x5: nested,
            };
          }
        }
        const matrixResult = transition
          ? applyMatrix5x5(bestFace, transition, hitPoint, dir)
          : null;

        if (matrixResult) {
          // Teleport across the element: the matrix maps state at the
          // input face to state at the output face, accounting for
          // in-element translation + lens kick in one step. The next
          // hit search starts from the output face position.
          source = matrixResult.origin;
          dir = matrixResult.direction;
          lastFaceKey = `${bestFace.bindingId}/${matrixResult.outFaceId}`;
        } else {
          // No matrix → straight-through transit (lens with no matrix
          // and no focalLengthMm, faraday, waveplate, etc.). The
          // beam keeps going in the same direction from the hit
          // point onward.
          source = hitPoint;
          lastFaceKey = `${bestFace.bindingId}/${bestFace.faceId}`;
        }
        hits += 1;

        // Mark the polarization at the start of the next segment.
        drawPolMark(source.clone(), dir, currentPolDeg, currentPower);
      }

      // Final transmit arrow after the last hit (or the whole arrow if
      // no faces were hit at all).
      drawBeam(source.clone(), dir, armLen * 1.4, hits === 0 ? 1.0 : currentPower);
    }
    rebuildProbeBeamRef.current = rebuildProbeBeam;

    function makePlaceholder(label: string): THREE.Object3D {
      // Wireframe cube for bindings whose asset has no STL/GLB and no
      // procedural builder (fibers without nodes, EOMs with empty
      // filePath, etc.) — so users still see WHERE the binding sits and
      // can pick the row in the table. ~12 mm so it's visible at typical
      // camera zoom without dwarfing real assets.
      const g = new THREE.Group();
      g.name = `placeholder:${label}`;
      const cube = new THREE.Mesh(
        new THREE.BoxGeometry(12, 12, 12),
        new THREE.MeshStandardMaterial({ color: "#94a3b8", wireframe: true }),
      );
      g.add(cube);
      return g;
    }

    async function loadOne(b: ComponentBinding): Promise<THREE.Object3D | null> {
      if (b.targetKind === "subcomponent") {
        const pivot = poseFromBinding(b);
        const ph = new THREE.Mesh(
          new THREE.BoxGeometry(6, 6, 6),
          new THREE.MeshStandardMaterial({ color: "#a78bfa", wireframe: true }),
        );
        pivot.add(ph);
        return pivot;
      }
      if (b.targetKind !== "asset" || !b.asset3dId) return null;
      const asset = assetById.get(b.asset3dId);
      if (!asset) return null;
      const pivot = poseFromBinding(b);
      // Physics-face overlay (reflection coating for beam splitters, the
      // polarization-rotation plane for faraday rotators) so the isolator
      // preview shows how each piece acts on the beam — like the Optical
      // Link panel. Added to the pivot so it tracks the binding pose;
      // null for kinds without a physics face.
      const physicsFace = buildPhysicsFaceOverlay(asset);
      if (physicsFace) pivot.add(physicsFace);
      const filePath = asset.filePath ?? "";

      // Procedural assets — call the same builder the lab viewer uses.
      // Currently only the Glan-Laser calcite prism is procedural and
      // commonly appears as a binding; isolator-body bindings carry
      // their own STL via the housing asset, not this code path.
      if (filePath === GLAN_POLARIZER_PRISM_FILEPATH) {
        // Read the prism geometry (sizeMm / lengthMm) from the GLAN
        // ASSET's own params, NOT parentComponent. The glan here is a
        // binding CHILD of the isolator, so parentComponent is the
        // isolator — feeding it would make the builder fall back to the
        // 7.5 mm default and ignore the glan asset's real lengthMm (e.g.
        // the IO-3-850-HP prism's 5.0 mm). Merge defaultParams then
        // properties so a per-asset override wins, matching the fiber /
        // rf_cable dispatch above.
        const glanComp: ComponentItem = {
          id: `preview-${asset.id}`,
          name: asset.name ?? "glan",
          kindId: asset.kindId ?? "glan_polarizer",
          properties: { ...(asset.defaultParams ?? {}), ...(asset.properties ?? {}) },
          physicsCapabilities: ["optical"],
        } as ComponentItem;
        const procObj = buildGlanPolarizerPrismObject(glanComp);
        // buildGlanPolarizerPrismObject authors geometry in the main-
        // viewer three.js frame (1 unit = 100 mm, via mmToThree). This
        // Component preview loads sibling STL meshes at raw mm (1 unit =
        // 1 mm — no applyAssetScale), so the prism must be scaled ×100 to
        // share the same units; without it the prism renders 100× too
        // small (a near-invisible dot) inside the IO-3-850-HP housing.
        // No axis rotation: the prism builder already uses Z as the
        // optical axis, matching the CAD STL convention, so it lines up
        // with the housing and the binding-pose layout (which steps the
        // pieces along Z). The lab viewer keeps both in three-frame
        // instead (STL ÷100, prism native) — same relative geometry,
        // just a different global unit.
        const procMm = new THREE.Group();
        procMm.add(procObj);
        procMm.scale.setScalar(100);
        pivot.add(procMm);
        return pivot;
      }

      // Per-kind procedural renderers — same builders the lab viewer
      // uses, so the PHY editor's Component preview matches Object
      // Sense for fibers (tube + 2 FC ferrules) and rf cables (jacket
      // + SMA / BNC end connectors per endA/B). Without these the
      // primitive:// fallback below paints just a placeholder cube.
      if (asset.kindId === "fiber" || asset.kindId === "rf_cable") {
        const fakeComp: ComponentItem = parentComponent ?? ({
          id: `preview-${asset.id}`,
          name: asset.name ?? "preview",
          kindId: asset.kindId,
          properties: { ...(asset.properties ?? {}), ...(asset.defaultParams ?? {}) },
          physicsCapabilities: asset.kindId === "fiber" ? ["optical"] : ["rf"],
        } as ComponentItem);
        // Force a straight 2-node spline so the preview matches the
        // Object Sense rendering of a freshly-spawned cable (which is
        // also straight). createFiberSplineObject's built-in default
        // adds a +Z offset + tangent handles that make the tube look
        // curved / spiralled in the PHY editor viewport.
        const straightNodes: FiberNode[] = [
          { posMm: [-150, 0, 0] },
          { posMm: [150, 0, 0] },
        ];
        const obj = asset.kindId === "fiber"
          ? createFiberSplineObject(fakeComp, straightNodes)
          : createSmaShortCable(fakeComp);
        // three.js TubeGeometry twists the cross-section 360° on a
        // perfectly-straight CubicBezier (Frenet frame fallback —
        // mrdoob/three.js#16040). The twist is invisible on the
        // thick reddish-brown RF cable jacket but shows up as a
        // spiral pattern on the thin fiber jacket. Swap the
        // spiraling tube for a plain CylinderGeometry.
        if (asset.kindId === "fiber") {
          replaceSpiralTubeWithCylinder(obj, "fiberRole");
        }
        // Procedural builders author geometry in main-viewer three.js
        // frame (Y-up, 1 unit = 100 mm). The binding preview frame is
        // mm (matches STL vertices), so scale ×100. Rotate 90° about X
        // to swap Y/Z up — same convention as Asset3DV3Editor's body
        // wrap.
        const bodyMm = new THREE.Group();
        bodyMm.add(obj);
        bodyMm.scale.setScalar(100);
        bodyMm.rotation.x = Math.PI / 2;
        pivot.add(bodyMm);
        return pivot;
      }

      // Empty / primitive filePath — show a placeholder cube so the
      // user can tell the binding exists and pick it for orientation.
      if (!filePath || filePath.startsWith("primitive://")) {
        pivot.add(makePlaceholder(asset.catalogId ?? asset.name ?? "asset"));
        return pivot;
      }
      const ext = filePath.split("?")[0].split(".").pop()?.toLowerCase();
      const url = resolveAssetUrl(filePath);
      // Mesh placement MUST match the lab viewer (Object Sense) so a
      // composite Component (isolator etc.) reads identically in both
      // places. The lab viewer's loadAssetObject keeps body-frame
      // assets at their NATIVE CAD frame — it does NOT shift by
      // −bodyFramePositionMm or rotate by R_body⁻¹, because the
      // body-frame offset only relocates *anchors* (computed as
      // `R_body × anchor + bfo` in CAD axes), not the drawn mesh (see
      // loadAsset/index.ts §"Anchor strategy" + docs/frame-anchor-
      // architecture.md §3). The previous code here applied −bfo +
      // R_body⁻¹, which pushed the IO-3-850-HP STL housing +47.05 mm in
      // Z away from its (body-frame-less, procedural) Glan prisms while
      // the lab viewer left them aligned. Keep the mesh at CAD frame;
      // the binding pose (pivot) is the only transform, exactly as the
      // lab viewer's buildBindingTreeObject stacks it.
      const modelInnerGroup = new THREE.Group();
      pivot.add(modelInnerGroup);
      const hints = (asset.properties as { viewerHints?: AssetViewerHints } | undefined)?.viewerHints;
      try {
        if (ext === "stl") {
          const raw = await stlLoader.loadAsync(url);
          const geom = applyViewerHintsToGeometry(raw, hints);
          geom.computeVertexNormals();
          const mesh = new THREE.Mesh(
            geom,
            new THREE.MeshStandardMaterial({
              color: "#cbd5e1",
              roughness: 0.55,
              metalness: 0.05,
              transparent: true,
              opacity: 0.65,
              side: THREE.DoubleSide,
            }),
          );
          modelInnerGroup.add(mesh);
        } else if (ext === "glb" || ext === "gltf") {
          const g = await gltfLoader.loadAsync(url);
          // GLB files in this repo are exported with inconsistent units:
          // most are in mm (matching scene unit) but some (e.g. aom_aa_mt80)
          // are in metres. The V3 API doesn't expose Asset3D.unit, so use
          // a bbox heuristic — natural extent < 1 ⇒ metres, scale ×1000.
          const bbox = new THREE.Box3().setFromObject(g.scene);
          const sz = new THREE.Vector3();
          bbox.getSize(sz);
          if (Math.max(sz.x, sz.y, sz.z) < 1) {
            g.scene.scale.multiplyScalar(1000);
          }
          modelInnerGroup.add(g.scene);
        } else {
          modelInnerGroup.add(makePlaceholder(asset.catalogId ?? "asset"));
        }
        return pivot;
      } catch {
        // Loader failed (missing file, corrupt geometry, etc.) — keep
        // the binding visible as a placeholder.
        modelInnerGroup.add(makePlaceholder(asset.catalogId ?? "asset"));
        return pivot;
      }
    }

    // Restore the camera pose if we're rebuilding for the same
    // component (e.g. pose-field edit re-fired this useEffect). For a
    // genuine component switch, fit fresh.
    const componentId = parentComponent?.id ?? null;
    const cachedCamera = cameraStateRef.current;
    const restoreCamera = !!cachedCamera && cachedCamera.forComponentId === componentId;
    function applyCachedCamera() {
      if (!cachedCamera) return;
      camera.position.copy(cachedCamera.position);
      controls.target.copy(cachedCamera.target);
      camera.near = cachedCamera.near;
      camera.far = cachedCamera.far;
      camera.updateProjectionMatrix();
      controls.update();
    }

    // Track each binding's loaded pivot so we can attach children under
    // their parent (binding.parentBindingId) instead of all-flat under
    // root. THREE.js then composes nested transforms automatically:
    // moving the parent pivot moves every descendant with it.
    void Promise.all(
      bindings.map((b) => loadOne(b).then((obj) => obj ? { id: b.id, parentId: b.parentBindingId, obj } : null)),
    ).then((items) => {
      if (cancelled) return;
      const pivotById = new Map<string, THREE.Object3D>();
      for (const item of items) {
        if (!item) continue;
        pivotById.set(item.id, item.obj);
      }
      for (const item of items) {
        if (!item) continue;
        const parent = item.parentId ? pivotById.get(item.parentId) : null;
        (parent ?? root).add(item.obj);
      }
      pivotByBindingIdRef.current = pivotById;
      root.updateMatrixWorld(true);
      rebuildGizmo();
      rebuildProbeBeam();
      if (restoreCamera) applyCachedCamera();
      else fitCamera();
    });
    if (restoreCamera) applyCachedCamera();
    else fitCamera();

    // Alt+left drag rotates the selected binding's orientation. dx → +Y
    // rotation (yaw), dy → +X rotation (pitch); add Shift for +Z (roll).
    // The pivot is updated live; on pointerup the deltas commit back to
    // the binding via onPatchBinding.
    const dragState = {
      active: false,
      lastX: 0,
      lastY: 0,
      roll: false,
      startEuler: new THREE.Euler(),
    };
    const onPointerDown = (ev: PointerEvent) => {
      if (ev.button !== 0 || !ev.altKey) return;
      const selId = selectedBindingIdRef.current;
      if (!selId) return;
      // Honour the per-axis 🔒 locks from the table. If every rotation
      // axis (Rx/Ry/Rz) is locked, Alt+drag is a no-op — there's
      // nothing the gesture could legitimately commit. Mixed locks
      // (e.g. Rx/Ry locked, Rz unlocked) still allow the drag; we
      // filter the committed axes in onPointerUp.
      const selBinding = bindingsRef.current.find((b) => b.id === selId);
      const tunable = (selBinding?.tunableAxes ?? {}) as Record<string, unknown>;
      const anyRotUnlocked =
        "localRxDeg" in tunable
        || "localRyDeg" in tunable
        || "localRzDeg" in tunable;
      if (!anyRotUnlocked) return;
      dragState.active = true;
      dragState.lastX = ev.clientX;
      dragState.lastY = ev.clientY;
      dragState.roll = ev.shiftKey;
      dragState.startEuler.copy(gizmoPivot.rotation);
      controls.enabled = false;
      renderer.domElement.setPointerCapture(ev.pointerId);
    };
    const onPointerMove = (ev: PointerEvent) => {
      if (!dragState.active) return;
      const dx = ev.clientX - dragState.lastX;
      const dy = ev.clientY - dragState.lastY;
      dragState.lastX = ev.clientX;
      dragState.lastY = ev.clientY;
      const k = 0.012;
      const dq = new THREE.Quaternion();
      if (dragState.roll) {
        dq.setFromAxisAngle(new THREE.Vector3(0, 0, 1), dx * k);
      } else {
        const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy * k);
        const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx * k);
        dq.multiplyQuaternions(qy, qx);
      }
      gizmoPivot.quaternion.premultiply(dq).normalize();
    };
    const onPointerUp = (ev: PointerEvent) => {
      if (!dragState.active) return;
      dragState.active = false;
      controls.enabled = true;
      try { renderer.domElement.releasePointerCapture(ev.pointerId); } catch {}
      const selId = selectedBindingIdRef.current;
      if (!selId) return;
      const euler = new THREE.Euler().setFromQuaternion(gizmoPivot.quaternion, "XYZ");
      const r2d = 180 / Math.PI;
      // Only commit rotation axes that are unlocked (in tunableAxes).
      // Mixed-lock case: user might see the gizmo wobble in all three
      // axes during drag but only the unlocked ones get persisted.
      const selBinding = bindingsRef.current.find((b) => b.id === selId);
      const tunable = (selBinding?.tunableAxes ?? {}) as Record<string, unknown>;
      const patch: ComponentBindingUpdatePayload = {};
      if ("localRxDeg" in tunable) patch.localRxDeg = euler.x * r2d;
      if ("localRyDeg" in tunable) patch.localRyDeg = euler.y * r2d;
      if ("localRzDeg" in tunable) patch.localRzDeg = euler.z * r2d;
      if (Object.keys(patch).length > 0) onPatchBindingRef.current(selId, patch);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    let frame = 0;
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = window.requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelled = true;
      // Snapshot the camera so the next mount (typically a pose-field
      // edit re-triggering this useEffect) can restore the user's view.
      cameraStateRef.current = {
        position: camera.position.clone(),
        target: controls.target.clone(),
        near: camera.near,
        far: camera.far,
        forComponentId: componentId,
      };
      window.cancelAnimationFrame(frame);
      controls.dispose();
      renderer.dispose();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      scene.traverse((obj) => {
        const m = obj as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
      });
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, [bindings, assetById, parentComponent?.id]);

  // Rebuild gizmo and probe beam whenever the selection / bindings /
  // beam controls change. Gizmo follows the selected binding; the
  // probe-beam trace walks every binding's faces in component frame.
  useEffect(() => {
    rebuildGizmoRef.current();
    rebuildProbeBeamRef.current();
  }, [selectedBindingId, bindings, beamPos, beamDir, beamPolDeg]);

  // Probe beam now operates on the whole component, so the controls
  // are useful whenever the component has at least one resolvable
  // asset-targeting binding (regardless of which row is selected).
  const showBeamControls = bindings.some(
    (b) => b.targetKind === "asset" && b.asset3dId !== null && assetById.has(b.asset3dId),
  );

  return (
    <div>
      {showBeamControls && (
        <ProbeBeamControls
          pos={beamPos}
          dir={beamDir}
          polDeg={beamPolDeg}
          onChange={(patch) => {
            if (patch.pos) setBeamPos(patch.pos);
            if (patch.dir) setBeamDir(patch.dir);
            if (typeof patch.polDeg === "number") setBeamPolDeg(patch.polDeg);
          }}
        />
      )}
      <div
        ref={mountRef}
        style={{
          width: "100%",
          height: 360,
          background: "#07111f",
          borderRadius: 4,
          overflow: "hidden",
        }}
      />
    </div>
  );
}

/** Inline control strip for the PBS preview beam: position, direction
 *  vector, and s↔p polarization angle in degrees. */
function ProbeBeamControls({
  pos, dir, polDeg, onChange,
}: {
  pos: { x: number; y: number; z: number };
  dir: { x: number; y: number; z: number };
  polDeg: number;
  onChange: (patch: {
    pos?: { x: number; y: number; z: number };
    dir?: { x: number; y: number; z: number };
    polDeg?: number;
  }) => void;
}) {
  const inputStyle: React.CSSProperties = {
    width: 64,
    padding: "2px 4px",
    fontSize: 11,
    border: "1px solid #d8ded8",
    borderRadius: 3,
    fontFamily: "ui-monospace, monospace",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 10, color: "#4b5563", display: "inline-flex", alignItems: "center", gap: 3,
  };
  const groupStyle: React.CSSProperties = {
    display: "inline-flex", gap: 4, alignItems: "center",
    padding: "3px 8px", border: "1px solid #e9ece9", borderRadius: 3,
    background: "#fbfbf8",
  };
  return (
    <div
      style={{
        display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center",
        marginBottom: 6, fontSize: 11, color: "#4b5563",
      }}
    >
      <span style={{ fontWeight: 600, color: "#fb923c" }}>probe beam</span>
      <div style={groupStyle}>
        <span style={{ fontSize: 10, color: "#6b7280", marginRight: 2 }}>pos mm</span>
        <label style={labelStyle}>x
          <input
            type="number" step={0.5} value={pos.x} style={inputStyle}
            onChange={(e) => onChange({ pos: { ...pos, x: Number(e.target.value) || 0 } })}
          />
        </label>
        <label style={labelStyle}>y
          <input
            type="number" step={0.5} value={pos.y} style={inputStyle}
            onChange={(e) => onChange({ pos: { ...pos, y: Number(e.target.value) || 0 } })}
          />
        </label>
        <label style={labelStyle}>z
          <input
            type="number" step={0.5} value={pos.z} style={inputStyle}
            onChange={(e) => onChange({ pos: { ...pos, z: Number(e.target.value) || 0 } })}
          />
        </label>
      </div>
      <div style={groupStyle}>
        <span style={{ fontSize: 10, color: "#6b7280", marginRight: 2 }}>dir</span>
        <label style={labelStyle}>x
          <input
            type="number" step={0.1} value={dir.x} style={inputStyle}
            onChange={(e) => onChange({ dir: { ...dir, x: Number(e.target.value) || 0 } })}
          />
        </label>
        <label style={labelStyle}>y
          <input
            type="number" step={0.1} value={dir.y} style={inputStyle}
            onChange={(e) => onChange({ dir: { ...dir, y: Number(e.target.value) || 0 } })}
          />
        </label>
        <label style={labelStyle}>z
          <input
            type="number" step={0.1} value={dir.z} style={inputStyle}
            onChange={(e) => onChange({ dir: { ...dir, z: Number(e.target.value) || 0 } })}
          />
        </label>
      </div>
      <div style={groupStyle}>
        <span style={{ fontSize: 10, color: "#6b7280", marginRight: 2 }}>
          pol° <span title="0° = pure s (reflect), 90° = pure p (transmit)" style={{ cursor: "help" }}>ⓘ</span>
        </span>
        <input
          type="range" min={0} max={90} step={1} value={polDeg}
          onChange={(e) => onChange({ polDeg: Number(e.target.value) })}
          style={{ width: 90 }}
        />
        <input
          type="number" min={0} max={90} step={1} value={polDeg} style={inputStyle}
          onChange={(e) => onChange({ polDeg: Math.max(0, Math.min(90, Number(e.target.value) || 0)) })}
        />
      </div>
    </div>
  );
}
