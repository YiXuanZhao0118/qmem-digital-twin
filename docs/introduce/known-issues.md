[← 文件索引](README.md)

# 已知過時 / 待處理事項

> 死碼/孤兒檔/正名建議另見根目錄 `CLEANUP_AUDIT.md`。

- 後端 port 是 8010（非 8000）；`docker-compose.yml` 的 5432 + adminer 實質未用（走本機 55432 腳本，Docker 未裝）。見 [overview.md](overview.md)。
- 前端 `optical/` TS 光追引擎被部分舊文件當成 production，實際線上是後端 v3 求解器。見 [optics.md](optics.md)。
- 斷掉的 geometryRef：`thorlabs_io_3_850_faraday_rod.json` 指向不存在的 `files/stl/thorlabs_io_3_850_hp/` 切片子目錄（`split_io_3_hp_stl.py` 可能沒跑或檔案遺失）。
- isolator 的 front/back piece 與 body housing 顏色都寫死 `#1a1a1c`（不走 colorForComponent）；要換色須同改 subset-piece 分支與 `buildThorlabsIsolatorObject`。
- TA 資產 `gainLinear` vs op `smallSignalGainDb` 單位不一致，待統一。見 [optics.md](optics.md)。
- pulse-envelope/色散時域數學在 legacy 退役時被刪（可從 git 復原）。見 [timing.md](timing.md)。
- `test_kinds_manifest` 期待 30 kinds 但實際 28。見 [kinds.md](kinds.md)。
- `objects.parent_component_id` model/schema 與 DB 欄位可能不一致；非 emitter 的 chain root（無入射 link 的 mirror）會報「chain root cannot emit」。
- 死碼/孤兒檔/正名建議：見根目錄 `CLEANUP_AUDIT.md`。
