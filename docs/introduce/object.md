[← 文件索引](README.md)

# SceneObject（Object）— 場景實例層

> 屬 [核心資料模型](data-model.md) 第 4 層。它如何把 [Component](component.md) 實例化、參數如何合併見 [data-model.md](data-model.md)。

**SceneObject（Object）** — 場景中放置的實例。有 Lab pose（x/y/z/rx/ry/rz）、`visible`、`locked`、`param_overrides`（per-binding 靜態校正）、`dynamic_sources`（per-instance 執行期值）。名稱自動產生為 `KIND+index`（AOM0、MIRROR1；kind 為 none → NONE0）。

- **param_overrides** = per-binding 靜態校正（任何 defaultParams key）。
- **dynamic_sources** = 整個 instance 的執行期值，把光學耦合到電子/RF/雷射狀態（laser_source、aom、rf_source）。

> Lab pose 的座標慣例與變換鏈見 [anchors.md](anchors.md)；`effective` / `dynamic` 參數合併公式見 [data-model.md](data-model.md)。
