[← 文件索引](README.md)

# SceneObject（Object）— 場景實例層

> 屬 [核心資料模型](data-model.md) 第 4 層。它如何把 [Component](component.md) 實例化、參數如何合併見 [data-model.md](data-model.md)。

**SceneObject（Object）** — 場景中放置的實例。有 Lab pose（x/y/z/rx/ry/rz）、`visible`、`locked`、`dynamic_sources`（per-instance 執行期值）。名稱自動產生為 `KIND+index`（AOM0、MIRROR1；kind 為 none → NONE0）。

- **dynamic_sources** = 整個 instance 的執行期值。存放 Asset 標記為可調（`Asset3D.tunable_params`，migration 0113）的參數值，把光學耦合到電子/RF/雷射狀態（laser power/wavelength、rf_source channels、aom RF）。anchor loader 把這個 dict 摺在 asset default_params 之上送進 trace，但**只有 tunable 的 key 生效**——loader 會丟掉「是 defaultParams key 但非 tunable」的殘留值，所以 non-tunable 參數永遠跟著 Asset（見 [data-model.md](data-model.md) 的 tunable 契約）。
- 舊的 per-binding `param_overrides`（可逐實例覆寫**任一** intrinsic 係數）已於 migration 0113 移除——intrinsic 係數現純由 Asset 決定。

> Lab pose 的座標慣例與變換鏈見 [anchors.md](anchors.md)；`effective` / `dynamic` 參數合併公式見 [data-model.md](data-model.md)。
