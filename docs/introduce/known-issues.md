[← 文件索引](README.md)

# 已知過時 / 待處理事項

> 死碼/孤兒檔/正名建議另見根目錄 `CLEANUP_AUDIT.md`。

- 後端 port 是 8010（非 8000）；`docker-compose.yml` 的 5432 + adminer 實質未用（走本機 55432 腳本，Docker 未裝）。見 [overview.md](overview.md)。
- 前端 `optical/` TS 光追引擎（face-based）被部分舊文件當成 production，實際線上是後端 anchor 求解器（`anchor_tracer.py`）。見 [optics.md](optics.md)。
- **渲染統一未收尾（2026-06-10）**：`shouldRenderViaBindings` 已恆 `true`、全走 binding-tree，但 fiber/rf_cable/isolator 的 per-instance 狀態（`fiberNodes`/`rfCableNodes`/`radiusMm`/ferrule pose/`translucentHousing`）**尚未透過 binding 樹轉送**，這三類可能暫以 catalog 預設 spline/pose 渲染；legacy `loadAssetObject` 直連分支也成 dead code 待移除。見 [rendering.md](rendering.md)。
- **`physicsCapabilities` 已成 vestigial（2026-06-10）**：domain 改為 asset-kind-authoritative（category 改由 `component.properties.category` 直接決定），UI 已不再讀 `physicsCapabilities` 判 domain/category；DB 欄位與 `setComponentCapabilities` 之外的設定點仍留著，日後可 deprecate。見 [kinds.md](kinds.md)。
- 斷掉的 geometryRef：`thorlabs_io_3_850_faraday_rod.json` 指向不存在的 `files/stl/thorlabs_io_3_850_hp/` 切片子目錄（`split_io_3_hp_stl.py` 可能沒跑或檔案遺失）。
- isolator 的 front/back piece 與 body housing 顏色都寫死 `#1a1a1c`（不走 colorForComponent）；要換色須同改 subset-piece 分支與 `buildThorlabsIsolatorObject`。
- TA 資產 `gainLinear` vs op `smallSignalGainDb` 單位不一致，待統一。見 [optics.md](optics.md)。
- pulse-envelope/色散時域數學在 legacy 退役時被刪（可從 git 復原）。見 [timing.md](timing.md)。
- ~~`test_kinds_manifest` 期待 30 kinds 但實際 `element_kinds` 為 29。~~（已解決：測試與 live 數同步，2026-06-12 加入 `fiber_connector` + `rf_cable_connector` 後為 **31**。）見 [kinds.md](kinds.md)。
- `objects.parent_component_id` model/schema 與 DB 欄位可能不一致；非 emitter 的 chain root（無入射 link 的 mirror）會報「chain root cannot emit」。
- **雷射光束舊資料存在兩處（properties.opticalSources[0].beam + dynamic_sources column）**：兩處都殘留整束光（`spectrum`/`spatialEnvelope`/...）。**migration 0113 後已大幅緩解**：v3 trace 經 `db_scene_loader` 讀這兩處後，會**丟掉「是 defaultParams key 但非 Asset tunable」的 key**（tunable 契約，見 [data-model.md](data-model.md)），所以 non-tunable 的 beam 參數（spectrum/spatialEnvelope/polarization/waist）**永遠跟著 Asset**，不再因殘留資料而 desync；只有 tunable 的 `nominalPowerMw`/`centerWavelengthNm` 是逐實例值。顯示用的 `physics_elements.kindParams`（不落 DB，即時衍生）經 `bindings.get_laser_beam_for_kind_params` 仍優先讀 `dynamic_sources` column，故「顯示」與「trace」對 non-tunable 參數理論上仍可能不一致——但 trace 端已以 Asset 為準。見 [optics.md](optics.md)、auto-memory `laser_beam_dual_source_astigmatism`。
- 死碼/孤兒檔/正名建議：見根目錄 `CLEANUP_AUDIT.md`。
