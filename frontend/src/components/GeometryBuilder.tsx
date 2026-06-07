/**
 * Geometry construction page (Asset-layer M2 §B-1 + §B-2). A PhyEditor tab,
 * independent of the anchor editor: import a STEP file, preview it (colour
 * preserved) in the browser via occt-import-js, decimate it live with
 * meshoptimizer, then bake + save it as a viewer-ready coloured GLB Asset3D
 * through the existing upload route — no server-side CAD conversion.
 *
 * Anchors are NOT placed here. Pipeline is build -> save (freeze) -> place
 * anchors in the ASSET3D tab, so anchors only ever live on a frozen mesh.
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
import { useV3Catalog, type V3AssetUpload } from "../store/catalogStore";

const locateOcctWasm: OcctLocateFile = (path) =>
  path.endsWith(".wasm") ? occtWasmUrl : path;

// Triangle budgets per the Asset-layer III-3 table (Detail / Balanced / Light).
const PRESETS: { label: string; tris: number }[] = [
  { label: "Detail", tris: 300_000 },
  { label: "Balanced", tris: 100_000 },
  { label: "Light", tris: 30_000 },
];

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

type Status = "idle" | "parsing" | "ready" | "saving";

export function GeometryBuilder() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelGroupRef = useRef<THREE.Group | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Full-resolution merged import (source for every re-decimation), its welded
  // form (cached so the slider doesn't re-weld each tick), and the geometry
  // currently shown + exported (full or a decimated copy).
  const fullGeometryRef = useRef<THREE.BufferGeometry | null>(null);
  const weldedFullRef = useRef<THREE.BufferGeometry | null>(null);
  const displayGeometryRef = useRef<THREE.BufferGeometry | null>(null);

  const uploadAsset = useV3Catalog((s) => s.uploadAsset);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState("");
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
        if (child instanceof THREE.Mesh) {
          (child.material as THREE.Material).dispose();
        }
      }
      // Geometries are owned by refs, not the group; dispose them here.
      displayGeometryRef.current?.dispose();
      if (fullGeometryRef.current !== displayGeometryRef.current) {
        fullGeometryRef.current?.dispose();
      }
      weldedFullRef.current?.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
      cameraRef.current = null;
      controlsRef.current = null;
      modelGroupRef.current = null;
    };
  }, []);

  // Show a geometry in the viewport. Disposes only the previous mesh's material;
  // geometry lifetimes are owned by the refs above.
  const showGeometry = useCallback((geometry: THREE.BufferGeometry) => {
    const group = modelGroupRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!group || !camera || !controls) return;

    for (const child of [...group.children]) {
      group.remove(child);
      if (child instanceof THREE.Mesh) {
        (child.material as THREE.Material).dispose();
      }
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

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setInfo(null);
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (ext !== "step" && ext !== "stp") {
        setError("Pick a STEP file (.step / .stp).");
        return;
      }
      setStatus("parsing");
      try {
        const data = new Uint8Array(await file.arrayBuffer());
        const result = await importStep(data, { linearUnit: "millimeter" }, locateOcctWasm);
        const merged = mergeColoredGeometries(occtResultToGeometry(result));

        // Drop any previous import's geometries.
        if (displayGeometryRef.current && displayGeometryRef.current !== fullGeometryRef.current) {
          displayGeometryRef.current.dispose();
        }
        fullGeometryRef.current?.dispose();
        weldedFullRef.current?.dispose();

        fullGeometryRef.current = merged;
        weldedFullRef.current = weldForSimplify(merged);
        displayGeometryRef.current = merged;

        const tris = triangleCount(merged);
        setSourceTris(tris);
        setTargetTris(tris); // full res by default; the effect renders it
        setDisplayTris(tris);
        setEstMB(estimateGlbBytes(merged) / 1e6);
        showGeometry(merged);

        setSourceName(file.name);
        const stem = file.name.replace(/\.[^.]+$/, "");
        setCatalogId((current) => current || slugify(stem));
        setName((current) => current || stem);
        setInfo(`Imported ${result.meshes.length} mesh(es).`);
        setStatus("ready");
      } catch (e) {
        setStatus("idle");
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [showGeometry],
  );

  // Live decimation: debounce slider/preset changes, re-decimate from the cached
  // welded full-res mesh, swap the preview, and refresh the tri/size readout.
  useEffect(() => {
    const welded = weldedFullRef.current;
    const full = fullGeometryRef.current;
    if (!welded || !full || sourceTris === 0) return;

    const id = setTimeout(async () => {
      setDecimating(true);
      setError(null);
      try {
        const next =
          targetTris >= sourceTris ? full : await decimateWelded(welded, targetTris);
        const prev = displayGeometryRef.current;
        displayGeometryRef.current = next;
        showGeometry(next);
        setDisplayTris(triangleCount(next));
        setEstMB(estimateGlbBytes(next) / 1e6);
        if (prev && prev !== full && prev !== next) prev.dispose();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setDecimating(false);
      }
    }, 150);
    return () => clearTimeout(id);
  }, [targetTris, sourceTris, showGeometry]);

  const handleSave = useCallback(async () => {
    const geometry = displayGeometryRef.current;
    if (!geometry) {
      setError("Import a STEP file first.");
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

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0, color: "#e6e6e6" }}>
      <aside
        style={{
          width: 320,
          flex: "0 0 320px",
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
            Import a STEP file → preview with colour → decimate → save as a
            viewer-ready GLB asset. Anchors are placed afterwards in the ASSET3D tab.
          </p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".step,.stp"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.currentTarget.files?.[0] ?? null;
            e.currentTarget.value = "";
            if (file) void handleFile(file);
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
          style={primaryButton(busy)}
        >
          {status === "parsing" ? "Parsing STEP…" : "Import STEP…"}
        </button>

        {hasModel && (
          <>
            {sourceName && (
              <div style={{ fontSize: 11, opacity: 0.85 }}>
                source: <code>{sourceName}</code>
              </div>
            )}

            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ fontSize: 11, opacity: 0.8 }}>Decimation</div>
              <div style={{ display: "flex", gap: 6 }}>
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setTargetTris(Math.min(sourceTris, p.tris))}
                    style={chipButton(targetTris === Math.min(sourceTris, p.tris))}
                  >
                    {p.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setTargetTris(sourceTris)}
                  style={chipButton(targetTris >= sourceTris)}
                >
                  Full
                </button>
              </div>
              <input
                type="range"
                min={Math.min(1000, sourceTris)}
                max={sourceTris}
                step={1000}
                value={Math.min(targetTris, sourceTris)}
                onChange={(e) => setTargetTris(Number(e.target.value))}
              />
              <div style={{ fontSize: 11, opacity: 0.85 }}>
                {displayTris.toLocaleString()} tris · ~{estMB.toFixed(1)} MB
                {decimating && <span style={{ opacity: 0.6 }}> · simplifying…</span>}
              </div>
            </div>

            <label style={{ fontSize: 11, display: "grid", gap: 4 }}>
              catalog_id
              <input
                value={catalogId}
                onChange={(e) => setCatalogId(e.target.value)}
                placeholder="lower_snake_case"
                style={inputStyle}
              />
            </label>
            <label style={{ fontSize: 11, display: "grid", gap: 4 }}>
              name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Display name"
                style={inputStyle}
              />
            </label>
            <label style={{ fontSize: 11, display: "grid", gap: 4 }}>
              domain
              <select
                value={domain}
                onChange={(e) => setDomain(e.target.value as typeof domain)}
                style={inputStyle}
              >
                <option value="mechanical">mechanical</option>
                <option value="optical">optical</option>
                <option value="rf">rf</option>
              </select>
            </label>

            <button
              type="button"
              disabled={busy}
              onClick={() => void handleSave()}
              style={saveButton(busy)}
            >
              {status === "saving" ? "Saving…" : "Save as GLB asset"}
            </button>
          </>
        )}

        {error && (
          <div style={{ fontSize: 11, color: "#fca5a5", whiteSpace: "pre-wrap" }}>{error}</div>
        )}
        {info && !error && (
          <div style={{ fontSize: 11, color: "#86efac", whiteSpace: "pre-wrap" }}>{info}</div>
        )}
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
