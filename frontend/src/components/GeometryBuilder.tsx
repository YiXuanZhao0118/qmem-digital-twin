/**
 * Geometry construction page (Asset-layer M2 §B-1..§B-4). A PhyEditor tab,
 * independent of the anchor editor. Sources: upload a STEP (occt-import-js WASM)
 * OR pull in an existing Asset3D (GLB/GLTF/OBJ/STL) to edit/combine. Each source
 * mesh is a "part" with its own position/rotation; preview/export is the merge of
 * the included, transformed parts — coloured — saved as a viewer-ready GLB via
 * the existing upload route (no server-side CAD conversion). Decimate live
 * (meshoptimizer). Anchors are placed afterwards in the ASSET3D tab.
 *
 * Split = untick parts; merge = add more sources; edit-existing = add an existing
 * asset as a source, transform, save. File imports are kindless geometry.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// Vite serves the WASM as a static asset and hands us its URL; occt's emscripten
// loader is pointed at it via locateFile. (Node tests resolve it via fs instead.)
import occtWasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";

import {
  importStep,
  occtResultToGeometry,
  type OcctLocateFile,
} from "../three/occtImport";
import {
  exportGlb,
  geometryToColoredMesh,
  glbToFile,
  mergeColoredGeometries,
} from "../three/glbExport";
import {
  decimateWelded,
  estimateGlbBytes,
  triangleCount,
  weldForSimplify,
} from "../three/decimate";
import { loadAssetGeometry } from "../three/loadAssetGeometry";
import { resolveAssetUrl } from "../api/client";
import { useV3Catalog, type V3AssetUpload } from "../store/catalogStore";

const locateOcctWasm: OcctLocateFile = (path) =>
  path.endsWith(".wasm") ? occtWasmUrl : path;

const PRESETS: { label: string; tris: number }[] = [
  { label: "Detail", tris: 300_000 },
  { label: "Balanced", tris: 100_000 },
  { label: "Light", tris: 30_000 },
];

const VIEWER_EXTS = new Set(["glb", "gltf", "obj", "stl"]);

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

function extOf(pathOrType: string): string {
  return (pathOrType.split("?")[0].split(".").pop() ?? pathOrType).toLowerCase();
}

type Status = "idle" | "parsing" | "ready" | "saving";
type Part = {
  id: string;
  label: string;
  included: boolean;
  tx: number; ty: number; tz: number; // position mm
  rx: number; ry: number; rz: number; // rotation deg
};

function newPart(id: string, label: string): Part {
  return { id, label, included: true, tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
}

function hasTransform(p: Part): boolean {
  return p.tx || p.ty || p.tz || p.rx || p.ry || p.rz ? true : false;
}

export function GeometryBuilder() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelGroupRef = useRef<THREE.Group | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const partGeomsRef = useRef<Map<string, THREE.BufferGeometry>>(new Map());
  const partIdRef = useRef(0);
  const composedFullRef = useRef<THREE.BufferGeometry | null>(null);
  const weldedFullRef = useRef<THREE.BufferGeometry | null>(null);
  const decimatedRef = useRef<THREE.BufferGeometry | null>(null);
  const recomposeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const uploadAsset = useV3Catalog((s) => s.uploadAsset);
  const assets = useV3Catalog((s) => s.assets);
  const refreshCatalog = useV3Catalog((s) => s.refresh);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [parts, setParts] = useState<Part[]>([]);
  const [existingPick, setExistingPick] = useState("");
  const [catalogId, setCatalogId] = useState("");
  const [name, setName] = useState("");
  const [domain, setDomain] = useState<"optical" | "rf" | "mechanical">("mechanical");
  const [sourceTris, setSourceTris] = useState(0);
  const [displayTris, setDisplayTris] = useState(0);
  const [estMB, setEstMB] = useState(0);
  const [targetTris, setTargetTris] = useState(0);
  const [decimating, setDecimating] = useState(false);

  // One-time three.js viewport.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x16161a);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
    camera.position.set(120, 120, 120);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    mount.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const group = new THREE.Group();
    scene.add(group);
    scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(1, 1.5, 1);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-1, -0.5, -1);
    scene.add(fill);
    scene.add(new THREE.GridHelper(500, 20, 0x3a3a44, 0x26262c));

    cameraRef.current = camera;
    controlsRef.current = controls;
    modelGroupRef.current = group;

    let raf = 0;
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    animate();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      for (const child of [...group.children]) {
        if (child instanceof THREE.Mesh) (child.material as THREE.Material).dispose();
      }
      decimatedRef.current?.dispose();
      composedFullRef.current?.dispose();
      weldedFullRef.current?.dispose();
      for (const geom of partGeomsRef.current.values()) geom.dispose();
      partGeomsRef.current.clear();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      cameraRef.current = null;
      controlsRef.current = null;
      modelGroupRef.current = null;
    };
  }, []);

  // Populate the existing-asset picker (the catalog may be unfetched in this tab).
  useEffect(() => {
    if (assets.length === 0) void refreshCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshCatalog]);

  const showGeometry = useCallback((geometry: THREE.BufferGeometry) => {
    const group = modelGroupRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!group || !camera || !controls) return;
    for (const child of [...group.children]) {
      group.remove(child);
      if (child instanceof THREE.Mesh) (child.material as THREE.Material).dispose();
    }
    group.add(geometryToColoredMesh(geometry));
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere;
    const radius = sphere && sphere.radius > 0 ? sphere.radius : 50;
    const center = sphere ? sphere.center : new THREE.Vector3();
    controls.target.copy(center);
    camera.position
      .copy(center)
      .add(new THREE.Vector3(1, 0.8, 1).normalize().multiplyScalar(radius * 3));
    camera.near = radius / 100;
    camera.far = radius * 100;
    camera.updateProjectionMatrix();
    controls.update();
  }, []);

  const clearPreview = useCallback(() => {
    const group = modelGroupRef.current;
    if (!group) return;
    for (const child of [...group.children]) {
      group.remove(child);
      if (child instanceof THREE.Mesh) (child.material as THREE.Material).dispose();
    }
  }, []);

  // Rebuild the merge from the included parts (each baked at its transform).
  const recompose = useCallback(
    (nextParts: Part[]) => {
      const clones: THREE.BufferGeometry[] = [];
      for (const p of nextParts) {
        if (!p.included) continue;
        const base = partGeomsRef.current.get(p.id);
        if (!base) continue;
        const g = base.clone();
        if (hasTransform(p)) {
          const m = new THREE.Matrix4().compose(
            new THREE.Vector3(p.tx, p.ty, p.tz),
            new THREE.Quaternion().setFromEuler(
              new THREE.Euler(
                THREE.MathUtils.degToRad(p.rx),
                THREE.MathUtils.degToRad(p.ry),
                THREE.MathUtils.degToRad(p.rz),
              ),
            ),
            new THREE.Vector3(1, 1, 1),
          );
          g.applyMatrix4(m);
        }
        clones.push(g);
      }

      decimatedRef.current?.dispose();
      decimatedRef.current = null;
      composedFullRef.current?.dispose();
      weldedFullRef.current?.dispose();

      if (clones.length === 0) {
        composedFullRef.current = null;
        weldedFullRef.current = null;
        clearPreview();
        setSourceTris(0);
        setTargetTris(0);
        setDisplayTris(0);
        setEstMB(0);
        return;
      }

      const composed = mergeColoredGeometries(clones);
      // mergeColoredGeometries returns clones[0] for a single part; dispose the
      // rest. (composed is always a clone, never a part's source geometry.)
      for (const g of clones) {
        if (g !== composed) g.dispose();
      }
      composedFullRef.current = composed;
      weldedFullRef.current = weldForSimplify(composed);
      const tris = triangleCount(composed);
      showGeometry(composed);
      setSourceTris(tris);
      setTargetTris(tris);
      setDisplayTris(tris);
      setEstMB(estimateGlbBytes(composed) / 1e6);
    },
    [clearPreview, showGeometry],
  );

  // Debounced recompose for rapid edits (slider-like transform typing).
  const recomposeSoon = useCallback(
    (nextParts: Part[]) => {
      setParts(nextParts);
      if (recomposeTimer.current) clearTimeout(recomposeTimer.current);
      recomposeTimer.current = setTimeout(() => recompose(nextParts), 120);
    },
    [recompose],
  );

  const seedNaming = useCallback((stem: string) => {
    setCatalogId((c) => c || slugify(stem));
    setName((n) => n || stem);
  }, []);

  const handleFiles = useCallback(
    async (files: File[]) => {
      setError(null);
      setInfo(null);
      const steps = files.filter((f) => ["step", "stp"].includes(extOf(f.name)));
      if (steps.length === 0) {
        setError("Pick STEP file(s) (.step / .stp).");
        return;
      }
      setStatus("parsing");
      try {
        const added: Part[] = [];
        for (const file of steps) {
          const data = new Uint8Array(await file.arrayBuffer());
          const result = await importStep(data, { linearUnit: "millimeter" }, locateOcctWasm);
          const stem = file.name.replace(/\.[^.]+$/, "");
          // One source per FILE: merge all of the STEP's meshes into a single
          // transformable unit (3 files → 3 transforms → save → 1 GLB). Mesh-
          // level splitting is the separate remove-regions feature (follow-up).
          const geom = mergeColoredGeometries(occtResultToGeometry(result));
          const id = `part_${partIdRef.current++}`;
          partGeomsRef.current.set(id, geom);
          added.push(newPart(id, stem));
        }
        const next = [...parts, ...added];
        setParts(next);
        recompose(next);
        if (parts.length === 0 && steps[0]) seedNaming(steps[0].name.replace(/\.[^.]+$/, ""));
        setInfo(`Added ${added.length} part(s). ${next.length} total.`);
        setStatus("ready");
      } catch (e) {
        setStatus("ready");
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [parts, recompose, seedNaming],
  );

  const handleAddExisting = useCallback(async () => {
    const asset = assets.find((a) => a.catalogId === existingPick);
    if (!asset) {
      setError("Pick an existing asset to add.");
      return;
    }
    const ext = extOf(asset.assetType || asset.filePath);
    if (!VIEWER_EXTS.has(ext)) {
      setError(`"${asset.catalogId}" is .${ext} — only GLB/GLTF/OBJ/STL assets can be loaded as a source.`);
      return;
    }
    setError(null);
    setInfo(null);
    setStatus("parsing");
    try {
      const geom = await loadAssetGeometry(resolveAssetUrl(asset.filePath), ext, {
        unit: asset.unit,
        scaleFactor: asset.scaleFactor,
      });
      const id = `part_${partIdRef.current++}`;
      partGeomsRef.current.set(id, geom);
      const next = [...parts, newPart(id, asset.name || asset.catalogId)];
      setParts(next);
      recompose(next);
      if (parts.length === 0) seedNaming(`${asset.catalogId}_edit`);
      setInfo(`Added existing asset "${asset.catalogId}".`);
      setStatus("ready");
    } catch (e) {
      setStatus("ready");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [assets, existingPick, parts, recompose, seedNaming]);

  const togglePart = useCallback(
    (id: string) => {
      const next = parts.map((p) => (p.id === id ? { ...p, included: !p.included } : p));
      setParts(next);
      recompose(next);
    },
    [parts, recompose],
  );

  const removePart = useCallback(
    (id: string) => {
      partGeomsRef.current.get(id)?.dispose();
      partGeomsRef.current.delete(id);
      const next = parts.filter((p) => p.id !== id);
      setParts(next);
      recompose(next);
    },
    [parts, recompose],
  );

  const setPartField = useCallback(
    (id: string, field: "tx" | "ty" | "tz" | "rx" | "ry" | "rz", value: number) => {
      const next = parts.map((p) => (p.id === id ? { ...p, [field]: value } : p));
      recomposeSoon(next);
    },
    [parts, recomposeSoon],
  );

  // Live decimation (debounced).
  useEffect(() => {
    const welded = weldedFullRef.current;
    const full = composedFullRef.current;
    if (!welded || !full || sourceTris === 0) return;
    const id = setTimeout(async () => {
      setDecimating(true);
      setError(null);
      try {
        if (targetTris >= sourceTris) {
          decimatedRef.current?.dispose();
          decimatedRef.current = null;
          showGeometry(full);
          setDisplayTris(triangleCount(full));
          setEstMB(estimateGlbBytes(full) / 1e6);
        } else {
          const next = await decimateWelded(welded, targetTris);
          decimatedRef.current?.dispose();
          decimatedRef.current = next;
          showGeometry(next);
          setDisplayTris(triangleCount(next));
          setEstMB(estimateGlbBytes(next) / 1e6);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setDecimating(false);
      }
    }, 150);
    return () => clearTimeout(id);
  }, [targetTris, sourceTris, showGeometry]);

  const handleSave = useCallback(async () => {
    const geometry = decimatedRef.current ?? composedFullRef.current;
    if (!geometry) {
      setError("Add at least one source part first.");
      return;
    }
    if (!/^[a-z0-9_]+$/.test(catalogId)) {
      setError("catalog_id must be lower-snake-case ([a-z0-9_]+).");
      return;
    }
    if (!name.trim()) {
      setError("name is required.");
      return;
    }
    setError(null);
    setInfo(null);
    setStatus("saving");
    try {
      const glb = await exportGlb(geometry);
      const payload: V3AssetUpload = {
        file: glbToFile(glb, catalogId),
        catalogId,
        name: name.trim(),
        domain,
        preserveColors: true,
      };
      await uploadAsset(payload);
      setInfo(`Saved “${catalogId}” (${(glb.byteLength / 1e6).toFixed(1)} MB). Place anchors in the ASSET3D tab.`);
      setStatus("ready");
    } catch (e) {
      setStatus("ready");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [catalogId, name, domain, uploadAsset]);

  const hasModel = sourceTris > 0;
  const busy = status === "parsing" || status === "saving";
  const includedCount = parts.filter((p) => p.included).length;
  const importableAssets = assets.filter((a) => VIEWER_EXTS.has(extOf(a.assetType || a.filePath)));

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0, color: "#e6e6e6" }}>
      <aside
        style={{
          width: 340,
          flex: "0 0 340px",
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          background: "#1f1f25",
          borderRight: "1px solid #303039",
          overflow: "auto",
        }}
      >
        <div>
          <h3 style={{ margin: "0 0 4px", fontSize: 14 }}>Geometry Builder</h3>
          <p style={{ margin: 0, fontSize: 11, opacity: 0.7, lineHeight: 1.4 }}>
            Add sources (each uploaded STEP / picked asset = one unit), position
            & rotate each, then save them merged into one coloured GLB. Untick a
            source to leave it out; decimate before saving. Anchors are placed
            afterwards in the ASSET3D tab.
          </p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".step,.stp"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = "";
            if (files.length) void handleFiles(files);
          }}
        />
        <button type="button" disabled={busy} onClick={() => fileInputRef.current?.click()} style={primaryButton(busy)}>
          {status === "parsing" ? "Working…" : parts.length === 0 ? "Import STEP…" : "Import more STEP…"}
        </button>

        <div style={{ display: "flex", gap: 6 }}>
          <select
            value={existingPick}
            onChange={(e) => setExistingPick(e.target.value)}
            disabled={busy}
            style={{ ...inputStyle, flex: 1 }}
          >
            <option value="">add existing asset…</option>
            {importableAssets.map((a) => (
              <option key={a.catalogId} value={a.catalogId}>
                {a.name || a.catalogId} (.{extOf(a.assetType || a.filePath)})
              </option>
            ))}
          </select>
          <button type="button" disabled={busy || !existingPick} onClick={() => void handleAddExisting()} style={chipButton(false)}>
            Add
          </button>
        </div>

        {parts.length > 0 && (
          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ fontSize: 11, opacity: 0.8 }}>
              Sources ({includedCount}/{parts.length}) — each has its own position / rotation
            </div>
            <div style={{ display: "grid", gap: 8, maxHeight: 340, overflow: "auto" }}>
              {parts.map((p) => (
                <div
                  key={p.id}
                  style={{
                    display: "grid",
                    gap: 4,
                    padding: 6,
                    background: "#15151a",
                    border: "1px solid #303039",
                    borderRadius: 4,
                    opacity: p.included ? 1 : 0.5,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                    <input type="checkbox" checked={p.included} onChange={() => togglePart(p.id)} />
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p.label}>
                      {p.label}
                    </span>
                    <button
                      type="button"
                      onClick={() => removePart(p.id)}
                      title="Remove this source"
                      style={{ background: "none", border: "none", color: "#fca5a5", cursor: "pointer", fontSize: 13, lineHeight: 1 }}
                    >
                      ×
                    </button>
                  </div>
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <span style={{ fontSize: 9, opacity: 0.5, width: 22 }}>pos</span>
                    {(["tx", "ty", "tz"] as const).map((f) => (
                      <input key={f} type="number" step={1} value={p[f]} title={`${f} (mm)`}
                        onChange={(e) => setPartField(p.id, f, Number(e.target.value) || 0)}
                        style={{ ...inputStyle, flex: 1, minWidth: 0, padding: "3px 5px" }} />
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <span style={{ fontSize: 9, opacity: 0.5, width: 22 }}>rot</span>
                    {(["rx", "ry", "rz"] as const).map((f) => (
                      <input key={f} type="number" step={5} value={p[f]} title={`${f} (deg)`}
                        onChange={(e) => setPartField(p.id, f, Number(e.target.value) || 0)}
                        style={{ ...inputStyle, flex: 1, minWidth: 0, padding: "3px 5px" }} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {hasModel && (
          <>
            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ fontSize: 11, opacity: 0.8 }}>Decimation</div>
              <div style={{ display: "flex", gap: 6 }}>
                {PRESETS.map((p) => (
                  <button key={p.label} type="button" onClick={() => setTargetTris(Math.min(sourceTris, p.tris))} style={chipButton(targetTris === Math.min(sourceTris, p.tris))}>
                    {p.label}
                  </button>
                ))}
                <button type="button" onClick={() => setTargetTris(sourceTris)} style={chipButton(targetTris >= sourceTris)}>
                  Full
                </button>
              </div>
              <input type="range" min={Math.min(1000, sourceTris)} max={sourceTris} step={1000} value={Math.min(targetTris, sourceTris)} onChange={(e) => setTargetTris(Number(e.target.value))} />
              <div style={{ fontSize: 11, opacity: 0.85 }}>
                {displayTris.toLocaleString()} tris · ~{estMB.toFixed(1)} MB
                {decimating && <span style={{ opacity: 0.6 }}> · simplifying…</span>}
              </div>
            </div>

            <label style={{ fontSize: 11, display: "grid", gap: 4 }}>
              catalog_id
              <input value={catalogId} onChange={(e) => setCatalogId(e.target.value)} placeholder="lower_snake_case" style={inputStyle} />
            </label>
            <label style={{ fontSize: 11, display: "grid", gap: 4 }}>
              name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" style={inputStyle} />
            </label>
            <label style={{ fontSize: 11, display: "grid", gap: 4 }}>
              domain
              <select value={domain} onChange={(e) => setDomain(e.target.value as typeof domain)} style={inputStyle}>
                <option value="mechanical">mechanical</option>
                <option value="optical">optical</option>
                <option value="rf">rf</option>
              </select>
            </label>

            <button type="button" disabled={busy} onClick={() => void handleSave()} style={saveButton(busy)}>
              {status === "saving" ? "Saving…" : "Save as GLB asset"}
            </button>
          </>
        )}

        {error && <div style={{ fontSize: 11, color: "#fca5a5", whiteSpace: "pre-wrap" }}>{error}</div>}
        {info && !error && <div style={{ fontSize: 11, color: "#86efac", whiteSpace: "pre-wrap" }}>{info}</div>}
      </aside>

      <div ref={mountRef} style={{ flex: 1, minWidth: 0, position: "relative" }} />
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "5px 7px",
  fontSize: 12,
  background: "#15151a",
  border: "1px solid #303039",
  borderRadius: 3,
  color: "#e6e6e6",
};

function primaryButton(disabled: boolean): React.CSSProperties {
  return {
    padding: "8px 12px",
    fontSize: 12,
    fontWeight: 600,
    border: "1px solid #2563eb",
    background: disabled ? "#26262c" : "#1e3a8a",
    color: "#dbeafe",
    cursor: disabled ? "not-allowed" : "pointer",
    borderRadius: 4,
  };
}

function saveButton(disabled: boolean): React.CSSProperties {
  return {
    padding: "8px 12px",
    fontSize: 12,
    fontWeight: 600,
    border: "1px solid #ca8a04",
    background: disabled ? "#26262c" : "#a16207",
    color: "#fef3c7",
    cursor: disabled ? "not-allowed" : "pointer",
    borderRadius: 4,
  };
}

function chipButton(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: "4px 6px",
    fontSize: 11,
    border: "1px solid " + (active ? "#2563eb" : "#303039"),
    background: active ? "#1e3a8a" : "#15151a",
    color: active ? "#dbeafe" : "#cbd5e1",
    cursor: "pointer",
    borderRadius: 3,
  };
}
