[← 文件索引](README.md)

# 核心資料模型（最重要的抽象）

> 各層詳解：[asset.md](asset.md)、[component.md](component.md)、[object.md](object.md)；座標標註見 [anchors.md](anchors.md)。

四層模型，**參數歸屬（param ownership）是整個系統的脊椎規則**——這條規則已在資料層由 migration 0094/0095/0096 強制落實：

```
Asset3D    （幾何 + faces + transitions + defaultParams = 物理真值）
   ▲  透過 ComponentBinding 樹綁定（local transform、tunable axes、role_label）
Component  （vendorPart + 綁定樹 + exposedFaces；★不存 kind、不存物理）
   ▲  實例化為
SceneObject（Lab pose + paramOverrides[bindingId] + dynamicSources）
```

1. **Asset3D** — 可重用 3D 模型 + 其物理預設。**物理預設只存在這裡。** → 詳見 [asset.md](asset.md)。
2. **Component** — 目錄「模板」。**本身沒有 kind、沒有物理參數。** → 詳見 [component.md](component.md)。
3. **ComponentBinding** — 綁定樹節點，把資產（或子元件）掛在父節點下。 → 詳見 [component.md](component.md)。
4. **SceneObject（Object）** — 場景中放置的實例。 → 詳見 [object.md](object.md)。

---

## 參數合併順序（`ray_tracer_v3.py`）

`effective = asset.defaultParams ⊕ paramOverrides[bindingId] ⊕ transition.params`；`dynamic = sceneObject.dynamicSources`。

- **paramOverrides** = per-binding 靜態校正（任何 defaultParams key，如某片波片實測 retardance 88°）。
- **dynamicSources** = 整個 instance 的執行期值，把光學耦合到電子/RF/雷射狀態：
  - laser_source：powerMw、centerWavelengthNm、spectrum、polarization、spatialMode
  - aom：aomFreqMhz、rfDrivePowerW/aomRfVpp（通常由上游 RF 鏈灌入，dynamicSources 是手動覆寫 fallback）
  - rf_source：channels[] CH0–3

物理參數分兩類：`intrinsic_param_keys`（硬體固定，如折射率、晶體長度）vs `state_param_keys`（執行期可調，如 RF 頻率、繞射階數 → 對應 dynamicSources）。
