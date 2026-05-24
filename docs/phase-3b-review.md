# Phase 3b Code + Design Review

> Audit done 2026-05-21,covers the Asset-Physics-Model v3 ray tracer
> additions in **Phase 3a + 3b**(BeamRay struct,Kind Registry,3 ops,
> single-asset trace,scene-level trace with lab↔body transforms)。
> 對應檔案結構文件:[`asset-physics-implementation.md`](asset-physics-implementation.md)。

---

## 1. 摘要

| 狀態 | 內容 |
|------|------|
| ✅ **跑通** | BeamRay struct、Kind Registry、3 ops (lens/mirror/polarizer)、單 asset 與 scene-level tracer、前後端數值對齊 |
| 🟡 **部分** | Jones polarization 的 frame-relative 處理(beam-local s/p 約定夠用,但 polarizer 的 body 旋轉沒投射到 beam frame) |
| ❌ **未做** | ComponentBinding tree(Phase 3c)、Feature flag v2/v3 切換(Phase 3d)、Asset Editor UI(Phase 4) |

**測試**:Frontend **27** new tests + Backend **24** new tests,全綠;唯一既有 AOM Bragg 失敗不在 v3 範圍內。

---

## 2. 檔案地圖

### Frontend(`frontend/src/`)

| 檔案 | 行數 | 用途 |
|------|------|------|
| `optical/beam-ray.ts` | ~110 | `BeamRay` struct + `Vec3` utility + `makeBeamRay` |
| `optical/jones.ts` | ~110 | s/p basis 計算 + 反射時的 basis flip 處理 |
| `optical/registry.ts` | ~135 | `OpticalKind` enum + `PhysicsOp` interface + `registerKind` / `getOp` |
| `optical/pose.ts` | ~95 | `V3Pose` + lab↔body Vec3 變換(內部用 THREE 但 API 純 Vec3) |
| `optical/ray-tracer-v3.ts` | ~360 | `intersectFace` / `nearestFaceHit` / `traceRayThroughAsset` / `traceRayScene` |
| `optical/kinds/lens/physics.ts` | ~80 | `abcd_thin_lens` op (wraps `mThinLens`) |
| `optical/kinds/mirror/physics.ts` | ~50 | `reflect_specular` op |
| `optical/kinds/polarizer/physics.ts` | ~115 | `jones_polarizer` op + Malus's law + Jones 重正規化 |
| `store/v3CatalogStore.ts` | ~110 | Zustand store + fetch /api/v3/assets3d, /components |

### Backend(`backend/app/optical/`)

對應的 Python 鏡像,加上 `kinds/__init__.py` 的 eager-import,以及 `app/schemas_v3.py` + `app/routers/v3_catalog.py`。

### 測試
- `frontend/src/optical/__tests__/ray-tracer-v3.test.ts` — 14 tests
- `frontend/src/optical/__tests__/ray-tracer-v3-scene.test.ts` — 13 tests
- `frontend/src/optical/kinds/{lens,mirror,polarizer}/physics.test.ts` — 6+8+10 = 24 tests
- `backend/tests/optical/test_{lens,mirror,polarizer,ray_tracer_v3}.py` — 6+8+10+14 = 38 tests

---

## 3. 關鍵設計決定

### 3.1 BeamRay 是 single value 流過整個 tracer
不分「光線」與「高斯波包」兩個物件,合在一個 `BeamRay`:
- chief ray (`origin` / `direction`)— 巨觀導引
- `qx`, `qy` 各自獨立 Complex — 微觀波包,**支援像散**
- `jones: [E_s, E_p]` — beam-local s/p frame
- `pathLengthMm`, `phaseAccumRad` — 累積資料(不自動疊加 — out-of-scope)
- `excludeFaceKey` — 出射 face id,避免 re-hit

**權衡**:struct 較肥(8 個欄位 + 兩個 Complex)但介面統一,op 只需要一個輸入。

### 3.2 PhysicsOp 是 pure function,Registry 統一查表
```typescript
type PhysicsOp = (rayIn: BeamRay, ctx: PhysicsOpContext) => BeamRay[]
```
**回傳陣列** → 自然支援 branching(AOM 多階、PBS transmit+reflect、AR ghost ray)。沒有的話將來要重構。

Kind Registry 在 `registry.ts`,**code-only 不入 DB**。每個 kind 模組 import 時 side-effect 註冊。

