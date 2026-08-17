# float64 全鏈稽核 — anchor 姿態精度

> 稽核日期：**2026-08-17**。對應 [`docs/objectives.md`](objectives.md) §7 前置工作第 2 項。
> 稽核目標：驗證 anchor 姿態從 **DB → API → tracer** 是否全程維持 float64，足以支撐 **O-1（位置 ≤ 1 µm）** 與 **O-2（角度 ≤ 0.1 µrad）**。

---

## 0. 結論

**機器路徑（DB / API / solver）已經是乾淨的 float64，不需要改。**
**所有精度損失都發生在人工授權 UI（PHY Editor 的 anchor 編輯器）。**

這是好消息 —— 修補範圍侷限在 `Asset3DEditor.tsx` 一個檔案，不是跨層改造。

| 環節 | 判定 |
|---|---|
| DB 欄位型別 | ✅ 乾淨 |
| Pydantic / JSON 序列化 | ✅ 乾淨 |
| 後端 tracer / pose 數學 | ✅ 乾淨 |
| device registry 授權路徑 | ✅ 乾淨 |
| 前端 align 寫回路徑 | ✅ 乾淨 |
| **PHY Editor anchor 寫入路徑** | ~~❌ 破口 A~~ → ✅ **已修（2026-08-17）**，見 §2.1 |
| **PHY Editor 面選取（face-pick）** | ❌ **破口 B：原理性限制,改不掉** → ✅ 已於 UI 標示分級（2026-08-17），見 §2.2 |
| PHY Editor 輸入框 spinner 顆粒度 | ~~⚠️ 破口 C~~ → ✅ **已修（2026-08-17）**，見 §2.3 |
| RF cable 快取摘要 | ⚠️ 17 µrad 級失效門檻,RF 域可接受 |

---

## 1. 乾淨的環節（逐一驗證）

### 1.1 DB 欄位

