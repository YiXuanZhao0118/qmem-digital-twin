[← 文件索引](README.md)

# 擺放與吸附（Placement & Snapping）

> 座標系與 anchor 見 [anchors.md](anchors.md)；光束來源見 [optics.md](optics.md)。引擎在 `frontend/src/three/placement/`（`engine.ts` / `snapTargets.ts` / `gizmo.ts` / `snapOverlay.ts`）。

## 心智模型

光學位置是相對的（相對光束、元件、對稱軸），不是絕對的。Lab pose 是**持久化輸出**而非主要輸入；主要輸入是「帶吸附意圖的拖曳」。不用會跟使用者作對的 assembly_relations，改記**意圖 metadata**（`placedRelativeTo`，記得但不強制執行）。所有輸入源（gizmo 拖曳、N 面板數字輸入、Shift+S 游標選單、多選對齊、Place-along-beam）都組成同一個 `PlacementIntent` 走同一純函式引擎，**無旁路**。

## 引擎管線（`computePlacement(input) → PlacementResult`）

純函式（`engine.ts`），依序：

1. **axis-lock**（`applyAxisLock`）：使用者鎖單軸（gizmo / G+X）時，候選位置只在該軸生效，其餘兩軸還原成物件當前 pose。
2. **早退**：snap 關閉或沒啟用任何吸附類別 → 直接落在候選點，`intentMetadata.kind = "absolute"`。
3. **收集 SnapTarget**：對每個**已啟用的類別**呼叫對應 collector（beam / geometry / anchor / reference / grid，見下表）。geometry 類需要 `componentGroup`（Three.js mesh 群）才有作用；reference 類目前收集 cursor + world_origin。
4. **門檻過濾**：每個候選依 `distanceMm` 比對門檻——per-kind 覆寫 > per-category 覆寫（smart popover 每類一個滑桿）> `DEFAULT_THRESHOLDS_MM`。全部超出 → 落候選點、`absolute`。
5. **排序**（`rankByOpticalRelevance`）：tier 最小者為 best，同 tier 取距離近。回傳 `snappedTo`=best、`alternatives`=次佳最多 3 個（UI 用 Tab 循環）、`reasoning` 字串、`intentMetadata`。

`PlacementResult` 一律帶非空 `intentMetadata`（至少 `absolute`），寫進 `SceneObject.properties.placedRelativeTo`。

## SnapTarget 種類（型別定義 13 種，**實際收集 12 種**，歸 5 類）

| kind | 類別 | 預設門檻 mm | 說明 |
|---|---|---|---|
| `beam_centerline` | beam | 25 | 吸到光束中心線上最近點 |
| `beam_along` | beam | 25 | 沿被點選光束 @N mm（Layer 4 明確點選，最高優先） |
| `beam_intersection` | beam | 15 | 兩光束交點 |
| `beam_endpoint` | beam | 15 | 光束端點（源 / 命中） |
| `mesh_vertex` | geometry | 10 | mesh 頂點 |
| `mesh_edge_midpoint` | geometry | 10 | 邊中點（⚠️ 型別與 tier 有定義，但 `collectMeshEdgeMidpointSnaps` **未被 `computePlacement` 呼叫 → 目前 dead、不收集**） |
| `mesh_face_centroid` | geometry | 15 | 面形心 |
| `mesh_bbox_center` | geometry | 20 | 包圍盒中心 |
| `anchor` | anchor | 5 | 元件 anchor（最具體，門檻最緊） |
| `cursor` | reference | 30 | 3D 游標（Shift+S） |
| `world_origin` | reference | 30 | 世界原點 |
| `object_plane` | reference | 5 | 物件平面（已定義，保留） |
| `grid` | grid | 1 | 格點（fall-through，門檻形同未用） |

每個 SnapTarget 帶 `pointLab`（落點）、選用 `directionLab`（光束朝向 / 法向 / anchor 外向，供 Layer 4 對齊被拖物件的前向軸）、`ref`（供 Re-snap 重建）、`label`、`distanceMm`。

## 排序優先序（`rankByOpticalRelevance` tier，小者優先）

`beam_along`(0) > beam_centerline / endpoint / intersection（**目標是光學件→1，否則→4**）> `anchor`(2) > `mesh_face_centroid`(3) > `mesh_bbox_center`(3.2) > `mesh_vertex`(3.4) > `mesh_edge_midpoint`(3.6) > `object_plane`(5) > `cursor`(5.2) > `world_origin`(5.4) > `grid`(9)。同 tier 取 `distanceMm` 近者。

→ 直覺：使用者明確點選的光束最優先；對光學件而言「對到光束」勝過「對到網格幾何」，但對非光學件（如機構座）光束退到很後面。`anchor` 永遠勝過一般網格點。

## 意圖 metadata（`placedRelativeTo`）

吸附結果映成持久化意圖（`snapTargetToMetadata`），日後可被 Re-snap 重放：

| SnapTarget kind | `placedRelativeTo.kind` | 記錄 |
|---|---|---|
| `beam_along` | `beam_along` | `linkId` + `distanceMm` |
| beam_centerline / endpoint / intersection | `beam_centerline` | `linkId` |
| `anchor` | `anchor_match` | `refObjectId` + `refAnchorId` |
| mesh_vertex / edge_midpoint | `vertex_snap` | `refObjectId` |
| `mesh_face_centroid` | `face_touch` | `refObjectId` |
| `cursor` | `cursor` | — |
| bbox_center / world_origin / object_plane / grid | `absolute` | — |

`describePlacement()` 把它變成人看的字串（如「12 mm along beam ab12cd34」「anchor-matched to …」）。

