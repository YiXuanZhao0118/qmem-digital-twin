/**
 * ModeMatchingPanel — shape the DBR seed into the TA, within a Start→End range.
 *
 * Two ways to drive it (see docs/introduce/mode-matching.md):
 *   Method 1 — select NO lens; pick Start + End; the backend optimizes the
 *              existing lenses that currently sit between them.
 *   Method 2 — select the shaping lenses; pick Start + End; get both a
 *              within-range column and an ignore-range column, side by side.
 * Both return a best-efficiency and a shortest-footprint candidate. Each
 * candidate's moves are previewed as a ghost and applied to the SceneObject
 * poses (+ focal via dynamicSources) in one undo step.
 *
 * A plan move is a lab translation + optional roll about the lens's optical
 * centre — the same rigid transform the backend applied to effective_transform,
 * so the twin reproduces the optimizer's η.
 */
import { useCallback, useMemo, useState } from "react";
import * as THREE from "three";
import { Sparkles, Loader2 } from "lucide-react";

import { useSceneStore } from "../../store/sceneStore";
import type { ComponentItem, SceneObject } from "../../types/digitalTwin";
import {
  labDirToThreeLocal,
  sceneObjectEulerFromQuaternion,
  sceneObjectToQuaternion,
} from "../../optical/frames";
import { resolveAnchorPosesLab } from "../../utils/anchorPose";
import {
  runModeMatchApi,
  type ModeMatchMove,
  type ModeMatchResult,
  type ModeMatchSolution,
} from "../../api/client";
import { FloatingPanel } from "../workspace/FloatingPanel";
import { useWorkspace } from "../workspace/WorkspaceProvider";

const LENS_KINDS = new Set(["lens", "lens_biconvex", "lens_plano_convex", "lens_cylindrical"]);
const MIRROR_KINDS = new Set(["mirror", "dichroic_mirror"]);
const BOUNDARY_KINDS = new Set([...MIRROR_KINDS, "beam_splitter"]);
const SEED_KIND = "laser_source";
const TA_KIND = "tapered_amplifier";
const CENTRE_ANCHORS = ["optical_center", "intercept_in"];

type Pose = Partial<Pick<SceneObject, "xMm" | "yMm" | "zMm" | "rxDeg" | "ryDeg" | "rzDeg">>;

function parseFocals(text: string): number[] {
  return text.split(/[,\s]+/).map((t) => Number(t)).filter((n) => Number.isFinite(n) && n !== 0);
}