- **`assets_3d.anchors`** — `JSONB`（[`models/hardware.py:106`](../backend/app/models/hardware.py#L106)）。
  Postgres 的 jsonb 以 `numeric` 儲存數值，任意精度，float64 進出無損。
- **`objects.x_mm / y_mm / z_mm / rx_deg / ry_deg / rz_deg`** — `sa.Float()`
  （[`models/scene.py:42-47`](../backend/app/models/scene.py#L42)，建表於 `0001_initial_schema.py:56-61`）。
  實測 DDL 編譯結果：
  ```
  sa.Float() DDL -> FLOAT
  ```
  Postgres 對不帶精度的 `FLOAT` 一律解讀為 **`double precision`（float8）**。**不是 `real`。**
- 精度餘裕：float64 在 90° 附近的絕對精度約 1.4×10⁻¹⁴ 度 = 2.5×10⁻¹⁶ rad，比 0.1 µrad（10⁻⁷ rad）寬鬆 **9 個數量級**。角度用「度」存完全不是問題。

### 1.2 Pydantic / JSON

- `Vec3V3.x/y/z: float`（[`schemas_v3.py:23-26`](../backend/app/schemas_v3.py#L23)）= Python `float` = float64。
- `AnchorV3`（[`schemas_v3.py:88-115`](../backend/app/schemas_v3.py#L88)）四個 Vec3 欄位全部走同一型別，**無 `Decimal`、無自訂 encoder、無 `round`**。
- JSON 數值序列化（Python `repr` / pydantic-core）採最短往返表示法，float64 → JSON → float64 位元完全相同。

### 1.3 後端數學

- 全 backend grep `float32|float16|astype|dtype=` 的結果中，**幾何/光學路徑一個 float32 都沒有**。
  唯一的 float32 是 [`pop_field.py:210`](../backend/app/optical/pop_field.py#L210) `out.astype(np.float32)` —— 那是 POP 顯示用的強度影像，不進幾何。
- [`pose.py`](../backend/app/optical/pose.py) 的旋轉矩陣 `dtype=float`（=float64），`scipy.spatial.transform.Rotation` 內部亦為 float64。點/方向變換、`compose_transforms` 全程 float64。
- 全 backend grep `round(` 只命中 `magnetics_dc.py`（磁場輸出顯示，`round(v, 6)`）、`schemas.py:2301`（timing 對齊到 TIMING_RESOLUTION_NS，刻意行為）、`pop_pass.py`（像素索引）。**anchor / pose 路徑零命中。**

### 1.4 device registry 授權路徑

[`services/device_seed.py:69-111`](../backend/app/services/device_seed.py#L69) 的 `materialize_device_anchors` 以裸 `float()` 讀取，Gram-Schmidt 正交化在 float64 完成，無任何量化。
**這是目前唯一能達到 0.1 µrad 的 anchor 授權方式**（見 §2.2 結論）。

### 1.5 前端 align 寫回

- `syncFiberEndpointToKindParams`（[`sceneStore.ts:207-242`](../frontend/src/store/sceneStore.ts#L207)）直接搬 `node.posMm` / `tau` 陣列，無格式化。
- `frontend/src/optical/` 下 **零 `Float32Array`**。
- three.js 的 `Vector3` / `Matrix4` / `Quaternion` 元素都是 JS number = float64；只有 `BufferAttribute` 是 float32，而物理路徑不讀它（見 §2.2）。

---

## 2. 破口

### 2.1 破口 A — `mmText()` 把 anchor 寫入量化到 1e-3 ✅ 已修

> **狀態：2026-08-17 已修復。** `mmText` 已刪除，三個寫入路徑改用與載入端相同的無損 `n()`
> （`String(value)`）。`Asset3DEditor.tsx` 全檔已無 `mmText`，`tsc --noEmit` 通過。
> `n()` 的定義處加了註解，說明它為何必須維持無損，避免日後重新引入 `toFixed`。
> 以下保留原始分析作為記錄。

原本的 [`Asset3DEditor.tsx:362-364`](../frontend/src/components/Asset3DEditor.tsx#L362)：

```ts
function mmText(value: number): string {
  return Number(value.toFixed(3)).toString();
}
```

它被套在**三個寫入路徑**上（不是顯示格式化 —— 寫進 `draft.anchors`，存檔即進 DB）：

| 路徑 | 被量化的欄位 | 影響 |
|---|---|---|
| `moveFace` | 位置 px/py/pz | **1 µm 量化** |
| `autoPlaceFace` | 位置 + **axisX (nx/ny/nz)** | 1 µm + **~870 µrad** |
| `orthogonalizeAnchorY` | **axisY (yx/yy/yz)** | **~870 µrad** |

**誤差量化：**
- **位置**：`toFixed(3)` = 0.001 mm = **1 µm**。O-1 的整個誤差預算，**在單一次寫入就用光**。
- **方向**：把單位向量的分量捨入到 1e-3，最壞情況分量誤差 5×10⁻⁴，三分量合成角度誤差可達 √3 × 5×10⁻⁴ ≈ **8.7×10⁻⁴ rad ≈ 870 µrad**。相對 O-2 的 0.1 µrad 預算是 **約 8700 倍超標**。

**觸發面比想像中大。** `orthogonalizeAnchorY` 掛在 axisX **與** axisY 六個輸入框的 `onBlur` 上（[3224–3226](../frontend/src/components/Asset3DEditor.tsx#L3224) / [3231–3233](../frontend/src/components/Asset3DEditor.tsx#L3231)）—— 使用者只要用 Tab 掃過 axisX 欄位，axisY 就被重寫成 3 位小數。

**不幸中的大幸：載入是無損的。** 讀 DB → 表單走 `n()`（[:126-128](../frontend/src/components/Asset3DEditor.tsx#L126)）= `String(value)`，float64 往返完整。**所以只有被「碰過」的 anchor 會壞，沒碰的存檔後原值不變。** 現有 DB 的損壞範圍取決於歷史編輯行為，需要實測稽核（見 §4）。

### 2.2 破口 B — face-pick 從 float32 mesh 推導 anchor

`detectFaceCenterFromHit`（[`Asset3DEditor.tsx:375-571`](../frontend/src/components/Asset3DEditor.tsx#L375)）用 `target.fromBufferAttribute(positionAttr, vertIdx)`（[:405](../frontend/src/components/Asset3DEditor.tsx#L405)）讀頂點 —— `positionAttr` 是 `Float32Array`。中心與法線都由這些 float32 頂點算出，再經 `autoPlaceFace` 寫入 anchor。

**逐項量化：**

| 誤差來源 | 量級 | 對 O-1/O-2 |
|---|---|---|
| float32 頂點 → **位置** | 零件座標 100 mm 尺度：100 × 1.19×10⁻⁷ ≈ **0.012 µm** | ✅ 在預算內 |
| float32 頂點 → 位置（CAD 原點遠離零件，座標 ~5000 mm） | ≈ **0.6 µm** | ⚠️ 逼近預算 |
| float32 頂點 → **法線**（三角邊長 1 mm、座標 50 mm） | δ/L ≈ 6×10⁻⁶ rad = **6 µrad**；平均 N 個三角形降到 6/√N µrad，要 N ≈ 3600 才壓到 0.1 µrad | ❌ 實務上超標 |
| **三角化本身**（不是浮點誤差） | B-1 允許 0.05 mm 幾何偏差；0.05 mm 弧垂配 10 mm 面 ≈ **5 mrad = 5×10⁴ µrad** 法線誤差 | ❌ **超標 5 萬倍** |

**這是本次稽核最重要的結論：**

> **face-pick 原理上無法授權 µrad 等級的 anchor 軸向 —— 主導誤差是網格三角化，不是浮點格式。**
> 就算把整條路徑改成 float64，曲面上選取到的法線仍然是「三角面的法線」而不是「CAD 曲面的法線」。
>
> ⇒ **需要滿足 O-2 的 anchor 必須走 device registry 數值授權**（`materialize_device_anchors`，§1.4），由 datasheet / CAD 標稱值給定，不得由滑鼠點取。face-pick 只能定位到「幾何等級」（~0.05 mm / ~mrad），適用於機械對位與可視化，不適用於光學介面軸向。

#### 已落地的對策：PHY Editor 逐 anchor 顯示授權等級（2026-08-17）

破口 B 本身無法「修」——它是網格三角化的物理上限。能做的是**讓等級可見**，避免有人以為滑鼠點出來的軸是精密的。
anchor 表格每列的 `anchor_id` 欄下方新增兩枚徽章（`pos` / `axis`），等級**即時**由 draft 與 device template 比對推導（`gradeAnchor`，`Asset3DEditor.tsx`）——**不改 schema、不加欄位**：

| 徽章 | 意義 |
|---|---|
| `●` **device**（綠） | device template 宣告了此欄，且 draft 仍與之相符。datasheet / CAD 數值授權，**唯一能扛 1 µm / 0.1 µrad 的等級** |
| `◐` **overridden**（琥珀） | template 有宣告，但 draft 已偏離——被 face-pick / 拖曳 / 手打覆蓋過。精度等同於覆蓋它的東西，不會更好 |
| `○` **geometry**（灰） | 沒有 device，或 template 把此欄留給使用者。face-pick 受三角化限制在 ~mrad |

比對關鍵：**anchor 的 `id` 就是 template 的 `role`**（`materialize_device_anchors` 寫 `role → id`），`name` 用來區分重複 role（AD9959 CH0..CH3、rf_switch RF1/RF2）。容差 `GRADE_DIR_TOL_RAD = 1e-6`、`GRADE_POS_TOL_MM = 1e-6`——遠低於 face-pick 誤差（~mrad / ~0.05 mm）、遠高於 float64 往返噪音。

**設計上的附帶效果**：徽章在 face-pick 的當下就從 `device` 翻成 `overridden`，等於把「face-pick 警示」做成持續顯示而不是一次性彈窗；同時被退役的 `toFixed(3)` 量化過的舊值也會顯示 `overridden`，所以這同時是 §3-5 的「既有資料損壞掃描」的 UI 版本。

**這是純顯示，不擋存檔。** 是否要升級成 optical kind 上的硬性 gate，留給後續決定。

**實測（2026-08-17，27 筆 asset）**：只有 3 筆的 device template 留有未授權欄位，且全是 RF——
`minicircuits_zhl_1_2w_plus`（pos 0/2）、`minicircuits_zyswa_2_50dr`（dir 0/4、pos 0/4）、`ppg`（pos 0/1）。
**光學那批的 anchor 位置與軸向全部由 device template 數值授權**，O-2 在現有目錄上是達標的。
（注意：`_device.ts` 開頭「只有 AD9959 有實測座標」那句註解已過時。）

### 2.3 破口 C — 輸入框 `step="0.01"` ✅ 已修

> **狀態：2026-08-17 已修復。** anchor 的位置 / axisX / axisY 九個輸入框改用
> `ANCHOR_STEP = "0.001"`：位置箭頭鍵一格 = **1 µm**（= O-1 預算），方向分量一格 ≈ **1 mrad**，
> 比原本細 10 倍。aperture 三格維持 `0.01`（clip 半徑，不在 O-1/O-2 預算內）。
> 實機驗證：位置 spinner 141.85 → 141.851（Δ = 0.001 mm）。

原本 `<input type="number" step="0.01">`：位置箭頭鍵一格 = **10 µm**，方向分量一格 = **10 mrad**。
不是硬性量化（手打任意值可通過），但它是 UI 對使用者示範的預設顆粒度，與 µm/µrad 目標矛盾。

**稽核時漏掉、修復時才發現的一條潛伏陷阱（重要）：**

`step` 不只是 spinner 增量，也是 **HTML 的 validity 約束** —— 落在 step 網格外的值會 `stepMismatch`。
修完破口 A 之後寫進欄位的是 17 位數（`-0.5734623443633284`），照理應該立刻變 `:invalid`。**實測沒有**，原因是：

> HTML 規格的 **step base** 在沒有 `min` 屬性時取自 **`value` content attribute**；React 的 controlled
> input 會把值同時鏡射到該屬性，於是「值 = 自己的基準」，永遠落在格子上。

實測佐證（同一個欄位，只拿掉 `value` 屬性）：

| 狀態 | `stepMismatch` |
|---|---|
| React 正常渲染（有 `value` 屬性） | `false` |
| 手動 `removeAttribute("value")` | `true` —「最接近的兩個有效值分別是 -0.58 和 -0.57」 |

⇒ **不變式：這幾個 anchor 輸入框必須維持 controlled（`value={...}`）。** 一旦改成 uncontrolled
（`defaultValue`、或自行管理 DOM 值），所有全精度 anchor 值會立刻變成 `:invalid`。
這也是「保留有限 `step` 而不是改用 `step="any"`」唯一安全的前提 —— 已寫進
`ANCHOR_STEP` 的註解。

### 2.4 觀察 D — RF cable 快取摘要（可接受）

[`DigitalTwinViewer.tsx:3815`](../frontend/src/components/DigitalTwinViewer.tsx#L3815) 與 `:3880` 用 `.toFixed(3)` 組快取失效摘要字串。
意義：目標物件姿態變動小於 0.001 mm / 0.001°（= **17 µrad**）時，cable 端點快取不會重算。
**這是快取門檻，不是儲存值** —— 註解已標明 `raw-anchor-ok: digest of stored body-frame value`。RF 域無 µrad 需求，**判定可接受，但需記錄**：若日後把同一模式複製到光學路徑會直接違反 O-2。

---

## 3. 建議修補（依優先序）

1. ~~**移除寫入路徑上的 `mmText`**~~ —— ✅ **2026-08-17 完成。** 三處呼叫（`moveFace` / `autoPlaceFace` / `orthogonalizeAnchorY`）改用載入端同一個無損 `n()`；`mmText` 全檔無其他用途，已刪除。破口 A 消除。
2. ~~**`step` 改為 `any`**~~ —— ✅ **2026-08-17 完成，但沒有用 `any`。** 改為 `ANCHOR_STEP = "0.001"`：`step="any"` 會讓 Chrome 的箭頭鍵退回一格 1.0（對 [-1,1] 的方向分量是災難），而有限 step 在 controlled input 下不會誤判 validity（見 §2.3）。位置/方向皆 0.001，aperture 維持 0.01。
3. ~~**政策落地：anchor 分兩級授權**~~ —— ✅ **2026-08-17 完成（顯示層）。** PHY Editor 逐 anchor 顯示 `device` / `overridden` / `geometry` 三級徽章，詳見 §2.2。實作為三級而非原本設想的兩級：`overridden`（曾是 device-grade、已被覆蓋）在實務上是最需要看見的狀態。仍待決定的是要不要在光學 kind 上把它升級成**硬性存檔 gate**。
4. ~~**CI 守門**~~ —— ✅ **2026-08-17 完成。** [`.github/workflows/ci-correctness.yml`](../.github/workflows/ci-correctness.yml)（本 repo 第一個 workflow，backend job 帶 postgres service）。三條守則落在兩個檔：
   - [`backend/tests/test_anchor_precision_guard.py`](../backend/tests/test_anchor_precision_guard.py) — 序列化位元相等、DB 往返位元相等（anchor + object pose）、`information_schema` 斷言 `objects.x_mm…rz_deg` 為 `double precision` 且 `assets_3d.anchors` 為 `jsonb`。全部用 `==` 而非 `approx`。額外有一條 **self-guard**：驗證 witness 值本身確實偵測得到 float32 與 3 位小數捨入，防止有人把常數換成整數後測試變成空轉。
   - [`frontend/src/components/__tests__/anchorWritePath.guard.test.ts`](../frontend/src/components/__tests__/anchorWritePath.guard.test.ts) — 掃描 `updateAnchor(...)` 的每個呼叫點（平衡括號取參數），禁止 `toFixed` / `toPrecision` / `Math.round`；斷言 `mmText` 不存在；斷言九個 anchor 輸入框都用 `ANCHOR_STEP`（≤ 0.001）且維持 controlled（§2.3 的不變式）。
   - **已實測會擋**：把 `moveFace` 的 `px: n(position.x)` 改回 `toFixed(3)`，守門立刻失敗並印出理由；還原後恢復綠燈。
5. **實測現有資料損壞範圍** —— 掃全表 anchors，統計有多少 `positionMmBodyLocal` / `axisXBodyLocal` / `axisYBodyLocal` 分量剛好是 3 位小數的整數倍（`v*1000` 為整數）。命中率高者即為破口 A 的歷史受害者。⚠️ 修復 locked 列需先請使用者解鎖，不得自行處理。

---

## 4. 未涵蓋

- **未實測現有 DB 資料**的量化痕跡（建議 3-5，需要跑起 stack）。
- **未驗證 live DB** 的 `information_schema` 實際型別 —— 本次以 SQLAlchemy DDL 編譯結果推定為 float8（Postgres 對 `FLOAT` 的定義是明確的，風險低），建議 3-4 補上實查。
- 前端 `v3TraceAdapter` 回傳的光路 polyline 精度未稽核（那是顯示路徑，不回寫 anchor）。
