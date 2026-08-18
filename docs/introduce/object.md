[← Doc index](README.md)

# SceneObject (Object) — the scene-instance layer

> Layer 4 of the [core data model](data-model.md). How it instantiates a [Component](component.md), and how parameters merge, is in [data-model.md](data-model.md).

**SceneObject (Object)** — an instance placed in the scene. It carries a Lab pose (x/y/z/rx/ry/rz), `visible`, `locked`, and `dynamic_sources` (per-instance runtime values). The name is generated as `KIND+index` (AOM0, MIRROR1; kind = none → NONE0).

- **dynamic_sources** = the runtime values of the whole instance. It stores values for the parameters the Asset marked tunable (`Asset3D.tunable_params`, migration 0113), which is how optics couples to electronics / RF / laser state (laser power and wavelength, rf_source channels, aom RF). The anchor loader folds this dict on top of the asset's default_params before handing it to the trace, but **only tunable keys take effect** — the loader drops leftovers that are a defaultParams key yet not tunable, so non-tunable parameters always track the Asset (see the tunable contract in [data-model.md](data-model.md)).
- The old per-binding `param_overrides` (which could override **any** intrinsic coefficient per instance) was removed in migration 0113 — intrinsic coefficients are now decided purely by the Asset.

> The coordinate conventions and transform chain of the Lab pose are in [anchors.md](anchors.md); the `effective` / `dynamic` parameter-merge formula is in [data-model.md](data-model.md).

The stored pose is **quantized** — 1 nm for `x/y/z mm`, 1e-9° for `rx/ry/rz deg` — so a quaternion round-trip can never persist float residue such as `ryDeg = -8.99e-15`. See "Pose quantization" in [anchors.md](anchors.md).

## Collection 歸屬與 Outliner（一個 object 只有一個家）

`collection_members` 上有 `uq_collection_members_object_home` UNIQUE 約束：**每個 object 至多屬於一個 collection**。所以「搬家」是 UPDATE 既有那一列的 `collection_id`，而不是 delete-then-insert（asyncpg 的交易可見性會讓刪除列仍擋住 INSERT）——見 `backend/app/routers/collections.py:296` `move_object_to_collection`。物件建立時若沒帶 `collection_id`，後端塞進 Master（`backend/app/routers/objects.py:124`）。

**Active collection**：新建的 object 一律進 `activeCollectionId`（store 裡所有 `createObjectApi` 呼叫點都帶這個值），而它會被寫進 localStorage、跨 reload 存活（`sceneStore.ts:4352` / `_persistence.ts:134`）。**它只有兩種方式會變：點 collection 列，或新建 collection**（`OutlinerPanel.tsx:531` / `:371`）。點 object 列**不會**改 active collection——這條 2026-08-18 才修好：以前點一下 Outliner 裡的任何一顆鏡子，之後每個新元件就都被默默丟進那顆鏡子的 collection，而且因為有持久化，重開也還在。

**Drop target = 游標底下最內層的那個節點**。invariant：`handleDropOnCollection` / `handleDragOver` 都必須 `event.stopPropagation()`（`OutlinerPanel.tsx:454` / `:490`）。理由：collection 節點是**巢狀**的（子節點畫在父節點的 div 裡面），所以丟在子 collection 上的 drop 會一路冒泡到每一層祖先，每一層都對同一個 object 各發一次 move POST；這些請求在同一列 home row 上互相競爭、最後 commit 的贏，於是「拖進去只有時候會成功」「一次拖多個只有一部分進得去」。Highlight 也一樣——沒有 stopPropagation 時祖先最後執行，`dragOverId` 永遠停在最外層的 Master。

**還有一個合法的「拖了沒進去」**：locked object 在 dragstart 就被濾掉（`OutlinerPanel.tsx:743`），store 也會靜默 no-op，後端再回 409 當第三道防線。多選裡混了 locked 成員時，未鎖的會搬、鎖住的原地不動，而且沒有提示。
