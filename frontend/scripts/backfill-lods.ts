/**
 * P2 — backfill LOD tiers for the existing catalog (docs/objectives.md §R-5).
 *
 * Until an asset has tiers the runtime switch has nothing to switch to, so it
 * renders LOD0 at every distance. This walks the catalog, decimates each
 * eligible asset's GLB through the SAME code BUILD uses (`buildLodTiers`), and
 * POSTs the tiers to `/api/v3/assets3d/{key}/lods`.
 *
 * It writes only the `asset_lods` table and new tier files. **Asset rows are
 * never touched**, which is why it works on locked assets — a derived render
 * artifact must not need a human unlock (see the route's docstring).
 *
 * Run (backend must be up):
 *   npx vite-node scripts/backfill-lods.ts -- --dry-run
 *   npx vite-node scripts/backfill-lods.ts
 *   npx vite-node scripts/backfill-lods.ts -- --force --only optical_table
 *
 * Flags:
 *   --dry-run      decimate and report, upload nothing
 *   --force        regenerate assets that already have tiers
 *   --only <slug>  restrict to one catalog_id (repeatable)
 *   --api <url>    backend base URL (default http://localhost:8010)
 *
 * Eligibility: **GLB only**. That is not a convenience — it is the same set
 * the runtime honours. STL assets go through the bespoke builders (PBS252,
 * BB1E03, AD9959, isolator) whose geometry post-processing a decimated tier
 * would not survive, and `primitive://` / `procedural://` assets are already
 * cheap. Anything skipped is listed in the summary rather than silently
 * dropped.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/**
 * The only browser API three needs here: `GLTFExporter.writeAsync` finishes a
 * binary GLB with `new FileReader().readAsArrayBuffer(blob)`. Node has `Blob`
 * natively but no `FileReader`, and installing happy-dom's would pair ITS
 * FileReader with Node's Blob — which throws "parameter 1 is not of type
 * 'Blob'". A four-line shim over the native `Blob.arrayBuffer()` keeps one
 * implementation on both sides, so no DOM library is needed at all.
 *
 * Must be installed before three's exporter is imported — hence the dynamic
 * imports in `main` rather than static ones up here.
 */
class NodeFileReader {
  result: ArrayBuffer | null = null;
  onloadend: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readAsArrayBuffer(blob: Blob): void {
    blob.arrayBuffer().then(
      (buffer) => { this.result = buffer; this.onloadend?.(); },
      (err) => this.onerror?.(err),
    );
  }
}
(globalThis as Record<string, unknown>).FileReader ??= NodeFileReader;

interface Args {
  dryRun: boolean;
  force: boolean;
  only: string[];
  api: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, force: false, only: [], api: "http://localhost:8010" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") args.force = true;
    else if (a === "--only") args.only.push(argv[++i]);
    else if (a === "--api") args.api = argv[++i];
  }
  return args;
}

interface CatalogAsset {
  id: string;
  catalogId: string | null;
  name: string;
  assetType: string;
  filePath: string;
  locked: boolean;
  lods: { level: number }[];
}

const REPO_ROOT = path.resolve(process.cwd(), "..");
const ASSET_ROOT = path.join(REPO_ROOT, "assets");

/** A tier must cut at least this fraction of the triangles of the finest tier
 *  kept so far, or it is not stored. Below that the extra file and the swap
 *  cost more than the geometry they save, and a tier that is a near-copy of
 *  LOD0 makes the switch look broken rather than absent. */