export function ModeMatchingPanel() {
  const scene = useSceneStore((s) => s.scene);
  const selectedObjectIds = useSceneStore((s) => s.selectedObjectIds);
  const updateSceneObjects = useSceneStore((s) => s.updateSceneObjects);
  const previewObjectTransform = useSceneStore((s) => s.previewObjectTransform);
  const clearPreviewObjectTransform = useSceneStore((s) => s.clearPreviewObjectTransform);
  useWorkspace();

  const kindOf = useCallback(
    (obj: SceneObject) => scene.components.find((c) => c.id === obj.componentId)?.kindId ?? "",
    [scene.components],
  );

  const sources = useMemo(() => scene.objects.filter((o) => kindOf(o) === SEED_KIND), [scene.objects, kindOf]);
  const tas = useMemo(() => scene.objects.filter((o) => kindOf(o) === TA_KIND), [scene.objects, kindOf]);
  const mirrors = useMemo(() => scene.objects.filter((o) => MIRROR_KINDS.has(kindOf(o))), [scene.objects, kindOf]);
  const boundaries = useMemo(
    () => scene.objects.filter((o) => BOUNDARY_KINDS.has(kindOf(o))),
    [scene.objects, kindOf],
  );
  const lenses = useMemo(
    () => selectedObjectIds
      .map((id) => scene.objects.find((o) => o.id === id))
      .filter((o): o is SceneObject => !!o && LENS_KINDS.has(kindOf(o))),
    [selectedObjectIds, scene.objects, kindOf],
  );

  const [seedId, setSeedId] = useState<string | null>(null);
  const [taId, setTaId] = useState<string | null>(null);
  const [startId, setStartId] = useState<string | null>(null);
  const [endpointId, setEndpointId] = useState<string | null>(null);
  const [lockAngles, setLockAngles] = useState(true);
  const [etaTargetText, setEtaTargetText] = useState("0.95");
  const [focalText, setFocalText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ModeMatchResult | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);

  const seed = seedId ? sources.find((o) => o.id === seedId) : sources[0];
  const ta = taId ? tas.find((o) => o.id === taId) : tas[0];
  const method = lenses.length > 0 ? 2 : 1;

  const clearPreview = useCallback(() => {
    clearPreviewObjectTransform();
    setPreviewKey(null);
  }, [clearPreviewObjectTransform]);

  const pivotOf = useCallback((obj: SceneObject): THREE.Vector3 => {
    const comp = scene.components.find((c) => c.id === obj.componentId) as ComponentItem | undefined;
    if (comp) {
      const anchors = resolveAnchorPosesLab(comp, obj, scene);
      const centre = CENTRE_ANCHORS.map((id) => anchors.find((a) => a.anchorId === id)).find((a) => !!a) ?? anchors[0];
      if (centre) return new THREE.Vector3(centre.posLab.x, centre.posLab.y, centre.posLab.z);
    }
    return new THREE.Vector3(obj.xMm, obj.yMm, obj.zMm);
  }, [scene]);

  const poseFromMove = useCallback((obj: SceneObject, move: ModeMatchMove, pivot: THREE.Vector3): Pose => {
    const t = move.translateWorldMm;
    const deg = move.rotateDeg ?? 0;
    if (Math.abs(deg) < 1e-6) {
      return { xMm: obj.xMm + t.x, yMm: obj.yMm + t.y, zMm: obj.zMm + t.z };
    }
    const rad = (deg * Math.PI) / 180;
    const axisLab = new THREE.Vector3(move.rotateAxisWorld.x, move.rotateAxisWorld.y, move.rotateAxisWorld.z).normalize();
    const rLab = new THREE.Quaternion().setFromAxisAngle(axisLab, rad);
    const rel = new THREE.Vector3(obj.xMm - pivot.x, obj.yMm - pivot.y, obj.zMm - pivot.z).applyQuaternion(rLab);
    const aLocal = labDirToThreeLocal(move.rotateAxisWorld).normalize();
    const qDelta = new THREE.Quaternion().setFromAxisAngle(aLocal, rad);
    const e = sceneObjectEulerFromQuaternion(qDelta.multiply(sceneObjectToQuaternion(obj)));
    return {
      xMm: pivot.x + rel.x + t.x, yMm: pivot.y + rel.y + t.y, zMm: pivot.z + rel.z + t.z,
      rxDeg: e.rxDeg, ryDeg: e.ryDeg, rzDeg: e.rzDeg,
    };
  }, []);

  const solve = useCallback(async () => {
    if (!seed || !ta) return;
    setBusy(true);
    setFeedback(null);
    setResult(null);
    clearPreview();
    try {
      const focalInventory: Record<string, number[]> = {};
      for (const l of lenses) {
        const fs = parseFocals(focalText[l.id] ?? "");
        if (fs.length) focalInventory[l.id] = fs;
      }
      const etaTarget = etaTargetText.trim() ? Number(etaTargetText) : null;
      const res = await runModeMatchApi({
        seedEmitterId: seed.id,
        taObjectId: ta.id,
        movableIds: lenses.map((l) => l.id), // empty ⇒ Method 1
        startId: startId ?? undefined,
        endpointId: endpointId ?? undefined,
        rollDeg: lockAngles ? 0 : 90,
        etaTarget,
        focalInventory: Object.keys(focalInventory).length ? focalInventory : undefined,
      });
      setResult(res);
      setFeedback(res.solutions.length ? null : "No solution returned.");
    } catch (err) {
      setFeedback(`Solve failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [seed, ta, lenses, focalText, etaTargetText, startId, endpointId, lockAngles, clearPreview]);

  const previewSolution = useCallback((sol: ModeMatchSolution) => {
    clearPreviewObjectTransform();
    for (const move of sol.moves) {
      const obj = scene.objects.find((o) => o.id === move.objectId);
      if (obj) previewObjectTransform(move.objectId, poseFromMove(obj, move, pivotOf(obj)));
    }
    setPreviewKey(sol.key);
  }, [scene.objects, previewObjectTransform, clearPreviewObjectTransform, poseFromMove, pivotOf]);

  const applySolution = useCallback(async (sol: ModeMatchSolution) => {
    setBusy(true);
    try {
      clearPreview();
      await updateSceneObjects(sol.moves.map((move) => {
        const obj = scene.objects.find((o) => o.id === move.objectId)!;
        const pose = poseFromMove(obj, move, pivotOf(obj));
        const patch: Record<string, unknown> = { ...pose };
        if (move.focalMm != null) {
          patch.dynamicSources = { ...((obj.dynamicSources ?? {}) as Record<string, unknown>), focalLengthMm: move.focalMm };
        }
        return { objectId: move.objectId, patch: patch as never };
      }));
      setFeedback(`Applied “${sol.label}” — ${sol.moves.length} move${sol.moves.length === 1 ? "" : "s"} (undo restores all).`);
    } catch (err) {
      setFeedback(`Apply failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [scene.objects, updateSceneObjects, poseFromMove, pivotOf, clearPreview]);

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, margin: "4px 0" };
  const rangeSol = result?.solutions.filter((s) => s.column === "range") ?? [];
  const freeSol = result?.solutions.filter((s) => s.column === "free") ?? [];

  const card = (sol: ModeMatchSolution) => (
    <div key={sol.key} style={{ border: "1px solid #3a3a3a", borderRadius: 6, padding: 8, marginBottom: 8, fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{sol.label}</div>
      <div>η {pct(sol.etaBaseline)} → <b>{pct(sol.eta)}</b></div>
      <div>length {sol.lengthMm.toFixed(1)} mm</div>
      <div style={{ color: sol.feasible ? "#4caf50" : "#e57373" }}>{sol.feasible ? "✓ meets target" : "✗ below target"}</div>
      {sol.reason && <div style={{ color: "#e0a060" }}>{sol.reason}</div>}
      <div style={{ margin: "4px 0" }}>
        {sol.moves.map((m) => {
          const t = m.translateWorldMm;
          const sh = Math.hypot(t.x, t.y, t.z);
          return (
            <div key={m.objectId}>
              {m.name}: {sh.toFixed(1)}mm
              {Math.abs(m.rotateDeg) > 1e-3 && `, roll ${m.rotateDeg.toFixed(1)}°`}
              {m.focalMm != null && `, f→${m.focalMm}`}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" style={{ flex: 1 }} disabled={!sol.moves.length}
          onClick={() => (previewKey === sol.key ? clearPreview() : previewSolution(sol))}>
          {previewKey === sol.key ? "Clear" : "Preview"}
        </button>
        <button type="button" className="primary-button" style={{ flex: 1 }} disabled={busy || !sol.moves.length}
          onClick={() => applySolution(sol)}>Apply</button>
      </div>
    </div>
  );

  return (
    <FloatingPanel id="mode-matching" title="Mode matching" icon={<Sparkles size={15} />}
      badge={result ? `${result.solutions.length} sol` : undefined}>
      <div style={{ padding: 10, fontSize: 13 }}>
        {!seed || !ta ? (
          <p style={{ opacity: 0.7 }}>Needs a <code>laser_source</code> and a <code>tapered_amplifier</code> in the scene.</p>
        ) : (
          <>
            <label style={row}><span>Seed</span>
              <select value={seed.id} onChange={(e) => setSeedId(e.target.value)}>
                {sources.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select></label>
            <label style={row}><span>TA</span>
              <select value={ta.id} onChange={(e) => setTaId(e.target.value)}>
                {tas.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select></label>
            <label style={row}><span>Start</span>
              <select value={startId ?? ""} onChange={(e) => setStartId(e.target.value || null)}>
                <option value="">(none)</option>
                {boundaries.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select></label>
            <label style={row}><span>End</span>
              <select value={endpointId ?? ""} onChange={(e) => setEndpointId(e.target.value || null)}>
                <option value="">(none)</option>
                {mirrors.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select></label>

            <div style={{ margin: "8px 0 4px", fontWeight: 600 }}>
              {method === 2 ? `Method 2 · ${lenses.length} lens selected` : "Method 1 · auto-detect lenses in range"}
            </div>
            {method === 2 ? (
              lenses.map((l) => (
                <label key={l.id} style={row}>
                  <span style={{ flex: 1 }}>{l.name}</span>
                  <input style={{ width: 130 }} placeholder="focal inventory" value={focalText[l.id] ?? ""}
                    onChange={(e) => setFocalText((m) => ({ ...m, [l.id]: e.target.value }))}
                    title="Focal lengths to try, e.g. -24.88, -40, -60. Empty = keep current." />
                </label>
              ))
            ) : (
              <p style={{ opacity: 0.7, fontSize: 12 }}>
                Select lenses in the viewer for Method 2 (per-lens focal inventory + ignore-range column).
                {result && result.detectedLenses.length > 0 && <> Detected: {result.detectedLenses.join(", ")}.</>}
              </p>
            )}

            <label style={row}><span>Target η</span>
              <input style={{ width: 80 }} value={etaTargetText} onChange={(e) => setEtaTargetText(e.target.value)} /></label>
            <label style={row}><span>Lock element angles</span>
              <input type="checkbox" checked={lockAngles} onChange={(e) => setLockAngles(e.target.checked)} /></label>

            <button type="button" className="primary-button" style={{ width: "100%", marginTop: 8 }}
              disabled={busy || (!startId && !endpointId)} onClick={solve}>
              {busy ? <Loader2 size={14} className="spin" /> : "Solve mode match"}
            </button>

            {result && (
              <div style={{ marginTop: 10 }}>
                {freeSol.length > 0 ? (
                  <div style={{ display: "flex", gap: 8 }}>
                    <div style={{ flex: 1 }}>{rangeSol.map(card)}</div>
                    <div style={{ flex: 1 }}>{freeSol.map(card)}</div>
                  </div>
                ) : (
                  rangeSol.map(card)
                )}
                {result.solutions.length === 0 && <p style={{ opacity: 0.7 }}>No feasible placement found.</p>}
              </div>
            )}

            {feedback && <p style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>{feedback}</p>}
          </>
        )}
      </div>
    </FloatingPanel>
  );
}

/** Launcher in the Object/Component panel — opens Mode matching. Shows whether
 *  the current selection drives Method 2 (lenses) or Method 1 (none). */
export function ModeMatchingLauncher() {
  const scene = useSceneStore((s) => s.scene);
  const selectedObjectIds = useSceneStore((s) => s.selectedObjectIds);
  const { togglePanelVisible, focusPanel } = useWorkspace();

  const lensCount = useMemo(() => selectedObjectIds.filter((id) => {
    const o = scene.objects.find((x) => x.id === id);
    if (!o) return false;
    const kind = scene.components.find((c) => c.id === o.componentId)?.kindId ?? "";
    return LENS_KINDS.has(kind);
  }).length, [selectedObjectIds, scene.objects, scene.components]);

  return (
    <section className="edit-section">
      <h3><Sparkles size={17} /> Mode matching</h3>
      <button type="button" className="primary-button"
        title="Optimize the shaping lenses so the DBR seed couples into the TA, within a Start→End range."
        onClick={() => { togglePanelVisible("mode-matching", true); focusPanel("mode-matching"); }}>
        {lensCount > 0 ? `Mode-match with ${lensCount} lens${lensCount === 1 ? "" : "es"}…` : "Mode matching (auto-detect)…"}
      </button>
    </section>
  );
}