### 3.3 Face hit 用 ray-plane intersection,aperture 用 inscribed radius
- `intersectFace`:平面方程 `(p - facePos) · n = 0`,解 t
- aperture 用半寬 `apertureMm` 比對 offset_perpendicular,**circle / rectangle / ellipse 用同一個近似**(rectangle 的對角不過 — Phase 4 要改成 shape-aware)
- `tMin = 1e-9` 防 origin 落在面上時拿到 t=0 自己撞自己

### 3.4 `excludeFaceKey` 防 re-hit
出射 ray 帶 `excludeFaceKey = "<faceId>"`(單 asset)或 `"<sceneObjectId>/<faceId>"`(scene)。下次 `intersectFace` 直接跳過。

**陷阱**:這代表 ray 永遠不會「立刻撞回自己離開的那個面」 — 對 transmission 是對的(物理上 ray 已離開該面)。但對 mirror,反射後再撞同一面 = 折回入射方向,通常物理上不會發生(撞鏡面後在背側自由空間)。目前測試都通過。

### 3.5 Absorbed ray 進 `finalRays` 不丟掉
op 回傳 powerMw=0 的 ray → 直接 push 到 `finalRays`(不進 queue)。caller 看得到「光在哪裡被吃」。
```typescript
if (tagged.powerMw < powerThreshold) finalRays.push(tagged);
else queue.push(tagged);
```

### 3.6 Pose 用既有 frames.ts 約定:`THREE.Euler(rxDeg, rzDeg, -ryDeg, "YXZ")`
**這不是直觀的「ryDeg 繞 Y 軸」** — 因為 Three.js Euler 參數順序被重排。
- `rxDeg=90` → 真的繞 lab X 軸轉
- `ryDeg=90` → 實際是 `Z(-90)`(感謂的旋轉)
- 文件已標 Phase 3 要釐清這個

**為什麼跟著用**:`frames.sceneObjectToQuaternion` 已是現有 renderer 的 source of truth,改它會破舊 scene 顯示。Phase 3+ 接這個約定保 v2/v3 並存。

### 3.7 Lab ↔ body 變換內部用 THREE.Quaternion,API 純 Vec3
`pose.ts` 把 THREE 藏起來。下游 ray-tracer-v3.ts、ops、tests 都不接觸 THREE。這讓 Phase 5 想換成 WASM 時介面不變。

### 3.8 Scene tracer 不重複實作 single-asset 邏輯
`traceRayScene` 共用 `findTransitionContexts`、`intersectFace`,只擴增「找最近 scene hit」與「lab↔body 變換」。Single-asset tracer(Phase 3a)保留,給簡單測試用。

### 3.9 `excludeFaceKey` scene-scoped 編碼
```
"<sceneObjectId>/<faceId>"
```
- ray 從 `lens1` 的 face B 出來 → `excludeFaceKey = "lens1/B"`
- 撞到 `lens2` 時,decode 過濾只比對 `lens2/...` 的 prefix → 看 face B 不在 lens2 的排除列表
- 兩個 scene object 即使都叫 "A" 不衝突

### 3.10 Jones 跨 frame 變換的折衷
目前 op 在 body frame 接 ray,jones 原樣帶過(不轉換)。**這對 lens 是對的**(polarization preserving),但 polarizer 的 transmission axis 假設是 beam-local +s frame,如果 polarizer 的 body 被旋轉(例 IO-3 的 output_pol rz=45°),op 接到的 jones 還是 lab beam-local s/p,沒套用 rz 旋轉。

→ **Phase 4 待修**:op 拿到 ray 前 ray tracer 套用 body→beam basis rotation,op 結果再轉回。或者:每個 op 自己宣告 jones frame 假設,tracer 自動橋接。

---

## 4. 已知限制與 Phase 3c+ 待補

| # | 限制 | Phase |
|---|------|-------|
| L1 | SceneObject 直接指向 single asset,不支援 Component(ComponentBinding tree) | 3c |
| L2 | v2 與 v3 並存,但沒有 feature flag 切換,UI 端尚未 wire 到 v3 | 3d / 4 |
| L3 | Jones 跨 binding rotation 沒處理(見 §3.10) | 4 |
| L4 | aperture check 用 inscribed radius — rectangle 對角不過 | 4 |
| L5 | 沒有 anchor adapter — Smart Placement 與 Assembly Solver 還用舊 anchor | 4 |
| L6 | tracer 沒記 phase / coherence(資料已存,但不自動疊加) | Out-of-scope(設計選擇) |
| L7 | PowerShell `Set-Content` 編碼曾搞壞兩個 JSON(中文 → mojibake),Phase 0 中文註解現在改 ASCII | 已修(Phase 2) |
| L8 | uvicorn `--reload` 沒撿到 main.py 變更(Windows file watcher 漏);workaround = 重啟 | 環境issue |