## 7 層架構（L0–L7）

- **L0** 純引擎（上述 `computePlacement`）。
- **L1** gizmo（Global / Local / Beam 朝向，TransformControls）。
- **L2** 吸附視覺回饋 + Tab 循環 alternatives。
- **L3** 3D cursor（Shift+S 選單；狀態 `transformCursorMm`）。
- **L4** 光學工具（Place / Insert along beam；最後點擊光束點 `scopeProbe`）。
- **L5** 多選 Align。
- **L6** `placedRelativeTo` + Re-snap。
- **L7** 表達式數字欄（`+50` / `*2` / `@200` / `mid(A,B)`，`exprInput.ts` / `NumberField.tsx`）。

## 多選變更：先全部寫完，才算光路 / RF

**鐵則：任何一次動到多個 SceneObject 的 pose，必須走 `sceneStore.updateSceneObjects`（`store/sceneStore.ts:3250`）一次 commit，不可以 loop `updateSceneObject`。**

原因：光路 trace 與 RF 是 **scene 驅動**的 —— `DigitalTwinViewer` 的 debounce effect（`components/DigitalTwinViewer.tsx:1553`，150 ms，dedup key = `sceneData` identity）在 `scene.objects` 換身分時重跑 `/api/v3/solver/run-from-db`，RF schedule 也在同一個 effect 內重建。每呼叫一次 `updateSceneObject` 就是一次獨立 `set()` → 一次全場景 rebuild + 一次 cable re-snap + 一支 undo 紀錄；13 個物件一起搬就是 13 次，這正是「多選一起移動很卡」的來源。批次版把所有 PATCH 併發送出、**最後只 commit 一次**，所以重算只在定案的場景上跑一次。

`updateSceneObjects` 的契約（測試釘在 `store/__tests__/updateSceneObjects.test.ts`）：

- N 個物件 → **1 次 store commit**、**1 筆 undo**（描述 `Update N objects`）、1 次 `resnapRfCablesLinkedTo`。
- locked 物件在任何網路呼叫前就被丟掉（與單筆路徑同契約）；重複的 `objectId` 為 last-write-wins。
- **剛性群組展開整批做**：每個明確給定且帶 pose 的 entry 各自 `expandPoseToRigidGroup`（`utils/rigidGroup.ts:227`）；衍生 patch 遇上呼叫端已明確指定的物件時**讓給明確 patch**（多選拖曳本來就自己搬每個成員）。某個 leading 物件因群組內有 locked 成員被拒時，只丟掉那一筆，選取範圍其餘照搬。

目前走批次路徑的入口：gizmo 多選拖曳（`DigitalTwinViewer.tsx` 的 `onDragEnd`，primary + followers 併成一次呼叫）、Object 面板的 Group delta 欄位（`ComponentPanel.MultiSelectTransformPanel`）、Align / Distribute（`AlignPanel.tsx`）、Shift+S 游標選單的 Selection→Cursor / →Active（`optical/CursorMenu.tsx`）。

### 光走回頭路的三個洩漏點（都已封住）

只把「寫入」批次化還不夠 —— 實測（13 個物件一起搬）一開始仍有 **22 次 commit**，收斂到 **2 次**（1 次搬移 + 1 次 cable 寫回）靠的是三件事一起做：

1. **寫入合批** —— `updateSceneObjects`，如上。
2. **WebSocket 回音合批 + 自我回音丟棄**（`sceneStore.applyEvents` + `App.tsx` 的 `WS_FLUSH_MS = 16` 緩衝）。所有寫入都會被後端廣播回來，13 筆 PUT 就是 13 個 `object.updated`，各自 commit 一次。現在 App 把一個 frame 內到達的訊息收成一批交給 `applyEvents`（`reduceSceneEvent` 逐事件摺疊，只 set 一次），而 `object.updated` 另外有兩道自我回音閘門：
   - **in-flight 閘門**（`inFlightObjectWrites`）：本端 PATCH 尚未落地時丟棄該物件的廣播 —— 後端是 **commit 當下就廣播、HTTP response 後到**，批次寫入時前幾筆的回音會早於我們存下回應，`updatedAt` 還比不出來。只有「自己 commit 回應」的路徑會註冊；**undo / redo 直接呼叫 `updateObjectApi` 而不 set()，靠廣播更新 store，所以刻意不註冊**（動到這裡要保住這條）。
   - **`updatedAt` 閘門**：store 內已是同一版本就原封返回 `state`（不換陣列）。後端每次寫入都蓋微秒級 `updatedAt`，遠端真編輯一定更新。
3. **cable 寫回合批**（`resnapRfCablesLinkedTo`）：原本每條 cable 每個端點各一次 PATCH + commit（3 條線 = 6 次）。現在用純函式 `buildRfCableAlignmentProps` 把 End A / End B 摺進同一份 properties，最後一次 `updateSceneObjects(..., { recordHistory: false })` —— `recordHistory: false` 是因為它是**衍生寫入**，觸發它的搬移已經記過一筆 undo。

實測驗證（Lab 分頁、13 物件、含 3 條 rf_cable 的場景）：commit 22 → 2、`/api/v3/solver/run-from-db` 每次搬移 2 次、undo 由 13 筆變 1 筆且一次還原全部。

## 已知限制

- 後端基本不動（`placedRelativeTo` 只是 `SceneObject.properties` 上的 JSON）。
- Re-snap 目前只支援 `beam_along`。
- 大 STL（>5k 頂點，如 14k 的 BB1-E03）mesh 吸附需 subsample。
