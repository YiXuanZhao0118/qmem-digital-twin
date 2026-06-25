[← 文件索引](README.md)

# 核心資料模型（最重要的抽象）

> 各層詳解：[asset.md](asset.md)、[component.md](component.md)、[object.md](object.md)；座標標註見 [anchors.md](anchors.md)。

四層模型，**參數歸屬（param ownership）是整個系統的脊椎規則**——這條規則已在資料層由 migration 0094/0095/0096 強制落實：

```
Asset3D    （幾何 + anchors[] + defaultParams = 物理真值 + tunableParams 標記）
   ▲  透過 ComponentBinding 樹綁定（local transform、tunable axes、role_label）
Component  （vendorPart + 綁定樹 + exposedFaces；★不存 kind、不存物理）
   ▲  實例化為
SceneObject（Lab pose + dynamicSources）
```

1. **Asset3D** — 可重用 3D 模型 + 其物理預設。**物理預設只存在這裡。** → 詳見 [asset.md](asset.md)。
2. **Component** — 目錄「模板」。**本身沒有 kind、沒有物理參數。** → 詳見 [component.md](component.md)。
3. **ComponentBinding** — 綁定樹節點，把資產（或子元件）掛在父節點下。 → 詳見 [component.md](component.md)。
4. **SceneObject（Object）** — 場景中放置的實例。 → 詳見 [object.md](object.md)。

---

## 參數合併順序（`anchor_tracer.py`）

`effective = asset.defaultParams ⊕ (dynamicSources ∩ tunableParams)`（後者覆蓋前者）。實作上 `db_scene_loader` 把 SceneObject 的 `dynamic_sources` 欄位摺進 dynamic（再加上 server-resolved 的 AOM RF 鏈），tracer 做 `{**default_params, **dynamic}`（`anchor_tracer.py`）。**transitions 已於 migration 0106 移除**；**per-binding `param_overrides` 已於 migration 0113 移除**。

- **Asset3D.tunableParams**（migration 0113）= Asset 作者標記哪些 top-level defaultParams key 可逐實例調。PHY Editor 在每個 param 後方提供勾選框；只有勾選的 key 會出現在 SceneObject 的編輯器。
- **tunable 契約（後端強制）**：`db_scene_loader` 合併 `dynamic_sources` 後，**丟掉所有「是 defaultParams key 但不在 tunableParams」的 key**（`db_scene_loader.py`）。所以 non-tunable 參數**永遠跟著 Asset** ——殘留/legacy 的 per-instance 值（舊 `write_laser_dynamic_sources` 寫進 dynamic_sources 的整包 beam、`properties.opticalSources[0].beam`）不會再 shadow Asset 編輯。不是 asset param 的 key（aomFreqMhz、channels…執行期耦合）原樣通過。
- **dynamicSources** = 整個 instance 的執行期值，有效的只有 tunableParams 標記的 key，把光學耦合到電子/RF/雷射狀態：
  - laser_source：nominalPowerMw、centerWavelengthNm（預設 tunable；其餘 beam 參數由 asset 決定）。註：emit op 讀 power 時 `nominalPowerMw`（asset 自己的 key）優先於 legacy 的 `powerMw`/`laserPowerMw` alias，逐實例調功率才會生效（`emit_laser_source.py`）。
  - aom：aomFreqMhz、rfDrivePowerW/aomRfVpp（由上游 RF 鏈灌入；dynamicSources 是手動覆寫 fallback）
  - rf_source：`channels[]` CH0–3 + `fullScaleVpp` 都是 asset `default_params` 係數，`dynamic_sources` 逐實例覆寫（tunable 預設 `["channels","fullScaleVpp"]`）——**跟光學同一套模型**。channels 解析鏈 `dynamic_sources` → asset default → 舊 `kindParams.channels`(legacy fallback)；AD9959 面板 per-channel 編輯寫 `dynamicSources.channels`。**注意 RF 走獨立路徑**：`rf_resolve.py`（非 `db_scene_loader`/`anchor_tracer`）自己讀 `asset.default_params` + `dynamic_sources`，seed Vpp = `amplitudeScale × fullScaleVpp`（見 [cable.md](cable.md)）。
  - 限制：dynamic_sources 為 per-object（非 per-binding），複合元件的多個子資產共用同一份，故 tunable 參數適用於單一資產的 source 元件（laser/rf_source）。

物理參數分兩類：`intrinsic_param_keys`（硬體固定，如折射率、晶體長度——只能由 Asset 改）vs `state_param_keys`（執行期可調，如 RF 頻率、繞射階數）。kind 的 `state_param_keys` 是 Asset `tunableParams` 的種子預設（migration 0113 回填、Asset 編輯器新建時種子）。

## Typed param schema + 通用編輯器（schema-driven UI）

為了不用「每個 asset 各寫一套 UI」,kind 可在 plugin 宣告 **`physics.paramSchema`**（`kinds/paramSchema.ts`:`ParamSpec` = `number`/`enum`/`boolean`/`record`/`list`）——係數型別 `number→輸入框`、`enum→下拉`。**一個** 通用 renderer（`components/physics/SchemaParamEditor.tsx`）依此 schema 畫出所有欄位 + tunable 勾選,取代 per-asset bespoke 編輯器（device-registry 規劃書「❌ per-type 編輯器分支」）。schema **住在 kind**（行為層共用,DRY）;asset/device 供值;**list 的長度由 anchors 決定**（`cardinalityFromRole:"rf_out"`→AD9959 4 通道、DG4202 2 通道）。`paramSchema` 是**前端專用**(同 `optionalParams`,不進 kinds.json manifest)。首位採用者:`rf_source`(2026-06-15,Phase 1 = PHY 編輯器 `Asset3DEditor` 走 `DefaultParamsSchemaFields`,終結 rf_source 的 raw-JSON);Object 面板逐實例 + 退役 `Ad9959ObjectControls`/光學 `InstanceDynamicSourcesEditor` 收斂為後續 phase。AD9959 的 sweep 預覽 / FM-PM-AM profiles / 衍生 SYS_CLK 等不可泛化的 widget 留 bespoke escape hatch。