---

## 5. 測試覆蓋

### Frontend (vitest)

| 檔案 | tests | 重點 |
|------|-------|------|
| `kinds/lens/physics.test.ts` | 6 | registration、focal=50 q-transform、preservation invariants |
| `kinds/mirror/physics.test.ts` | 8 | normal/45° reflection、reflectivity、Jones 透傳 |
| `kinds/polarizer/physics.test.ts` | 10 | Malus 0°/30°/45°/90°、s/p block、Jones 重正規化 |
| `__tests__/ray-tracer-v3.test.ts` | 14 | intersectFace、nearestFaceHit、單 asset 三種 kind 完整跑、maxSteps / power threshold |
| `__tests__/ray-tracer-v3-scene.test.ts` | 13 | pose round-trip 4 cases × 2 = 8、scene scenarios 5 |

### Backend (pytest)

| 檔案 | tests | 重點 |
|------|-------|------|
| `tests/optical/test_lens.py` | 6 | 對應 frontend lens tests |
| `tests/optical/test_mirror.py` | 8 | 對應 frontend mirror tests |
| `tests/optical/test_polarizer.py` | 10 | 對應 frontend polarizer tests |
| `tests/optical/test_ray_tracer_v3.py` | 14 | pose round-trip + scene scenarios |

### Numerical parity
兩端使用同一套公式(scipy `Rotation.from_euler("YXZ", ...)` 對應 THREE.Euler YXZ),測試獨立用解析解驗證。**沒有跑統一 golden fixture**(留給 Phase 3d 的 v2 vs v3 parity test infrastructure)。

---

## 6. 學到的怪癖

### 6.1 Three.js Euler YXZ + 重排參數 ≠ 一般人想的歐拉角
專案的 `THREE.Euler(rxDeg, rzDeg, -ryDeg, "YXZ")` 約定讓 `ryDeg` 的語意不是「繞 Y 軸」。新加 dev 一定會踩。文件需要在 frames.ts 旁邊加大紅字。

### 6.2 PowerShell `Set-Content` 默認 cp950 編碼
動 JSON 含中文時要 `-Encoding UTF8` 或用 Python 寫。Phase 2 因此踩過,結果是中文註解 mojibake 後 JSON 無法解析。

### 6.3 uvicorn `--reload` 在 Windows 不可靠
file watcher 在 OneDrive / VS Code Watcher 多重情境下有時不觸發。手動重啟比較穩。

### 6.4 PowerShell 5.1 無 `??` 運算子
解析 JSON 回傳時別用 `$_.physicsKind ?? "(mech)"` — 改 `if`/`else` 三元寫法。

### 6.5 scipy 的 `from_euler` 大寫小寫意義不同
- `"yxz"` (小寫) = extrinsic
- `"YXZ"` (大寫) = intrinsic ← 對應 Three.js

不小心寫小寫會 rotation 方向錯。

### 6.6 Asset3D JSON 不能有 `+` 前綴數字
`{ "z": +2.05 }` 不是合法 JSON。Python json.load 會拋 syntax error。中間用 PowerShell 一行 regex 清掉:
```powershell
[regex]::Replace($content, ':\s*\+(\d)', ': $1')
```

---

## 7. 下一步銜接 Phase 3c

**Phase 3c 主軸 = ComponentBinding tree 支援**:

當前 V3SceneObject 直接指 single Asset3D。Phase 3c 要支援 Component 級:
```
SceneObject → Component → [Binding × N] → Asset3D
```

每個 binding 有 component-local 的 pose,組合起來:
```
ray_lab → SceneObject.pose⁻¹ → ray_comp → binding.localPose⁻¹ → ray_body
```

**技術重點**:YXZ Euler 在組合下**不封閉**(`Y · X · Z · Y · X · Z ≠ Y · X · Z`),所以 pose composition 必須用 quaternion 做。`pose.ts` 要加 `V3Transform`(內部用 quaternion + translation),`composeTransforms(parent, child)` 給 ray tracer 用。

**第一個真實場景**:IO-3-850-HP 跑 forward + reverse beam,驗證 isolator 隔離效應自然湧現(forward 過,reverse 被 input_pol 擋)。