const MIN_TIER_REDUCTION = 0.25;

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(2)} MB`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [
    { GLTFLoader },
    { LOD_TIER_TARGETS, buildLodTiers, lod0TriangleCount },
    { mergeGeometriesForLod },
  ] = await Promise.all([
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("../src/three/lod/buildTiers"),
    import("./lodMergeGeometry"),
  ]);

  const res = await fetch(`${args.api}/api/v3/assets3d?has_v3=false`);
  if (!res.ok) throw new Error(`catalog fetch failed: ${res.status} ${res.statusText}`);
  const assets = (await res.json()) as CatalogAsset[];

  const skipped: string[] = [];
  const eligible = assets.filter((a) => {
    const key = a.catalogId ?? a.id;
    if (args.only.length && !args.only.includes(key)) return false;
    if (a.assetType !== "glb") {
      skipped.push(`${key}: not GLB (${a.assetType}) — outside the runtime LOD path`);
      return false;
    }
    if (a.lods.some((t) => t.level > 0) && !args.force) {
      skipped.push(`${key}: already has tiers (use --force to regenerate)`);
      return false;
    }
    return true;
  });

  console.log(
    `catalog: ${assets.length} assets | eligible: ${eligible.length} | skipped: ${skipped.length}` +
      (args.dryRun ? "  [DRY RUN — nothing will be uploaded]" : ""),
  );

  const loader = new GLTFLoader();
  const coarsestBudget = Math.min(...LOD_TIER_TARGETS.map((t) => t.maxTriangles));
  let done = 0;
  const failures: string[] = [];

  for (const asset of eligible) {
    const key = asset.catalogId ?? asset.id;
    const absolute = path.join(ASSET_ROOT, asset.filePath);
    try {
      const bytes = await readFile(absolute);
      const gltf = await loader.parseAsync(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        "",
      );
      // The tiers must be decimated from ONE geometry. A GLB is usually many
      // meshes, so merge first — which also collapses the draw calls, the
      // thing that actually moves R-6's budget on a multi-part board.
      const merged = mergeGeometriesForLod(gltf.scene);
      if (!merged) {
        skipped.push(`${key}: no mesh geometry in the GLB`);
        continue;
      }

      const lod0Tris = lod0TriangleCount(merged);
      // Already inside the coarsest budget: every tier would come back as an
      // untouched copy with errorMm 0, i.e. three identical files and a switch
      // that can never do anything useful. Storing that is pure cost.
      if (lod0Tris <= coarsestBudget) {
        merged.dispose();
        skipped.push(
          `${key}: ${(lod0Tris / 1000).toFixed(1)}k tris is already under the LOD2 budget ` +
            `(${coarsestBudget / 1000}k) — tiers would be identical copies`,
        );
        continue;
      }

      const built = await buildLodTiers(merged);
      merged.dispose();

      // Keep only tiers that earn their place. Two ways one does not:
      //   * the budget was already met, so the simplifier returned the source
      //     untouched (error 0, same triangle count);
      //   * the mesh RESISTED simplification — the AD9959 PCB is the live
      //     example, where LockBorder plus a forest of thin open-bordered
      //     plates leaves both tiers at ~89% of LOD0. Two 14 MB files that
      //     look identical to LOD0 are worse than no tiers at all.
      // Judging each tier against the finest one KEPT (not against LOD0)
      // stops a pair of near-identical tiers both surviving.
      const kept: typeof built = [];
      const rejected: string[] = [];
      let reference = lod0Tris;
      for (const tier of built) {
        const reduction = 1 - tier.triangles / reference;
        if (reduction >= MIN_TIER_REDUCTION) {
          kept.push(tier);
          reference = tier.triangles;
        } else {
          rejected.push(`LOD${tier.level} ${(reduction * 100).toFixed(0)}%`);
        }
      }

      const report = kept
        .map(
          (t) =>
            `LOD${t.level} ${(t.triangles / 1000).toFixed(1)}k/${mb(t.glb.byteLength)} ±${t.errorMm.toFixed(3)}mm`,
        )
        .join("  ");
      console.log(
        `  ${key.padEnd(28)} LOD0 ${(lod0Tris / 1000).toFixed(1)}k/${mb(bytes.byteLength)}  ` +
          (report || "(no tier worth keeping)") +
          (rejected.length ? `   dropped: ${rejected.join(", ")}` : "") +
          (asset.locked ? "  [locked]" : ""),
      );

      if (kept.length === 0) {
        skipped.push(
          `${key}: no tier cut ≥${MIN_TIER_REDUCTION * 100}% of the triangles ` +
            `(${rejected.join(", ")}) — mesh resists simplification`,
        );
        continue;
      }
      if (args.dryRun) { done++; continue; }

      await postTier(args.api, key, { level: 0, triCount: lod0Tris, errorMm: 0 });
      for (const tier of kept) {
        await postTier(args.api, key, {
          level: tier.level,
          triCount: tier.triangles,
          errorMm: tier.errorMm,
          glb: tier.glb,
        });
      }
      done++;
    } catch (err) {
      failures.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\ndone: ${done}/${eligible.length}`);
  if (skipped.length) {
    // Never let a skip pass silently — a quiet truncation reads as "covered
    // everything" when it did not.
    console.log(`\nskipped (${skipped.length}):`);
    for (const s of skipped) console.log(`  - ${s}`);
  }
  if (failures.length) {
    console.log(`\nFAILED (${failures.length}):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

async function postTier(
  api: string,
  key: string,
  tier: { level: number; triCount: number; errorMm: number; glb?: ArrayBuffer },
): Promise<void> {
  const form = new FormData();
  form.append("level", String(tier.level));
  form.append("tri_count", String(tier.triCount));
  form.append("error_mm", String(tier.errorMm));
  if (tier.glb) {
    form.append(
      "file",
      new Blob([tier.glb], { type: "model/gltf-binary" }),
      `${key}.lod${tier.level}.glb`,
    );
  }
  const res = await fetch(`${api}/api/v3/assets3d/${encodeURIComponent(key)}/lods`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(`tier ${tier.level} upload failed: ${res.status} ${await res.text()}`);
  }
}

void main();
