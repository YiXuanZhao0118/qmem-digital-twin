[← Doc index](README.md)

# SceneObject (Object) — the scene-instance layer

> Layer 4 of the [core data model](data-model.md). How it instantiates a [Component](component.md), and how parameters merge, is in [data-model.md](data-model.md).

**SceneObject (Object)** — an instance placed in the scene. It carries a Lab pose (x/y/z/rx/ry/rz), `visible`, `locked`, and `dynamic_sources` (per-instance runtime values). The name is generated as `KIND+index` (AOM0, MIRROR1; kind = none → NONE0).

- **dynamic_sources** = the runtime values of the whole instance. It stores values for the parameters the Asset marked tunable (`Asset3D.tunable_params`, migration 0113), which is how optics couples to electronics / RF / laser state (laser power and wavelength, rf_source channels, aom RF). The anchor loader folds this dict on top of the asset's default_params before handing it to the trace, but **only tunable keys take effect** — the loader drops leftovers that are a defaultParams key yet not tunable, so non-tunable parameters always track the Asset (see the tunable contract in [data-model.md](data-model.md)).
- The old per-binding `param_overrides` (which could override **any** intrinsic coefficient per instance) was removed in migration 0113 — intrinsic coefficients are now decided purely by the Asset.

> The coordinate conventions and transform chain of the Lab pose are in [anchors.md](anchors.md); the `effective` / `dynamic` parameter-merge formula is in [data-model.md](data-model.md).

The stored pose is **quantized** — 1 nm for `x/y/z mm`, 1e-9° for `rx/ry/rz deg` — so a quaternion round-trip can never persist float residue such as `ryDeg = -8.99e-15`. See "Pose quantization" in [anchors.md](anchors.md).

## 隱藏零件：`properties.hiddenBindings`（2026-08-26）

一個 composite Component 買進來是整組的，但不見得整組都裝上去。`Mech Post 1 inch` 是 RS1P 柱子底下綁一個 CF125C_M 壓叉（兩列 ComponentBinding：`RS1P-Step` root + `CF125C_M-Step` child），可是直接插在孔位上的柱子身上沒有壓叉——而場景裡二十幾支柱子共用同一個 Component，所以**不能刪那一列 binding**：它是 catalog 共用的，還帶著校正過的 pose 和 Object 面板在調的那個 tunable `localRzDeg`。

所以隱藏是**每個 instance 各自的、而且只影響畫面**：

```json
"properties": { "hiddenBindings": ["<component_binding_id>", …] }
```

- 寫入：Object 面板 → **Per-instance adjustments → Parts**，binding tree 照原樣列出（依 `sort_order`、按層縮排，標籤取 `properties.role_label` → `role`），一個零件一個勾選框。單根 binding 的 Component 不顯示這一區——那等於物件自己的 `visible`。
- 讀取：`utils/componentBindings.hiddenBindingIds` → `three/bindingRendererGate.buildSceneObjectFromBindings`，對被隱藏的節點讓 binding loader 回傳 `null`。那是 `BindingLoader` 既有的「連同 subtree 一起跳過」語意，所以隱藏一個零件，掛在它上面的東西也跟著不畫。
- **什麼都沒有被刪**：`component_bindings` 那兩列還在，這顆 instance 的 `object_bindings.local_rz_deg_delta` 也還在。取消勾選就回到原本校正好的姿態（RZ 一併回來）。這跟 `bindingFiberNodes` / `translucentHousing` 是同一種分層：binding 列是共用的 catalog 基準，這一顆怎麼裝在 SceneObject 上。
- 純視覺：後端 loader 與 tracer 完全不讀這個鍵，隱藏零件不會改變任何 trace 結果。
- ⚠ 隱藏會拿掉幾何，所以它必須進 `DigitalTwinViewer` 的 mesh reuse key（`renderHintsKeyNow` 的 `hb=`）——`componentRef` / `assetRef` 在切換前後都相等，少了這一段快取會繼續送舊的 mesh。同 [component.md](component.md) 裡 per-instance spline 的那條警告。

## Collection 歸屬與 Outliner（一個 object 只有一個家）

`collection_members` 上有 `uq_collection_members_object_home` UNIQUE 約束：**每個 object 至多屬於一個 collection**。所以「搬家」是 UPDATE 既有那一列的 `collection_id`，而不是 delete-then-insert（asyncpg 的交易可見性會讓刪除列仍擋住 INSERT）——見 `backend/app/routers/collections.py:296` `move_object_to_collection`。物件建立時若沒帶 `collection_id`，後端塞進 Master（`backend/app/routers/objects.py:124`）。

