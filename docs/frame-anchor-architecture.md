# Frame / Anchor 架構與優化路線圖

> **Status**: 設計+實作參考。最後校對 2026-05-27,基於 commit 795e816 (working tree, uncommitted body-frame work 已部分套用)。
> **Scope**: 涵蓋 frame 階層、anchor schema、OpticalLink / RfLink、Fiber / RfCable spline、PPG mount、mesh 渲染 frame、節點(node)語意衝突,以及目前已知的優化方向。
> **為什麼存在**: 這個檔案是「下次寫 frame / anchor / link / cable 相關 code 之前一定要先看」的單一入口。codebase 內 body frame 在多處有歷史遺留歧義(Phase 9.10 vs 9.11),此檔案紀錄目前**實作上實際使用的語意**,並追蹤需要收斂的點。

> **同類文件交叉參考**:
> - [`asset-physics-model.md`](./asset-physics-model.md) — 物理 op、Face/Transition、ABCD 5×5 設計
> - [`ARCHITECTURE_OVERVIEW.md`](./ARCHITECTURE_OVERVIEW.md) — 整個 stack 的 top-down 視角
> - [`vibe coding.md`](./vibe%20coding.md) — frame / unit convention、align 演算法(notebook 形式)

---

## 目次

- [Part A — 架構參考](#part-a--架構參考)
  - [1. 三層資料模型](#1-三層資料模型)
  - [2. Frame 階層(5 層)](#2-frame-階層5-層)
  - [3. Body frame 語意 — Phase 9.10 vs 9.11 的歷史包袱](#3-body-frame-語意--phase-910-vs-911-的歷史包袱)
  - [4. Anchor schema 與命名](#4-anchor-schema-與命名)
  - [5. 「Node」三個意思](#5-node-三個意思)
  - [6. OpticalLink 架構](#6-opticallink-架構)
  - [7. RfLink 架構](#7-rflink-架構)
  - [8. Fiber 架構](#8-fiber-架構)
  - [9. RfCable 架構](#9-rfcable-架構)
  - [10. PPG mount 特例](#10-ppg-mount-特例)
  - [11. Mesh 渲染 frame(Lab scene vs PHY editor)](#11-mesh-渲染-framelab-scene-vs-phy-editor)
  - [12. 整體關係圖](#12-整體關係圖)
  - [13. 命名 / 規約對照表](#13-命名--規約對照表)
- [Part B — 變更紀錄](#part-b--變更紀錄)
  - [14. 2026-05-27 body-frame alignment 修正](#14-2026-05-27-body-frame-alignment-修正)
  - [14.5 §15.1 / §15.2 / §15.3 後續優化落地](#145-2026-05-27-§151--§152--§153-後續優化落地)
  - [14.6 §17.1 / §17.2 / §17.3 / §16.5 後續優化落地](#146-2026-05-27-§171--§172--§173--§165-後續優化落地)
  - [14.7 §17.4 / §16.1 / §16.2 + 端到端測試](#147-2026-05-27-§174--§161--§162--端到端測試落地)
- [Part C — 優化路線圖](#part-c--優化路線圖)
  - [15. 高優先](#15-高優先再不修下次還會爆)
  - [16. 中優先](#16-中優先維護成本)
  - [17. 低優先](#17-低優先qol)
  - [18. 已知 invariants 與 test gap](#18-已知-invariants-與-test-gap)

---

# Part A — 架構參考

## 1. 三層資料模型

| 層 | 表 | 角色 | 數量 |
|---|---|---|---|
| **Asset3D** | `assets_3d` | 一個 3D 檔(STL/GLB/STEP/procedural)+ anchors / body frame / 物理 kind / defaultParams | 整 catalog |
| **Component** | `components` | 一個型號("AOMO 3080" / "DBR-852-TOSA"),由一棵 `ComponentBinding` 樹組成 | 每型號 1 |
| **SceneObject** | `objects` | scene 內一個實體(同型號可放多顆),帶 lab pose / locks / per-instance override | scene 內 N |

額外結構:
- **ComponentBinding**(alembic 0062)— Component 的 composition tree node,把 sub-asset 或 sub-component 用 local pose 串成樹
- **ObjectBinding**(alembic 0076)— SceneObject 對某個 ComponentBinding 的 per-instance pose delta(`localXMmDelta` 等)

---

## 2. Frame 階層(5 層)

座標**從上到下**依序套(每層的 origin 都定義在上一層):

```
Lab frame  (mm, Z-up)
   │  ← SceneObject pose (xMm,yMm,zMm,rxDeg,ryDeg,rzDeg) ZXZ intrinsic Euler
   ▼
Object-local frame  ≡  CAD frame  (mm)        ★ doc 也叫 "Lab Sense 之下的 object-local"
   │  ← bodyFramePositionMm (bfp) + bodyFrameRotation (R_body)
   ▼
Body frame  (mm)                               ★ 物理乾淨座標
   │            +Z = 光軸(2-port slab 嚴格成立)
   │            +X = 物理橫向參考軸(快軸 / 聲軸 / s 偏振)
   │            +Y = X × Z
   │  ← ComponentBinding(local_xyz_mm + local_rxyz_deg)
   ▼
Binding-local frame  (mm)                      — composition tree 子節點所在
   │  ← ObjectBinding delta(per-instance 偏移)
   ▼
Effective binding frame
   │  ← anchor.positionMmBodyLocal / axisXBodyLocal
   ▼
Anchor frame  (mm + 單位向量)
```

### 2.1 三個關鍵公式(目前實作)

```
lab_point   = SceneObject_pose · (R_body · point_body + bfp)
            = SceneObject_pose · point_object_local

lab_dir     = SceneObject_rotation · R_body · dir_body

anchor_lab  = obj.xyz + rotateVecLab(
                R_body × anchor.positionMmBodyLocal + bfp,
                rxDeg, ryDeg, rzDeg
              )
```

> ⚠️ **注意公式形式**:目前實作把 `bfp` 加在 `R_body × B` **之後**(把 bfp 當 CAD-axis 處理),不是 `R_body × (B + bfp)`(把 bfp 當 body-axis 處理)。詳見 §3。

### 2.2 Code 對應

**Frontend:**
- [`utils/assetFrame.ts:bodyFramePointToObjectLocalMm`](../frontend/src/utils/assetFrame.ts) — `R_body × p + bfp`
- [`utils/assetFrame.ts:bodyFrameDirectionToObjectLocal`](../frontend/src/utils/assetFrame.ts) — `R_body × d`
- [`utils/assetFrame.ts:bodyFrameMeshShiftMm`](../frontend/src/utils/assetFrame.ts) — `R_body⁻¹ × bfp`(只剩 PHY editor 在用)
- [`utils/beamAnchor.ts`](../frontend/src/utils/beamAnchor.ts)、[`utils/beamPlacement.ts`](../frontend/src/utils/beamPlacement.ts)、[`three/opticalBeams.ts`](../frontend/src/three/opticalBeams.ts)、[`three/rayTrace.ts`](../frontend/src/three/rayTrace.ts)、[`three/placement/snapTargets.ts`](../frontend/src/three/placement/snapTargets.ts)、[`utils/relationAnchors.ts`](../frontend/src/utils/relationAnchors.ts)、[`utils/ppgMounting.ts`](../frontend/src/utils/ppgMounting.ts)、[`components/DigitalTwinViewer.tsx`](../frontend/src/components/DigitalTwinViewer.tsx) — 全部都已透過 `assetFrame.ts` 套 body-frame 轉換

**Backend:**
- [`backend/app/optical/db_scene_loader.py:_apply_body_frame_to_anchor`](../backend/app/optical/db_scene_loader.py) — V3 solver 載 scene 時 pre-transform anchor:`p = R_body × p; p = p + bfp`
- [`backend/app/optical/pose.py`](../backend/app/optical/pose.py) — SceneObject pose × pre-transformed anchor → lab

### 2.3 ObjectPanel xyz 跟 body origin 的差別

`SceneObject.xMm/yMm/zMm/rxDeg/ryDeg/rzDeg` = **Lab Sense pose** = **object-local frame 的 origin 在 lab 的位置**。

Body origin 在 lab 上會偏 `rotateVecLab(bfp, obj.rxyz)`(under identity rotation 簡化為 `bfp`)。

> **Lab Sense ≠ body origin**(除非 bfp=0 且 R_body=I)。

### 2.4 三個 viewer 對 frame 的不同呈現

| Viewer | 把哪個 frame 對齊到 viewer 原點? | Mesh transform |
|---|---|---|
| **Lab scene viewer**(`DigitalTwinViewer`) | 不對齊(用 obj.xyz 擺) | mesh 留在 CAD frame,wrapper origin = obj.xyz |
| **PHY editor preview**(`Asset3DV3Editor`) | Body origin → scene 原點 (0,0,0) | `R_body⁻¹ × (P − bfp)`,內外兩 group |
| **Optical Link mini viewer**(`OpticalLinkViewerPanel`) | 同 lab scene viewer(走 `loadAssetObject` 或 `buildSceneObjectFromBindings`) | 同 lab scene |

---

## 3. Body frame 語意 — Phase 9.10 vs 9.11 的歷史包袱

⚠️ **目前 codebase 內這個欄位的語意有歷史矛盾,實作 vs migration docstring 不一致。**

### 3.1 兩種解讀

| 解讀 | 公式 | 「typed z=6.875 in PHY editor」的意思 |
|---|---|---|
| **Phase 9.10** (CAD axes) | `origin_cad = bfp` 直接 | 沿 CAD +Z 走 6.875 mm |
| **Phase 9.11** (body axes) | `origin_cad = R_body × bfp` | 沿 body +Z 走 6.875 mm |

### 3.2 [migration 0091](../backend/alembic/versions/0091_body_frame_position_to_body_frame.py) 怎麼寫

Docstring 明寫從 Phase 9.10 (CAD frame) migrate 到 Phase 9.11 (body frame),公式:
- Phase 9.10: `display = R_body⁻¹ × (cad_point − origin_cad)`
- Phase 9.11: `display = R_body⁻¹ × cad_point − origin_body`
- 關係: `origin_body = R_body⁻¹ × origin_cad`

數學上兩者等價,只是同一個剛性變換的兩種參數化。

### 3.3 實作怎麼跑(實際!)

```ts
// utils/assetFrame.ts:bodyFramePointToObjectLocalMm
const point = ...B...;
point.applyQuaternion(R_body);   // R_body × B
return point.add(bfp);            // R_body × B + bfp   ← 把 bfp 當 object-local axis
```

```python
# backend/app/optical/db_scene_loader.py:_apply_body_frame_to_anchor
if body_frame_rotation:
    p = _quat_rotate_vec(body_frame_rotation, p)
if isinstance(body_frame_position_mm, dict):
    p = (p[0] + bfp.x, p[1] + bfp.y, p[2] + bfp.z)   # 同上,加 bfp as CAD-axis
```

```ts
// PHY editor preview (Asset3DV3Editor.tsx:1325 附近)
shift = R_body⁻¹ × bfp           // 對 bfp 套 R⁻¹ 再 - shift
modelGroup.position = -shift
modelInnerGroup.quaternion = R_body⁻¹
// net: R_body⁻¹ × (P − bfp)     ← Phase 9.10 公式
```

**全部地方都在用 Phase 9.10 語意(bfp 當 CAD-axis vector 處理)**。Migration 0091 docstring 寫的是 9.11 但實作沒跟著改。

### 3.4 目前對策(這份 doc 的官方立場)

**承認 bfp = body origin 在 CAD frame 的位置(Phase 9.10 語意)**,所有 code 維持現狀。Migration 0091 的 docstring 跟 backfill 動作其實是 no-op(因為大家都當 CAD-axis 在處理),但已經套到 DB 的 row 應該重新 audit。

未來統一收斂方向見 §15.2。

### 3.5 已驗證範例

`DBR-852-TOSA-HighPower` laser:
- `bfp = (0, 0, 6.875)` mm
- `R_body = y90`(quat (0, sin45, 0, cos45))
- anchor `intercept_out`:`positionMmBodyLocal = (0,0,0)`、`axisXBodyLocal = (0,0,1)`

實際算出:
- anchor 在 CAD = `R_body × (0,0,0) + (0,0,6.875)` = `(0, 0, 6.875)` mm
- 在 lab(obj at `(-950.55, 0, 1920.11)`, identity rot)= `(-950.55, 0, 1926.98)` mm
- direction 在 CAD = `R_body × (0,0,1)` = `(1, 0, 0)`(beam 沿 lab +X)

Mesh 部分:
- Mesh CAD 點 `(0,0,6.875)` 經 wrapper(無 body-frame mesh shift,2026-05-27 fix)後落在 lab `(-950.55, 0, 1926.98)`
- ✓ Beam start 跟 mesh emission point 完全重合

---

## 4. Anchor schema 與命名

### 4.1 Schema

[`types/digitalTwin.ts:21`](../frontend/src/types/digitalTwin.ts):

```ts
type Anchor = {
  id: string,                                        // e.g. "intercept_out"
  name?: string,                                     // display name; AD9959 4×rf_out 用 "CH0"..."CH3" 區分
  type?: "center" | "face" | "edge" | "custom",
  positionMmBodyLocal: { x, y, z },                  // body frame mm
  axisXBodyLocal?: { x, y, z },                      // 主軸: propagation / face normal
  axisYBodyLocal?: { x, y, z },                      // 橫向參考: 快軸 / s-pol basis
  axisZBodyLocal?: { x, y, z },                      // = X × Y
  apertureMm?: number,                               // circle radius (mm)
  apertureWidthMm?, apertureHeightMm?, apertureShape?: "circle" | "ellipse" | "rectangle",
  connectorType?: "sma_male" | "sma_female" | "bnc_male" | "bnc_female",
  fastAxisDegBodyLocal?: number,                     // waveplate fast-axis(asset-level fixed)
  derivedFromFiberEndpoint?: "A" | "B",              // fiber 動態端口
  derivedFromRfCableEndpoint?: "A" | "B",            // rf_cable 動態端口
  directionBodyLocal?: { x, y, z },                  // legacy 欄位(被 axisX 取代,fallback)
};
```

### 4.2 Anchor id 慣例

| anchor.id | 用途 | 哪些 kind 用 |
|---|---|---|
| `intercept_in` | 光線進入面(入射) | lens / waveplate / polarizer / AOM / fiber A 端 / faraday / EOM |
| `intercept_out` | 光線離開面(出射) | 同上 + laser_source / TA |
| `intercept_face` | 單面元件的反射 / 偏振面 | mirror / dichroic / glan polarizer |
| `interaction_center` | AOM 衍射內部點 | aom(backend 從 in/out 中點 [自動 derive](../backend/app/optical/db_scene_loader.py)) |
| `rf_in` / `rf_out` | RF 入 / 出 port | rf_amplifier / rf_switch / dds / aom(只有 rf_in) / rf_cable / rf_source |
| `ttl_in` / `trigger_in` | TTL 閘 / 觸發輸入 | rf_switch / rf_source / aom |
| `mount_*` / `face_*` | 機械結構 anchor | passive mechanical |
| **legacy:** `optical_anchor` / `out` / `+x` | 舊命名,fallback 用 | 多種 |

### 4.3 三層 fallback(legacy 兼容)

[`utils/beamAnchor.ts:getBeamAnchor`](../frontend/src/utils/beamAnchor.ts):

```
1. Asset3D.anchors[id="optical_anchor"]   ← per-asset explicit (oldest)
2. Per-elementKind default                 ← mirror: 反射面在 +Z·thickness/2
3. Body center (offset 0,0,0)              ← 最後 fallback
```

axisX / axisZ 也有 fallback:`axisXBodyLocal` 是新 schema(alembic 0087),`directionBodyLocal` 是舊欄位 — [`rayTrace.ts`](../frontend/src/three/rayTrace.ts) 寫成 `axisX ?? directionBodyLocal`。

### 4.4 三種動態類型

| 類型 | 從哪算 | 範例 |
|---|---|---|
| **static** | 直接讀 `positionMmBodyLocal` | 多數元件 |
| **fiber-derived**(`derivedFromFiberEndpoint`) | 從 `SceneObject.properties.fiberNodes[0]` / `[N-1]` + ferrule tip offset 算 | fiber 的 `intercept_in` / `intercept_out` |
| **rfCable-derived**(`derivedFromRfCableEndpoint`) | 從 `SceneObject.properties.rfCableNodes[0]` / `[N-1]` + SMA tip offset 算 | rf_cable 的 `rf_in` / `rf_out` |

對應 helper:
- [`utils/fiberAnchorResolver.ts:resolveAnchorPosition`](../frontend/src/utils/fiberAnchorResolver.ts)
- [`utils/rfCableAnchorResolver.ts:resolveRfCableAnchorPosition`](../frontend/src/utils/rfCableAnchorResolver.ts)

### 4.5 Body-frame 轉換的所有 call site

任何讀取 `anchor.positionMmBodyLocal` / `axisXBodyLocal` / `directionBodyLocal` 之後要套到 SceneObject pose 的地方,**必須**先過 `bodyFramePointToObjectLocalMm` / `bodyFrameDirectionToObjectLocal`。已 audit + 修好的 call site:

| 檔案 | 用途 |
|---|---|
| [`utils/beamAnchor.ts:getBeamAnchor`](../frontend/src/utils/beamAnchor.ts) | beam 起點 |
| [`utils/beamPlacement.ts`](../frontend/src/utils/beamPlacement.ts) | beam 放置 / snap |
| [`three/rayTrace.ts`](../frontend/src/three/rayTrace.ts) | in-browser ray tracer(legacy) |
| [`three/opticalBeams.ts:emissionFromObject`](../frontend/src/three/opticalBeams.ts) | laser/TA 視覺發射 |
| [`three/placement/snapTargets.ts`](../frontend/src/three/placement/snapTargets.ts) | gizmo snap 候選點 |
| [`utils/relationAnchors.ts:worldAnchor`](../frontend/src/utils/relationAnchors.ts) | AssemblyRelation 連線 |
| [`components/DigitalTwinViewer.tsx`](../frontend/src/components/DigitalTwinViewer.tsx) | AOM tilt 標記 / RF cable snap |
| [`utils/ppgMounting.ts`](../frontend/src/utils/ppgMounting.ts) | PPG 自動 mount |
| [`backend/app/optical/db_scene_loader.py`](../backend/app/optical/db_scene_loader.py) | V3 solver 載 scene |

⚠️ **未 audit、可能還有漏的(疑似)**:
- [`utils/v2Bindings.ts:getRfDirectionBodyLocal`](../frontend/src/utils/v2Bindings.ts) — 命名說 body-local,但呼叫端對 frame 假設不明
- [`utils/fiberAnchorResolver.ts`](../frontend/src/utils/fiberAnchorResolver.ts) — 回傳 body coord,caller 是否會再套 body-frame 不一致
- [`utils/rfCableAnchorResolver.ts`](../frontend/src/utils/rfCableAnchorResolver.ts) — 同上
- 各 `optical/kinds/*/physics.ts` — ray-tracer v3 inside,需獨立 audit

---

## 5. 「Node」三個意思

| 詞 | 出現位置 | 意思 |
|---|---|---|
| **RfChainNode** | [`backend/app/models/modules/rf.py`](../backend/app/models/modules/rf.py) | per-terminal RF chain 上的元件位置編號(position_in_chain + nodeKind + label + gainDb)。被 [`solvers/rf_propagation.py`](../backend/app/solvers/rf_propagation.py) 拿來算 Vpp/dBm/freq propagation。Phase RF.x 之後 `rf_links` 取代它做正規 graph,RfChainNode 變成 derived readout cache。 |
| **fiberNodes / rfCableNodes** | `SceneObject.properties` | Bezier spline 控制點(`posMm` + `handleInMm` + `handleOutMm`)。端點兩個 node 是 ferrule / SMA 連接器起點,中間的 node 是 user 拖出彎曲。 |
| **Collection node** | [`backend/app/models/scene.py`](../backend/app/models/scene.py) | Blender 風 nested 群組(`Collection` + `CollectionMember`),可勾 `rigid_transform: true` 讓 group 內所有 member 一起移動。屬於場景組織,跟物理無關。 |

---

## 6. OpticalLink 架構

### 6.1 Schema

[`backend/app/models/interaction.py:128`](../backend/app/models/interaction.py):

```python
OpticalLink {
  fromObjectId,   fromPort,      # 起點 SceneObject + anchor.id
  toObjectId,     toPort,        # 終點 SceneObject + anchor.id
  freeSpaceMm,                   # 兩 port 之間自由空間長度
  properties,                    # JSONB free-form
}
```

`fromPort` / `toPort` 直接就是 anchor.id 字串(`intercept_out` / `intercept_in`)。

### 6.2 跟 ray tracer 的關係

**OpticalLink ≠ ray tracer 路徑**:
- OpticalLink = user(或 solver)宣告「這個元件的這個 port → 那個元件的那個 port 之間有光連線」的 graph 結構
- Ray tracer = 物理引擎,從 emitter anchor 開始,沿 `axisX` 射出,碰到下個元件 face 用該元件 transition 規則 dispatch(refract / reflect / split)
- Tracer 輸出 `BeamSegment[]` / `LabSegment[]`,跟 OpticalLink **獨立**:tracer 算物理(實際走在哪),OpticalLink 紀錄拓樸(該怎麼連)

但 `OpticalLinkViewerPanel` 是用 emitter 為起點走 OpticalLink graph 找出整條 chain(`expandEmitterChain` 之類的 walk),再顯示 tracer 跑出的 segments。

### 6.3 Routing 規則

[`backend/app/routers/optical_links.py`](../backend/app/routers/optical_links.py) 拒絕:
- self-loop(`fromObjectId == toObjectId` 且 `fromPort == toPort`)
- 同一 (from, to, fromPort, toPort) 重複
- port 不存在於 asset 的 anchors

---

## 7. RfLink 架構

### 7.1 Schema

[`backend/app/models/interaction.py:165`](../backend/app/models/interaction.py)(alembic 0044):

```python
RfLink {
  fromObjectId, fromPort,           # 起點 + anchor.id (rf_out / ttl_out)
  toObjectId,   toPort,             # 終點 + anchor.id (rf_in / ttl_in)
  electricalLengthMm,               # 信號路徑長度(直接 mating = 0; patch cable = 長度)
  properties,                       # impedance / loss / delay / cableObjectId
}
```

### 7.2 跟 Connection / RfChainNode 的關係

- **Connection**(舊模型,前 RF.x)— 純拓樸 (`from`, `to`, `connection_type="rf"|"ttl"|"usb"`),被 RfLink 取代
- **RfChainNode**(`rf_chain_nodes`)— per-terminal 線性 chain readout,RfLink graph 之上的扁平化視圖
- **RfLink**(0044+)— 權威 graph 結構,允許 switch / splitter / combiner / mixer 等分支

### 7.3 Port domain check

[`utils/rfLinkPorts.ts:resolveRfLinkPortDomain`](../frontend/src/utils/rfLinkPorts.ts) 判斷 port 是 `"rf"` / `"ttl"`,RfLink 拖線時兩端 domain 一致才能建立(rf-rf 或 ttl-ttl)。這條規則由 plugin 的 capability profile 跟 anchor.id 共同決定。

---

## 8. Fiber 架構

### 8.1 單 SceneObject 模型(post alembic 0056,回退 0052)

```
fiber SceneObject (一個 — 不是 3 個)
  ├── lab pose (xMm, yMm, zMm, rxDeg, ryDeg, rzDeg)
  └── properties.kindParams (FiberParams)
        ├── endA: { posMm, rotDeg, tensionHandleMm, polish, connectorType, ... }
        ├── endB: { 同上 }
        ├── fiberNodes: [Node, Node, ...]      ← Bezier spline 控制點(含端點)
        ├── fiberType, wavelengthRangeNm, attenuationCurve, bendLoss, ...
        └── (per-fiber 物理係數)
```

**渲染**:
```
fiber wrapper (at obj.xyz)
  ├── tube (Bezier 過 fiberNodes 全部點,含端點)
  ├── ferrule A 連接器 mesh  ← posed at kindParams.endA.{posMm, rotDeg}
  └── ferrule B 連接器 mesh  ← posed at kindParams.endB.{posMm, rotDeg}
```

Ferrule tip = optical port = `endA.posMm` 在 body-local 朝 `-unit(tensionHandleMm)` 方向走 `FIBER_FERRULE_TIP_MM` (= 36.28 mm) 的位置。

### 8.2 Endpoint anchor 解析

`intercept_in` / `intercept_out` 兩個 anchor 設 `derivedFromFiberEndpoint = "A" / "B"`。[`utils/fiberAnchorResolver.ts:resolveAnchorPosition`](../frontend/src/utils/fiberAnchorResolver.ts) 從 `kindParams.endA/endB` 動態算出 anchor 位置(body-local mm),fallback 到靜態 `positionMmBodyLocal`。

### 8.3 Align flow

Object Panel 有獨立的「Align End A」/「Align End B」鈕(`physics/_shared.tsx:FiberEndAlignControls`)。按下時:
1. 找最近 beam segment
2. 算出該 end 應該擺在哪個 lab pose 讓 ferrule tip 落在 beam 上
3. 反算 `kindParams.endA.posMm` / `endB.posMm`,只動該端
4. 另一端 + 中間 fiberNodes 都保留

---

## 9. RfCable 架構

平行 Fiber 但更簡單:

```
rf_cable SceneObject
  ├── lab pose
  └── properties
        ├── rfCableNodes: [Node, Node, ...]   ← Bezier spline
        ├── rfCableEndpoints: { A?, B? }      ← 連到誰的哪個 anchor(若有)
        └── kindParams (RfCableParams): { lengthMm, impedanceOhm, connectorType, ... }
```

### 9.1 RfCableEndpointLink

```ts
{
  targetObjectId: string,
  targetAnchorId: "rf_in" | "rf_out",
  targetAnchorName: "CH0" | ... (同 id 多 port 時用 name 區分,例如 AD9959 四個 rf_out)
}
```

當 user 拖 cable 端 align 到目標 port,記下這個 link。**渲染時** [`DigitalTwinViewer.tsx`](../frontend/src/components/DigitalTwinViewer.tsx) 動態算 cable 端應該在哪(target lab pose · target anchor + 反方向 outward · SMA tip),所以目標元件移動時 cable 自動跟著走,不需要重 align。

`resolveLinkedRfCableEndpoint`([`utils/rfCableAnchorResolver.ts:186`](../frontend/src/utils/rfCableAnchorResolver.ts)) 做這個反算。

### 9.2 RfCable ↔ RfLink 對應

當有 cable connecting A↔B,會有(兩種寫法擇一,depends on router):
- **寫法 1**: 兩條 RfLink + cable 當中介
  - `RfLink(A.rf_out → cable.rf_in, electricalLengthMm = 0)` (mating)
  - `RfLink(cable.rf_out → B.rf_in, electricalLengthMm = 0)` (mating)
  - `properties.cableObjectId` 指到 cable SceneObject
- **寫法 2**: 一條 RfLink + cable 純當視覺
  - `RfLink(A.rf_out → B.rf_in, electricalLengthMm = cable.lengthMm)`
  - cable SceneObject 只負責畫 spline

---

## 10. PPG mount 特例

PPG(Programmable Pulse Generator)是 RF cable 的特例,**沒有可見 cable**:

```
PPG SceneObject + rf_cable SceneObject(hidden)
                       ↓
               rfCableEndpoints.A = { target = PPG, anchor = "rf_out" }
               rfCableEndpoints.B = { target = AOM/switch, anchor = "trigger_in" }
                       ↓
[utils/ppgMounting.ts:computePpgMountedThreePose]
   PPG.rf_out 必須對齊 target.anchor,反方向 outward
   → PPG 整顆 body 的 lab pose 由此算出(覆蓋 SceneObject.xMm/yMm/zMm)
```

PPG 跟 TimingProgram 1:1 配對。TimingProgram 定 HIGH/LOW interval,compile 成 SpinCore opcode(CONTINUE / WAIT / STOP)。

---

## 11. Mesh 渲染 frame(Lab scene vs PHY editor)

### 11.1 Lab scene viewer(`DigitalTwinViewer` + `loadAssetObject`)

**2026-05-27 修正後**:body-frame asset 的 mesh **不再額外變換**(以前會做 buggy `R_body⁻¹` 旋轉 + 算錯的 shift)。

```ts
// loadAsset/index.ts
if (hasBodyFrame) {
  // 不動 mesh — CAD frame 直接用,wrapper origin = obj.xyz
} else {
  // legacy: apertureForward 或 bbox-center 自動置中
}
```

對 body-frame asset:
- Mesh CAD 點 P 在 lab = `obj.xyz + rotateVecLab(P, obj.rxyz)` (P in mm)
- Body origin(CAD = bfp)在 lab = `obj.xyz + rotateVecLab(bfp, obj.rxyz)`
- 跟 beam 公式 `obj.xyz + rotateVecLab(R_body × B + bfp, obj.rxyz)`(B=0 → 同上)完全一致 ✓

### 11.2 PHY editor preview(`Asset3DV3Editor`)

```ts
// 內外兩 group
modelInnerGroup.quaternion = R_body⁻¹
modelGroup.position = -(R_body⁻¹ × bfp)
// 等價 net transform: world = R_body⁻¹ × (cad − bfp)
```

對 body-frame asset:
- Body origin → PHY scene 原點 (0,0,0) ✓
- 顯示 + 修改 anchor 都在 body-frame 內(乾淨)

⚠️ 但 PHY editor 的 UX 上,user 輸入 `z = 6.875` 在 PHY scene 內 mesh 不一定沿 scene Z 走 — 走的方向是 `R_body⁻¹ · ẑ`,跟 doc 預期的「scene Z」可能不一致(R_body!=identity 時)。詳見 §15.7。

### 11.3 Optical Link mini viewer(`OpticalLinkViewerPanel`)

走 `loadAssetObject`(走 legacy 單 asset 路徑)或 `buildSceneObjectFromBindings`(走 composition tree)。Mesh 變換邏輯跟 §11.1 一致。

---

## 12. 整體關係圖

```
                       Asset3D
                  (CAD + anchors + body frame + kind)
                          │
                          │  asset_3d_id (legacy) / ComponentBinding(0062 樹)
                          ▼
                       Component
                       (型號)
                          │
                          │  componentId
                          ▼
                      SceneObject ─────────────────── PhysicsElement
                       (lab pose,                      (per-instance physics,
                        per-instance overrides,         intrinsic / state params)
                        properties)
                          │           │           │
                          │           │           │
              ┌───────────┴────┐      │           └────────┐
              │                │      │                    │
         OpticalLink       RfLink   Collection         RfChainNode
         (光學 graph     (RF graph   (Outliner 樹)     (per-terminal
          edge: A.out →    edge:                       chain readout)
          B.in,            A.rf_out
          freeSpaceMm)     → B.rf_in,
                           electrical
                           LengthMm)
              │                │
              │                │
              ▼                ▼
         Ray Tracer       RF Propagator
        (V3 solver,        (graph BFS,
         面+5×5 ABCD,        Vpp/dBm
         輸出 LabSegment)    /freq/saturation)
              │
              ▼
         BeamPath / BeamSegment
        (polyline cache,
         per-link rays)


      Fiber / RfCable  ←─ 特殊 SceneObject  ───────→  RfCableEndpointLink
        ├─ kindParams.endA/endB                       (Connection 的繼承者,
        ├─ fiberNodes / rfCableNodes                   per-instance 紀錄綁定
        └─ ferrule tip 算 anchor                       到的 target port)


      PPG SceneObject ──── computePpgMountedThreePose ──→  覆蓋 lab pose
        └─ TimingProgram (1:1) ── compile ──→ SpinCore opcode
```

---

## 13. 命名 / 規約對照表

| 詞 | 出現位置 | 意思 |
|---|---|---|
| **Lab frame** | DB / solver | scene 全域,mm,Z-up |
| **Lab Sense pose** | doc / panel label | `SceneObject.xMm/yMm/zMm` 等,= object-local origin 在 lab 的位置 |
| **Object-local frame** | code | ≡ CAD frame,= STL 檔內 vertex 用的座標 |
| **CAD frame** | doc | 同 object-local |
| **Body frame** | doc + anchor | 物理乾淨座標,+Z = 光軸,+X = 偏振 / 快軸 / s 基底 |
| **bodyFramePositionMm (bfp)** | `Asset3D.properties` | body origin 在 object-local(CAD)的位置,mm 三軸 — 目前實作把它當 CAD-axis vector 處理(§3) |
| **bodyFrameRotation (R_body)** | `Asset3D` | body axes 相對 CAD axes 的旋轉 quaternion |
| **anchor.positionMmBodyLocal** | `Asset3D.anchors` | anchor 在 body frame 的位置(注意:body frame!不是 object-local!) |
| **anchor.axisXBodyLocal** | `Asset3D.anchors`(post 0087) | anchor 主軸方向,body frame 內單位向量 |
| **derivedFromFiberEndpoint / RfCableEndpoint** | anchor | 標記此 anchor 位置動態從 spline 算 |
| **port / fromPort / toPort** | OpticalLink / RfLink | = anchor.id 字串 |
| **node** | fiber / rfCable | Bezier spline 控制點(見 §5) |
| **chain node** | RfChainNode | 一條 RF chain 上的元件位置編號(見 §5) |
| **collection** | Outliner | Blender 風 nested 群組(見 §5) |
| **binding** | ComponentBinding | Component 內 composition tree 一格 |
| **objectBinding** | ObjectBinding | 對 binding 的 per-instance pose delta |

---

# Part B — 變更紀錄

## 14. 2026-05-27 body-frame alignment 修正

### 14.1 問題

User 觀察:「lab sense 看到 beam 對不上模型 component」 — beam 起點跟 mesh 上的對應 anchor 點不重合,差 bfp 量級。

### 14.2 根本原因

`loadAsset/index.ts` 的 body-frame mesh 變換寫錯:
- Intent: 把 body origin 移到 wrapper origin(像 PHY editor 那樣)
- 實作: `object.quaternion.premultiply(R_body⁻¹)` + `object.position.sub(R_body⁻¹ × bfp / 100)`
- 結果: body origin 落在 wrapper-local `(I − R_body⁻¹) × bfp`(非 0,有 bug)

同時 beam 公式是 `obj.xyz + (R_body × B + bfp)`(Phase 9.10 form),對應 body origin 在 lab = `obj.xyz + bfp`。

Beam 跟 mesh 算到不同位置,所以對不上。

### 14.3 修正

| 檔案 | 改動 |
|---|---|
| [`frontend/src/three/loadAsset/index.ts`](../frontend/src/three/loadAsset/index.ts) | body-frame asset 的 mesh **不再變換**,留在 CAD frame。beam 公式不動,自然對齊。 |
| [`frontend/src/utils/relationAnchors.ts`](../frontend/src/utils/relationAnchors.ts) | `worldAnchor` 套 `bodyFramePointToObjectLocalMm` |
| [`frontend/src/components/DigitalTwinViewer.tsx`](../frontend/src/components/DigitalTwinViewer.tsx) | AOM tilt 標記 + RF cable snap target 套 body-frame 轉換 |
| [`frontend/src/utils/ppgMounting.ts`](../frontend/src/utils/ppgMounting.ts) | `anchorPosThree` / `anchorDirThree` 接受 asset 並套 body-frame |

Backend 端 `db_scene_loader.py` 的 `_apply_body_frame_to_anchor` 之前 uvicorn `--reload` zombie 沒抓到,重啟後 V3 solver 正確套 body frame。

### 14.4 驗證

`DBR-852-TOSA-HighPower` laser:
- Mesh wrapper lab = `(-950.55, 0, 1920.11)` = obj.xyz ✓
- Mesh STL 的 CAD point (0,0,6.875)(= body origin)經 wrapper 後落在 lab `(-950.55, 0, 1926.98)`
- Beam start lab = `(-950.55, 0, 1926.98)` ✓ — 跟 mesh 上 body origin 點完全重合

## 14.5 2026-05-27 §15.1 / §15.2 / §15.3 後續優化落地

**§15.1 centralize anchor access**
- 新增 [`utils/anchorAccess.ts`](../frontend/src/utils/anchorAccess.ts) — `anchorObjectLocalPos` / `anchorObjectLocalAxisX/Y/Z` / `anchorObjectLocalLegacyDir` / `anchorObjectLocalPrimaryDir` / `resolveAnchor`,**唯一 sanctioned 的 anchor 讀取入口**
- 新增 [`utils/__tests__/anchorAccess.test.ts`](../frontend/src/utils/__tests__/anchorAccess.test.ts) — 14 個 helper 算術測試
- 遷移所有 caller(`beamAnchor` / `beamPlacement` / `opticalBeams` / `rayTrace` / `snapTargets` / `relationAnchors` / `DigitalTwinViewer` / `ppgMounting` / `AomAdjustControls` / `TaperedAmplifierAdjustControls`)從 raw access 改用 anchorAccess
- 新增 [`frontend/scripts/check-anchor-access.mjs`](../frontend/scripts/check-anchor-access.mjs) — grep guard 強制 enforcement,接到 `npm run check:anchors` + `npm run build`
- Inline 例外用 `/* raw-anchor-ok: <reason> */` marker(presence check / cache key digest / 物理在 body frame 計算)

**§15.2 frame semantic disambiguation**
- 更新 [`backend/alembic/versions/0091_body_frame_position_to_body_frame.py`](../backend/alembic/versions/0091_body_frame_position_to_body_frame.py) docstring,加 history note 承認實作實際是 Phase 9.10 語意(bfp 當 CAD-axis 加),migration 0091 對非 identity R_body 的 row 是「靜悄悄的錯誤旋轉」
- 加 [`backend/app/main.py:_audit_body_frame_consistency`](../backend/app/main.py) startup hook — 對 `bfp != 0` 且 `R_body != I` 的 asset 印 warning,要求人工目視確認
- 第一次 startup audit 結果:3 suspect 個 asset(`toptica_boosta_pro`, `dbr_852_tosa_high_power_laser_source`, `thorlabs_bb1_e03`)

**§15.3 alignment integration test**
- 新增 [`frontend/src/three/__tests__/beam_mesh_alignment.test.ts`](../frontend/src/three/__tests__/beam_mesh_alignment.test.ts) — 6 個 case 覆蓋 4 種 body-frame regime(identity / bfp only / R_body only / 兩者皆有 + non-identity scene pose)
- Invariant:`emissionFromObject(placement, asset).origin == placement.xyz + lab_rotation(anchorObjectLocalPos(anchor, asset))`
- 任何人改 `emissionFromObject` 或 `anchorObjectLocalPos` 公式而沒同步另一邊都會 fail

## 14.6 2026-05-27 §17.1 / §17.2 / §17.3 / §16.5 後續優化落地

**§17.1 uvicorn zombie pre-flight kill**
- 強化 [`scripts/restart-backend.ps1`](../scripts/restart-backend.ps1):
  - Pass 1: kill port owner(原本就有)
  - Pass 2(新):掃 `python.exe` 命令列含 `uvicorn` / `app.main:app`,殺孤兒 worker(WatchFiles 死掉時 child 還佔著 :8010 的場景)
  - Pass 3(新):驗證 port 真的空了,沒空就 throw 而不是 silently 開第二個 uvicorn
- 對應 memory [`uvicorn_reload_windows.md`](../../memory/uvicorn_reload_windows.md) note 的場景,本 session 已驗證可正確處理 zombie

**§17.2 CRLF / LF noise**
- 新增 [`.gitattributes`](../.gitattributes) — `* text=auto eol=lf` 為 baseline,Windows-only(`.ps1`/`.cmd`/`.bat`)維持 CRLF,二進位檔(STL/GLB/STEP/PNG…)標 `binary`
- `git add --renormalize .` 留給 user 自行決定時機,不污染目前 working tree

**§17.3 debug globals 集中**
- 新增 [`frontend/src/three/debugBridge.ts`](../frontend/src/three/debugBridge.ts) — `QmemDebugGlobals` 統一型別 + `publishQmemDebug()` / `readQmemDebug()` 雙向 API
- Producer ([`DigitalTwinViewer.tsx:4050`](../frontend/src/components/DigitalTwinViewer.tsx)) 切過去走 `publishQmemDebug`,legacy `window.__rayTraceDebug` / `__beamGroup` / `__v3LabSegments` 名稱保留(production feature 還在用),consumers 可漸進遷移到 `readQmemDebug`
- 沒做 DEV-only gate — 這些 global 是 production 真實使用的 cross-component 通道(snap-to-beam、OpticalLinkViewerPanel、AomAdjust 都讀)

**§16.5 legacy face-based solver 標 deprecated**
- [`backend/app/routers/v3_solver.py:run_v3_solver`](../backend/app/routers/v3_solver.py) 加 `deprecated=True` + docstring 說明:`/api/v3/solver/run` 只給 tests / parity 用,production 走 `/run-from-db`(anchor-based)
- Swagger UI (`/docs`) 現在會把 `/run` 顯示成 strikethrough — 提醒新整合者用 `/run-from-db`
- 不移除 endpoint(`test_solver_v3*.py` 仍依賴,移除會喪失 parity 測試覆蓋)

## 14.7 2026-05-27 §17.4 / §16.1 / §16.2 + 端到端測試落地

**§17.4 PHY editor z mm UX**
- [`Asset3DV3Editor.tsx`](../frontend/src/components/Asset3DV3Editor.tsx) `Body frame origin` 區塊上方加 hint text:「Inputs are CAD-axis offsets — visual direction in PHY scene depends on the body-rotation set below」+ 每個輸入框 hover tooltip
- 不動公式(維持 Phase 9.10 一致),只補 UX 說明

**§16.1 legacy frontend rayTrace.ts 凍結**
- [`three/rayTrace.ts`](../frontend/src/three/rayTrace.ts) 頂端加 deprecation header,明列「still alive」(`TraceSegment` type / `gaussianWaistAtZ` / `_testReflect`)vs「frozen」(`traceBeamsFromLasers` 全 forward-tracing 引擎)
- 新物理放 backend(`anchor_ops/` + `solver_v3`),不再擴充這個 file

**§16.2 Anchor ID alias 收斂**
- 跑 DB audit 確認所有 asset 都已用 canonical id(`intercept_in/out/face` / `rf_in/out` / `ttl_in` 等),沒 legacy alias 殘留 → 沒寫 migration(數據已乾淨)
- 加 [`main.py:_audit_legacy_anchor_ids`](../backend/app/main.py) startup hook,future regression 會被抓
- 程式碼裡的 fallback 鏈(`getBeamAnchor`、`findEmitterAnchor`、`computeBeamStart`)保留 — 等 audit 在一個 release cycle 都 0 hit 後可砍

**端到端測試(programmatic scene + V3 trace)**
- Scene 設置:6 個 optical (laser + IO-3-850-HP + BoosTA pro + WPHSM05 + PBS252 + MT80) + 5 個 RF (DDS + Switch + PPG + Amp + AOM) + 4 條 rf_cable with `rfCableEndpoints` linked
- 結果:V3 solver 跑 OK,beam 從 laser `intercept_out` 出發落在 `(-950.55, 0, 1926.98)` ✓,第一段 hit waveplate `intercept_in` face ✓
- 已知非 frame-system 議題(留給 catalog / UI align):
  - **TA / AOM / PBS / iso** 的 body-frame 軸跟 lab beam 方向 mis-align,Object Panel 的 Align to beam 鈕(或手動 `ryDeg=±90`)就能修
  - **Isolator (IO-3-850-HP)** asset 的 `anchors` 是空的 — Phase 9.1 backfill 沒涵蓋這顆,要在 PHY Editor 手動補 `intercept_in/out` + 內部 PBS face anchors

---

# Part C — 優化路線圖

## 15. 高優先(再不修下次還會爆)

> 2026-05-27:§15.1 / §15.2 / §15.3 已實作完成。下方原始說明保留作為背景。後續維護見 §18 + §19。

### 15.1 把 body-frame 轉換集中,禁止直接讀 raw anchor

**痛點**: 這輪在 6+ 個檔案手動補 `bodyFramePointToObjectLocalMm` 才把 mesh / beam / relation / cable / PPG / AOM 都拉到同一個 frame。下次任何新 helper 寫 `anchor.positionMmBodyLocal` 都會再爆同樣 bug。

**做法**:
```ts
// utils/anchorAccess.ts (新)
export function anchorObjectLocalPos(anchor: Anchor, asset: Asset3D): Vec3 { ... }
export function anchorObjectLocalDir(anchor: Anchor, asset: Asset3D): Vec3 { ... }
export function anchorObjectLocalAxisX(anchor: Anchor, asset: Asset3D): Vec3 { ... }
// 然後 Anchor 的 positionMmBodyLocal/axisXBodyLocal 改型別前綴 _internal_,
// 或加 ESLint custom rule / pre-commit hook 禁止 utils/anchorAccess.ts 以外的程式碼直接 access
```

**工程量**: ~半天。grep 出所有 `\.positionMmBodyLocal` 用法,逐一替換,加 rule。

### 15.2 解掉 Phase 9.10 vs 9.11 的歷史含糊

**痛點**: [migration 0091](../backend/alembic/versions/0091_body_frame_position_to_body_frame.py) docstring 寫 bfp 改成 body axes,但全 codebase 實作把 bfp 當 CAD axes 加(§3)。Docstring 跟實作不一致,新人 onboard 一定誤判。

**做法**:
- 寫一條 "把 docstring 改回 Phase 9.10 語意 + 加 warning「migration 0091 是 no-op upgrade」" 的 migration 更新
- 寫一條 startup-time data check,對每個 `bfp != 0` 且 `R_body != identity` 的 asset,印 warning「請人工目視確認 PHY editor 跟 lab scene 內這個 asset 的 body origin 位置一致」
- 修 [`opticalBeams.test.ts`](../frontend/src/three/opticalBeams.test.ts) / [`assetFrame.test.ts`](../frontend/src/utils/__tests__/assetFrame.test.ts) 的測試 assertion 跟 doc 一致

**工程量**: 半天(主要是 audit + 寫 warning,不動 logic)。

### 15.3 加 integration test:beam start lab == mesh body origin lab

**痛點**: 已存在的單元測試只測 `bodyFramePointToObjectLocalMm` 的純算術,沒測「實際 load asset + 算 beam 是否落在 mesh 上的同一點」。這次的 bug 就是這個 gap 漏掉的。

**做法**:
```ts
// frontend/src/three/__tests__/beam_mesh_alignment.test.ts
test("laser beam start sits at mesh STL emission point", async () => {
  const asset = loadFixtureAsset("dbr_852_with_bfp.json");
  const wrapper = await loadAssetObject(comp, asset);
  const beamStart = emissionFromObject(placement, asset).origin;
  const stlEmissionVertex = findVertexAt(wrapper, asset.intendedEmissionCadPoint);
  expect(beamStart.distanceTo(stlEmissionVertex)).toBeLessThan(1e-3);
});
```

每個有 bfp 的 asset family(laser、lens、isolator、AOM、fiber)各一個 case。

**工程量**: 1-2 天(寫 fixture + 跨 backend / frontend integration runner)。

---

## 16. 中優先(維護成本)

### 16.1 砍掉 legacy ray tracer

**痛點**: [`frontend/src/three/rayTrace.ts`](../frontend/src/three/rayTrace.ts) (in-browser tracer)跟 backend `solve_anchor_scene`(V3 solver,production)做差不多的事。Phase 9.8 之後 V3 是 source of truth,但 `rayTrace.ts` 還在被 maintained(剛剛還在改 Glan polarizer 邏輯)。同一個物理算兩遍,規則漂走的成本很高。

**做法**: 留 `rayTrace.ts` 做 `window.__rayTraceDebug` 的 fallback,但把它從正式 render path 完全拔掉(已部分拔了),把那些 anchor_ops 物理改寫工程**只在 backend 做**。Frontend tracer 凍結 / 標 deprecated。

### 16.2 Anchor ID 別名太多

**痛點**: 主光學 port 在不同年代叫過:`optical_anchor` / `intercept_in` / `intercept_out` / `intercept_face` / `out` / `+x`。`getBeamAnchor` 跟 `findEmitterAnchor` 都有 3-4 層 fallback,每個新 plugin 都要記得處理 fallback。

**做法**: 寫一個 migration,把所有 asset 的 anchors 統一到 `intercept_in/out/face`(`+x` / `out` / `optical_anchor` 都 rename),然後刪掉所有 fallback 路徑。

### 16.3 三個東西都叫「node」

見 §5。Code review 跟新人 onboard 都會踩。

**做法**: rename 一輪:
- `RfChainNode` → `RfChainStep`
- `fiberNodes` / `rfCableNodes` → `fiberSpline` / `rfCableSpline`(或 `fiberSplineControls`)
- `Collection` 保留(它本來就是 outliner group)

### 16.4 `Asset3DV3Editor.tsx`(3460 行)/ `ComponentPanel.tsx`(2169 行)拆分

**痛點**: 大檔案。`Asset3DV3Editor` 同時管 STL 載入 + face picker + anchor editor + body frame editor + lock overlay + camera 狀態,難 review 難測試。

**做法**: 不急著拆,但**下次大改它的時候**順手把 face-picker 子系統、camera 子系統、anchor-list 子系統各拆出去。

### 16.5 重複的 OpticalLink solver 路徑

[`solver_v3.py`](../backend/app/optical/solver_v3.py) 同時保留 `solve_v3_scene`(legacy face-based)跟 `solve_anchor_scene`(production anchor-based)。

**做法**: legacy 一條留給 tests / parity 用,標 deprecated;router 不要再 expose,移除 `solve_v3_scene` 的 production import。

---

## 17. 低優先(QoL)

### 17.1 uvicorn `--reload` Windows zombie 預防

這次直接咬到我。在 `start-project` skill 加 pre-flight:
```powershell
$pid = (Get-NetTCPConnection -LocalPort 8010 -State Listen).OwningProcess
if ($pid) { Stop-Process -Id $pid -Force; Start-Sleep 1 }
```

也可以順手加到 memory 的 [`uvicorn_reload_windows.md`](../../memory/uvicorn_reload_windows.md) 那個 note。

### 17.2 CRLF / LF 雜訊

`git diff` 每次跑出十幾條 `warning: in the working copy of X, LF will be replaced by CRLF`。設 `.gitattributes`:
```
* text=auto eol=lf
*.{ps1,cmd,bat} text eol=crlf
```
然後 `git add --renormalize .` 一次清掉。

### 17.3 `window.__*` global 污染

`__rayTraceDebug` / `__beamGroup` / `__v3LabSegments` / `__sceneStore` 都掛 window。Dev 用很方便,但 prod build 一樣會掛,污染。

**做法**: 包成 `if (import.meta.env.DEV) window.__... = ...`,或集中到一個 `window.__qmemDebug` 物件。

### 17.4 PHY editor 的 z mm 輸入軸向跟 doc 預期不一致

`Asset3DV3Editor` 內輸入 `z mm = 6.875` 時,STL 在 PHY scene 內**沿 `R_body⁻¹ · ẑ` 移動**,不是 doc 預期的「沿 scene Z」(R_body!=identity 時)。

**做法**: 如果決定收斂到 Phase 9.11 語意,可一併修。如果停在 Phase 9.10,doc 補一句「z mm 是 CAD-axis 的 z,不是視覺 z」即可。

---

## 18. 已知 invariants 與 test gap

### 18.1 Invariants(任何 frame 相關 code 都該保持)

1. **Beam-mesh alignment**: laser 的 beam start lab pos == 該 laser asset 的「intended emission point」(asset 作者標的 CAD 點)在 lab 的位置
2. **Anchor 雙路一致**: frontend `bodyFramePointToObjectLocalMm` 算出的 object-local 跟 backend `_apply_body_frame_to_anchor` 算出的應該相等(同一個 anchor,同一個 asset)
3. **PHY editor 跟 lab scene 對齊**: 在 PHY editor 內把 body origin 對齊 scene 原點,跟 lab scene 內的 body origin 在 lab 的位置,差恰好是 `obj.xyz + rotateVecLab(bfp, obj.rxyz)`
4. **Mesh 變換 idempotent**: 對 `bfp == 0 && R_body == I` 的 asset,變不變換都該得到一樣的 mesh 位置
5. **Direction 不平移**: 任何 direction vector 過 body-frame 轉換**只有 rotation,沒有 translation**(`bodyFrameDirectionToObjectLocal` 確保)

### 18.2 Test gap

| 測試 | 現有? | 該加? |
|---|---|---|
| `bodyFramePointToObjectLocalMm` 算術 | ✓ | — |
| `emissionFromObject` 算術 | ✓ | — |
| `_apply_body_frame_to_anchor` 算術 | ✓(`test_db_scene_loader_frames.py`)| — |
| **beam-mesh alignment integration**(actual loaded mesh + actual beam) | ✗ | **要加**(§15.3) |
| **frontend ↔ backend 一致性**(同 asset 同 anchor 在 frontend 算出 vs backend 算出) | ✗ | 要加 |
| **PHY editor ↔ lab scene 一致性** | ✗ | 要加 |
| **AssemblyRelation 連線端點正確性**(套了 body frame 後) | ✗ | 要加 |
| **RF cable snap-to-target**(套了 body frame 後 cable 端確實到 target anchor 上) | ✗ | 要加 |

---

## 19. 更新此檔的時機

下列情況**必須**回來更新這個 doc:
- 新增任何 frame 階層(例如加 "world frame" 或 sub-binding frame)
- 新增 anchor 欄位或新 anchor.id 慣例
- 修改 `bodyFramePointToObjectLocalMm` 等 helper 的公式
- 改變 mesh 渲染 frame convention(例如真的把 mesh 跟著 body-frame 旋轉)
- 收斂 Phase 9.10/9.11 語意
- 砍掉 legacy ray tracer 或 anchor fallback

更新時保留 §14(變更紀錄)的時間線,append 不刪除。
