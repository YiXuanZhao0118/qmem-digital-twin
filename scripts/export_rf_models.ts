/**
 * One-off: export the procedural ZHL-1-2W+ amplifier and ZYSWA-2-50DR switch
 * geometry to downloadable GLB (colour-preserving) + STL (geometry-only) files.
 * Run from the frontend dir:  npx -y vite-node ../scripts/export_rf_models.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";

import { MM_PER_THREE_UNIT } from "../frontend/src/optical/frames";
import { createMinicircuitsZhl12wPlus } from "../frontend/src/kinds/rf_amplifier/models/minicircuits_zhl_1_2w_plus";
import { createMinicircuitsZyswa250dr } from "../frontend/src/kinds/rf_switch/models/minicircuits_zyswa_2_50dr";

// GLTFExporter's binary path uses the browser FileReader API. Polyfill the
// one method it calls (readAsArrayBuffer + onloadend) on top of Node's Blob.
class NodeFileReader {
  result: ArrayBuffer | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob): void {
    blob.arrayBuffer().then((buf) => {
      this.result = buf;
      this.onloadend?.();
    });
  }
}
(globalThis as { FileReader?: unknown }).FileReader = NodeFileReader;

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../exports");
mkdirSync(outDir, { recursive: true });

const stlExporter = new STLExporter();

async function dump(name: string, obj: THREE.Object3D): Promise<void> {
  // The procedural builders author geometry in scene-units (mmToThree = ÷100).
  // Bake the inverse so the exported files are in real millimetres — what CAD,
  // slicers, and the BUILD tab (uploads treated as mm) all expect.
  obj.scale.setScalar(MM_PER_THREE_UNIT);
  obj.updateMatrixWorld(true);

  const scene = new THREE.Scene();
  scene.add(obj);

  // GLB (binary, materials/colours preserved)
  const gltf = await new GLTFExporter().parseAsync(scene, { binary: true });
  const glbPath = resolve(outDir, `${name}.glb`);
  writeFileSync(glbPath, Buffer.from(gltf as ArrayBuffer));

  // STL (binary, geometry only — no colour)
  const stl = stlExporter.parse(scene, { binary: true }) as unknown as DataView;
  const stlPath = resolve(outDir, `${name}.stl`);
  writeFileSync(stlPath, Buffer.from(stl.buffer));

  console.log(`wrote ${glbPath}`);
  console.log(`wrote ${stlPath}`);
}

const amp = createMinicircuitsZhl12wPlus(
  { kindId: "rf_amplifier", name: "ZHL-1-2W+", properties: {} } as never,
);
const sw = createMinicircuitsZyswa250dr(
  { kindId: "rf_switch", name: "ZYSWA-2-50DR", properties: {} } as never,
);

await dump("minicircuits_zhl_1_2w_plus", amp);
await dump("minicircuits_zyswa_2_50dr", sw);
console.log("done");