**Active collection**：新建的 object 一律進 `activeCollectionId`（store 裡所有 `createObjectApi` 呼叫點都帶這個值），而它會被寫進 localStorage、跨 reload 存活（`sceneStore.ts:4352` / `_persistence.ts:134`）。**它只有兩種方式會變：點 collection 列，或新建 collection**（`OutlinerPanel.tsx:801` / `:519`）。點 object 列**不會**改 active collection——這條 2026-08-18 才修好：以前點一下 Outliner 裡的任何一顆鏡子，之後每個新元件就都被默默丟進那顆鏡子的 collection，而且因為有持久化，重開也還在。

**Drop target = 游標底下最內層的那個節點**。invariant：`handleDropOnCollection` / `handleDragOver` 都必須 `event.stopPropagation()`（`OutlinerPanel.tsx:661` / `:714`）。理由：collection 節點是**巢狀**的（子節點畫在父節點的 div 裡面），所以丟在子 collection 上的 drop 會一路冒泡到每一層祖先，每一層都對同一個 object 各發一次 move POST；這些請求在同一列 home row 上互相競爭、最後 commit 的贏，於是「拖進去只有時候會成功」「一次拖多個只有一部分進得去」。Highlight 也一樣——沒有 stopPropagation 時祖先最後執行，`dragOverId` 永遠停在最外層的 Master。

**Collection 的排序自己排（2026-08-24）**：`collections.sort_order` 一直存在、`buildChildrenIndex` 也一直照它排，但 UI 沒有任何寫入口，所以整棵樹的 sibling 全是 0，順序只能靠 createdAt。現在拖 collection 時，落點依游標在**目標自己那一列**的高度分三段（`REORDER_EDGE = 0.25`）：上緣 25% = 插在它前面、下緣 25% = 插在它後面（兩者都是變成 target 的 sibling），中間 50% 維持原本的「丟進去變子 collection」。落點 zone 存在 `dropZoneRef`——dragover 與 drop 可能落在同一個 task，state 的寫入還看不到，drop closure 會讀到過期的值（`OutlinerPanel.tsx:714` / `:661`）。

排序落地時 **整排 sibling 會重編號 0..n-1**（`reorderCollection`，`OutlinerPanel.tsx:630`）：被拖的那個走 `/move`（順便處理跨父層），其餘只改變號碼的才發 PUT。必須整排寫，因為既有資料的 sort_order 全是 0，只改一個的話順序仍然是未定義的。`buildChildrenIndex` 的第二排序鍵是 `createdAt`：sort_order 相同時，store 的 `upsertById` 每次更新都把該列 append 到陣列尾端，沒有穩定的次鍵時，改個名字或按一下眼睛就會讓那個 collection 掉到 sibling 最後面。

Master 不能被排——它是樹根，前後沒有位置；把 collection 拖到自己子孫旁邊也會被 `isAncestorOrSelf` 擋掉。

**還有一個合法的「拖了沒進去」**：locked object 在 dragstart 就被濾掉（`OutlinerPanel.tsx:1014`），store 也會靜默 no-op，後端再回 409 當第三道防線。多選裡混了 locked 成員時，未鎖的會搬、鎖住的原地不動，而且沒有提示。

**Outliner 搜尋（2026-08-25）**：標題列下方多了一個搜尋框（`OutlinerPanel.tsx:1169`），比對命中的 object 才留在樹上，沿途的 collection 祖先一併保留並強制展開（`matchingObjectIds` / `matchingCollectionIds`，`OutlinerPanel.tsx:340` / `:354`；展開規則見 `:768`）。三個要點：

1. **比對的是 Component 身份，不是 object 名字**。object 名字是 `KIND+index`（MECHANICAL36），使用者要找的是「Post Spacer 2.0 mm」這個料件，所以 haystack = object.name + component 的 name / brand / model / kindId，和 Components catalog 的 filter 同一組欄位（`utils/components.ts:20` `objectSearchHaystack`）。欄位之間用 NUL 串接，needle 不會跨欄位命中。
2. **兩邊都去掉空白**（`normalizeSearchText`，`utils/components.ts:11`）：使用者打「post spacer 2.0mm」，catalog 寫的是「Post Spacer 2.0 mm」，不 normalize 就永遠對不上。
3. **Managed 區塊也吃同一個搜尋**（`visibleManagedObjects`，`OutlinerPanel.tsx:370`），所以 `matchingObjectIds` 是掃 `scene.objects` 而不是 `visibleObjects`——只濾樹、不濾 Managed 的話，過濾後畫面上還會剩七條無關的 rf_cable。

搜尋期間 collection 的展開狀態被 override，使用者手動收合的節點不受影響（`expanded` 沒有被寫）；清空搜尋就回到原本的樹。
