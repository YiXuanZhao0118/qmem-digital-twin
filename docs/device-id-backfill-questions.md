# device_id 補齊 — **已完成**（保留為紀錄）

> 第 1–6 次 2026-09-03 ~ 09-08 早上只出清單沒動 DB；**第 7 次 2026-09-08 補齊完成**（scheduled task「device」）。
> 你在 09-08 15:10 填了答案（**Q0 = yes**），當天寫入完畢：`device_id IS NULL` 從 9 降到 2，剩下的 2 筆是 Q2 拍板永久留 NULL 的 annotation。
> **所有題目都已執行完畢**（含 Q4b 刪除孤兒 device `mm_pc_780`）。
> **第 8 次 2026-09-09 複查：狀態不變，沒有新缺口，且最後一項 ⚠️ 也在本次用查詢關掉了**（見下一節）。
> **第 9 次 2026-09-10 ~ 第 22 次 2026-09-23 複查：同樣無事可補**（見下一節）。**這份文件已無待辦，不需要你回答任何東西。**
> 相關規則：[CLAUDE.md 的 locked rows 條款](../CLAUDE.md)、[docs/introduce/asset.md](introduce/asset.md)、[docs/introduce/kinds.md](introduce/kinds.md)。

---

## 第 22 次（2026-09-23）複查：**與第 21 次相同，無事可補**

直接對 DB 查（`localhost:55432/qmem_twin`，唯讀）＋ API（`/api/v3/assets3d`、`/api/devices`）交叉核對：

| 檢查 | 結果 |
|---|---|
| `assets_3d.device_id` NULL 或只有空白 | **2** —— `Rect Annotation`（`rect_annotation`, primitive, locked）/ `Text Annotation`（`text_annotation`, primitive, locked），Q2 拍板永久 NULL |
| 懸空 `device_id`（指不到 `devices.slug`） | **0** |
| 一個 device 被兩個以上 asset 共用 | **0** |
| 孤兒 device | **3** —— `dg4202` / `horn_wr90` / `rg316_sma`（刻意留） |
| 總數 | asset **64**、device **65**、`locked` asset **60** |
| alembic head | **`0140_isolator_kind_row`**（上次是 `0139`；0140 只補 `isolator` kind 列，與 device 無關） |
| 最新 asset / device | `02BCF-4(M)`（2026-08-26）/ `sm_apc_30126a9`（2026-09-08）—— 之後沒有新列 |

`information_schema.columns`：整個 schema 裡帶 device 字樣的欄位仍然只有 **`assets_3d.device_id`** 一處。

**本次不寫 DB、不新增提問。**

---

## 第 21 次（2026-09-22）複查：**與第 20 次相同，無事可補**

透過 API（`/api/v3/assets3d`、`/api/devices`）查：`device_id` NULL 仍只有 2 筆 annotation（`rect_annotation` / `text_annotation`，Q2 拍板永久 NULL）；空白偽 NULL 0、懸空 0、共用 0；孤兒 3（`dg4202` / `horn_wr90` / `rg316_sma`）；asset 64 / device 65 / locked 60；最新 device 仍是 2026-09-08。**不寫 DB、不新增提問。**

---

## 第 20 次（2026-09-21）複查：**與第 19 次相同，無事可補**

直接對 DB 查（`localhost:55432/qmem_twin`，Postgres 與 backend :8010 本次開始時都已在運行，只做唯讀查詢）：

| 檢查 | 結果 |
|---|---|
| `assets_3d.device_id IS NULL` | **2** —— `Rect Annotation`（`rect_annotation`, primitive, locked, 2026-08-19）/ `Text Annotation`（`text_annotation`, primitive, locked, 2026-08-14），Q2 拍板永久 NULL |
| `device_id` 只有空白字元（空字串偽 NULL） | **0** |
| 懸空 `device_id`（指到不存在的 `devices.slug`） | **0** |
| 一個 device 被兩個以上 asset 共用 | **0** |
| 孤兒 device | **3** —— `dg4202` / `horn_wr90` / `rg316_sma`（刻意留） |
| 總數 | asset **64**、device **65**、`locked` asset **60** |
| alembic head | `0139_drop_device_state_power` |
| 最新 asset / device | `02BCF-4(M)`（2026-08-26，`device_id = 02bcf_4_m`）/ 2026-09-08 —— 之後沒有新列 |

`information_schema.columns`：整個 schema 裡帶 device 字樣的欄位仍然只有 **`assets_3d.device_id`** 一處。

**本次不寫 DB、不新增提問。**

---

## 第 19 次（2026-09-20）複查：**與第 18 次相同，無事可補**

透過 API（`/api/v3/assets3d`、`/api/devices`）查：`device_id` NULL 仍只有 2 筆 annotation（`rect_annotation` / `text_annotation`，Q2 拍板永久 NULL）；懸空 0、共用 0；孤兒 3（`dg4202` / `horn_wr90` / `rg316_sma`）；asset 64 / device 65 / locked 60；最新 device 仍是 2026-09-08。**不寫 DB、不新增提問。**

## 第 18 次（2026-09-19）複查：**與第 17 次相同，無事可補**

透過 API（`/api/v3/assets3d`、`/api/devices`）查：`device_id` NULL 仍只有 2 筆 annotation；懸空 0、共用 0；孤兒 3（`dg4202` / `horn_wr90` / `rg316_sma`）；asset 64 / device 65 / locked 60；最新 device 仍是 2026-09-08。**不寫 DB、不新增提問。**

## 第 17 次（2026-09-18）複查：**無事可補，與第 8–16 次逐項相同**

直接對 DB 查（`localhost:55432/qmem_twin`）：

| 檢查 | 結果 |
|---|---|
| `assets_3d.device_id IS NULL` | **2** —— `Text Annotation` / `Rect Annotation`（皆 `primitive`、`locked`），Q2 拍板永久 NULL |
| `device_id` 只有空白字元（空字串偽 NULL） | **0** |
| 懸空 `device_id`（指到不存在的 `devices.slug`） | **0** |
| 一個 device 被兩個以上 asset 共用 | **0** |
| 孤兒 device | **3** —— `dg4202` / `horn_wr90` / `rg316_sma`（`primitive://` mesh，刻意留） |
| 總數 | asset **64**、device **65**、`locked` asset **60** |
| alembic head | `0139_drop_device_state_power` |
| 最新 asset / device | `02BCF-4(M)`（2026-08-26）/ `ch1a_down`、`sm_apc_30126a9`、`pda36a`（2026-09-08）—— 之後沒有新列 |

`information_schema.columns`：帶 device 字樣的欄位仍然只有 **`assets_3d.device_id`**。

**本次不寫 DB、不新增提問。**

> 註：Postgres（:55432）本次開始時是**停的**（與 09-12 同一個症頭），用 `pg_ctl -D .local-postgres/data ... -w start` 起來後只做唯讀查詢。`pg_ctl.exe` 在 `C:/Program Files/PostgreSQL/18/bin/`，`.local-postgres/` 底下只有 `data/` 沒有 binary。

---

## 第 16 次（2026-09-17）複查：**無事可補，與第 8–15 次逐項相同**

直接對 DB 查（`localhost:55432/qmem_twin`）：

| 檢查 | 結果 |
|---|---|
| `assets_3d.device_id IS NULL` | **2** —— `Text Annotation`（2026-08-14）/ `Rect Annotation`（2026-08-19），Q2 拍板永久 NULL |
| `device_id` 只有空白字元（空字串偽 NULL） | **0** |
| 懸空 `device_id`（指到不存在的 `devices.slug`） | **0** |
| 一個 device 被兩個以上 asset 共用 | **0** |
| 孤兒 device | **3** —— `dg4202` / `horn_wr90` / `rg316_sma`（刻意留） |
| 總數 | asset **64**、device **65**、`locked` asset **60** |
| alembic head | `0139_drop_device_state_power` = 磁碟上最後一支 migration |
| 最新 asset / device | `02BCF-4(M)`（2026-08-26）/ `sm_apc_30126a9`、`pda36a`（2026-09-08）—— 之後沒有新列 |

`information_schema.columns`：帶 device 字樣的欄位仍然只有 **`assets_3d.device_id`**。

**本次不寫 DB、不新增提問。**

> 註：Postgres（:55432）本次開始時已在運行，backend :8010 沒在跑，沒去起。只做唯讀查詢。

---

## 第 15 次（2026-09-16）複查：**無事可補，與第 8–14 次逐項相同**

直接對 DB 查（`localhost:55432/qmem_twin`）：

| 檢查 | 結果 |
|---|---|
| `assets_3d.device_id IS NULL` | **2** —— `Text Annotation`（primitive, 2026-08-14）/ `Rect Annotation`（primitive, 2026-08-19），Q2 拍板永久 NULL |
| `device_id` 只有空白字元（空字串偽 NULL） | **0** |
| 懸空 `device_id`（指到不存在的 `devices.slug`） | **0** |
| 一個 device 被兩個以上 asset 共用 | **0** |
| 孤兒 device | **3** —— `dg4202` / `horn_wr90` / `rg316_sma`（刻意留） |
| 總數 | asset **64**、device **65**、`locked` asset **60** |
| alembic head | `0139_drop_device_state_power` = 磁碟上最後一支 migration，沒有未 upgrade 的隱藏缺口 |
| 最新 asset | 2026-08-26 —— 之後沒有新列 |

`information_schema.columns` 再查一次：整個 schema 裡帶 device 字樣的欄位仍然只有 **`assets_3d.device_id`** 一處。

**本次不寫 DB、不新增提問。**

> 註：Postgres（:55432）本次開始時已在運行（上次複查留下的），backend :8010 / frontend :5173 沒在跑，也沒去起。只做唯讀查詢。

---

## 第 14 次（2026-09-15）複查：**無事可補，與第 8–13 次逐項相同**

直接對 DB 查（`localhost:55432/qmem_twin`）：

| 檢查 | 結果 |
|---|---|
| `assets_3d.device_id IS NULL` | **2** —— `rect_annotation_frame`（2026-08-19）/ `text_annotation_label`（2026-08-14），Q2 拍板永久 NULL |
| `device_id` 只有空白字元（空字串偽 NULL） | **0** |
| 懸空 `device_id`（指到不存在的 `devices.slug`） | **0** |
| 一個 device 被兩個以上 asset 共用 | **0** |
| 孤兒 device | **3** —— `dg4202` / `horn_wr90` / `rg316_sma`（刻意留） |
| 總數 | asset **64**、device **65**、`locked` asset **60** |
| alembic head | `0139_drop_device_state_power` = 磁碟上最後一支 migration，沒有未 upgrade 的隱藏缺口 |
| 最新 asset / device | `02bcf_4_m`（2026-08-26）/ `sm_apc_30126a9`、`pda36a`（2026-09-08）—— 之後沒有新列 |

`information_schema.columns` 再查一次：整個 schema 裡帶 device 字樣的欄位仍然只有 **`assets_3d.device_id`** 一處。

**本次不寫 DB、不新增提問。**

> 註：本次開始時 Postgres（:55432）、backend（:8010）、frontend（:5173）都沒在跑。只跑 `scripts/start-local-postgres.ps1` 把 Postgres 單獨叫起來查詢 —— **沒跑 alembic、沒動 `.env`、沒起 backend/frontend**。Postgres 保持運行中。

---

## 第 13 次（2026-09-14）複查：**無事可補，與第 8–12 次逐項相同**

直接對 DB 查（`localhost:55432/qmem_twin`）：

| 檢查 | 結果 |
|---|---|
| `assets_3d.device_id IS NULL` | **2** —— `rect_annotation_frame` / `text_annotation_label`，Q2 拍板永久 NULL |
| `device_id = ''` / 只有空白字元 | **0 / 0** |
| 懸空 `device_id`（指到不存在的 slug） | **0** |
| 一個 device 被兩個以上 asset 共用 | **0** |
| 孤兒 device | **3** —— `dg4202` / `horn_wr90` / `rg316_sma`（刻意留） |
| 總數 | asset **64**、device **65**、`locked` asset **60** |
| alembic head | `0139_drop_device_state_power` = 磁碟上最後一支 migration，沒有未 upgrade 的隱藏缺口 |
| 最新 asset / device | `02bcf_4_m`（2026-08-26）/ `sm_apc_30126a9`、`pda36a`（2026-09-08）—— 之後沒有新列 |

也再查一次 `information_schema.columns`：整個 schema 裡帶 device 字樣的欄位仍然只有 **`assets_3d.device_id`** 一處，`devices` / `components` / `objects` 都沒有第二個會漏掉的 device 外鍵。

**本次不寫 DB、不新增提問。**

> 註：本次開始時 Postgres（:55432）是停的（backend :8010 / frontend :5173 也都沒在跑）。我只跑 `scripts/start-local-postgres.ps1` 把 Postgres 單獨叫起來查詢 —— **沒跑 alembic、沒動 `.env`、沒起 backend/frontend**。`pg_ctl` 有印 `another server might be running`（殘留的 `postmaster.pid`），但隨即 `server started` 且 crash recovery 乾淨。Postgres 保持運行中。

---

## 第 12 次（2026-09-13）複查：**無事可補，與第 8–11 次逐項相同**

直接對 DB 查（`localhost:55432/qmem_twin`）：

| 檢查 | 結果 |
|---|---|
| `assets_3d.device_id IS NULL` | **2** —— `rect_annotation_frame`（2026-08-19）/ `text_annotation_label`（2026-08-14），Q2 拍板永久 NULL |
| `device_id = ''` / 懸空 slug / 一 device 多 asset | **0 / 0 / 0** |
| 孤兒 device | **3** —— `dg4202` / `horn_wr90` / `rg316_sma`（刻意留） |
| 總數 | asset **64**、device **65**、`locked` asset **60** |
| alembic head | `0139_drop_device_state_power` = 磁碟上最後一支 migration（`0139_drop_device_state_power.py`），沒有未 upgrade 的隱藏缺口 |
| 最新 asset / device | `02bcf_4_m`（08-26）/ `ch1a_down`、`sm_apc_30126a9`、`pda36a`（09-08）—— 之後沒有新列 |

另再確認一次：整個 schema 裡帶 `device` 字樣的欄位只有 `assets_3d.device_id`（`information_schema.columns` 查詢），`devices` / `components` / `objects` 都沒有第二處會漏的 device 外鍵。

**本次不寫 DB、不新增提問。** 本次 Postgres 開機即在運行，未動 `pg_ctl`、未跑 alembic。

---

## 第 11 次（2026-09-12）複查：**無事可補，與第 8–10 次逐項相同**

| 檢查 | 結果 |
|---|---|
| `device_id IS NULL` | **2** —— `rect_annotation_frame` / `text_annotation_label`（Q2 永久 NULL） |
| `device_id = ''` / 懸空 slug / 一 device 多 asset | **0 / 0 / 0** |
| 孤兒 device | **3** —— `dg4202` / `horn_wr90` / `rg316_sma`（刻意留） |
| 總數 | asset **64**、device **65**、`locked` **60**；head `0139` = 磁碟最新 migration |
| 最新 asset / device | `02bcf_4_m`（08-26）/ `sm_apc_30126a9`（09-08）—— 之後沒有新列 |

**本次不寫 DB、不新增提問。**

> ⚠️ **本次開始時 Postgres（:55432）是停的**：log 顯示 09-11 12:34 有個 client 被 Ctrl-C（`0xC000013A`）中斷，postmaster 跟著重置後就沒再起來，`postmaster.pid` 留下已死的 PID 2464（當時 backend :8010 / frontend :5173 仍在跑，但連不到 DB）。我只用 `pg_ctl start` 單獨把 Postgres 叫起來 —— **沒跑 alembic、沒動 `.env`**；crash recovery 乾淨（redo 只有幾百 byte，`database system is ready`）。Postgres 保持運行中。

---

## 第 10 次（2026-09-11）複查：**無事可補，與第 8、9 次逐項相同**

直接對 DB 查（`localhost:55432/qmem_twin`，alembic head 仍是 `0139_drop_device_state_power`）：

| 檢查 | 結果 | 與 09-10 相比 |
|---|---|---|
| `assets_3d.device_id IS NULL` | **2** —— `rect_annotation_frame` / `text_annotation_label`（Q2 拍板永久 NULL） | 不變 |
| `device_id = ''`（空字串偽 NULL） | **0** | 不變 |
| 懸空 `device_id`（指到不存在的 slug） | **0** | 不變 |
| 一個 device 被兩個以上 asset 共用 | **0** | 不變 |
| 孤兒 device | **3** —— `dg4202` / `horn_wr90` / `rg316_sma`，刻意留著 | 不變 |
| 總數 | asset **64**、device **65**、`locked` asset **60** | 不變 |
| 最新一筆 asset / device | asset `02bcf_4_m`（2026-08-26）、device `sm_apc_30126a9`（2026-09-08，即第 7 次寫入） | 不變 |

**自第 7 次寫入以來仍然沒有任何新資產進來，所以不可能有新的 NULL。本次不寫 DB、不新增提問。**

本次多做了一項確認：**DB 的 alembic head 等於磁碟上的最新 migration**（`backend/alembic/versions/` 最後一支就是 `0139_drop_device_state_power.py`），所以沒有「還沒 upgrade、跑完會冒出新 asset/device」的隱藏缺口。`device_id` 欄位也再次確認只存在於 `assets_3d`（`information_schema` 查詢），`devices` / `components` / `objects` 都沒有。

> 註：本表的 asset 識別鍵在 DB 裡的欄名是 **`assets_3d.catalog_id`**（不是 `key`）；`assets_3d` 沒有 `key` 欄，拿 `key` 去查會直接噴 `column "key" does not exist`。

---

## 第 9 次（2026-09-10）複查：**無事可補，與第 8 次逐項相同**

直接對 DB 查（`localhost:55432/qmem_twin`，alembic head 仍是 `0139_drop_device_state_power`）：

| 檢查 | 結果 | 與 09-09 相比 |
|---|---|---|
| `assets_3d.device_id IS NULL` | **2** —— `rect_annotation_frame` / `text_annotation_label`（Q2 拍板永久 NULL） | 不變 |
| `device_id = ''`（空字串偽 NULL） | **0** | 本次新加的檢查，乾淨 |
| 懸空 `device_id`（指到不存在的 slug） | **0** | 不變 |
| 一個 device 被兩個以上 asset 共用 | **0** | 不變 |
| 孤兒 device | **3** —— `dg4202` / `horn_wr90` / `rg316_sma`，刻意留著 | 不變 |
| 總數 | asset **64**、device **65**、`locked` asset **60** | 不變 |
| 最新一筆 asset / device | asset `02bcf_4_m`（2026-08-26）、device `sm_apc_30126a9`（2026-09-08，即第 7 次寫入） | 之後沒有新列 |

**自第 7 次寫入以來沒有任何新資產進來，所以也不可能有新的 NULL。本次不寫 DB、不新增提問。**

> 另確認 `device_id` 這個欄位在整個 schema 裡**只存在於 `assets_3d`**（`information_schema` 查詢 + `backend/app/models/hardware.py:89`），`devices` / `components` / `objects` 都沒有同名欄位 —— 所以「DeviceID 為 None」的搜尋範圍就是上表第一列，沒有漏掉別的表。

---

## 第 8 次（2026-09-09）複查：**無事可補**

直接對 DB 查（`localhost:55432/qmem_twin`，alembic head `0139_drop_device_state_power`）：

| 檢查 | 結果 |
|---|---|
| `assets_3d.device_id IS NULL` | **2** —— 只有 `rect_annotation_frame` / `text_annotation_label`，即 Q2 拍板永久留 NULL 的兩筆 |
| 懸空 `device_id`（指到不存在的 device slug） | **0** |
| 一個 device 被兩個以上 asset 共用 | **0** |
| 孤兒 device（沒有 asset 指過來） | **3** —— `dg4202` / `horn_wr90` / `rg316_sma`，與 09-08 相同，`mesh` 都是 `primitive://…`，刻意留著 |
| 總數 | asset **64**、device **65**、`locked` asset **60**（與 09-08 寫入後完全一致） |

**沒有新增的 NULL，也沒有新的不確定項目 → 本次不寫 DB、不新增提問。**

> 註：`assets_3d.device_id` 是 **text 欄存 device 的 `slug`**，不是 `devices.id` 這個 uuid。用 `a.device_id = d.id` 去 join 會直接噴 `operator does not exist: text = uuid`，要 join `d.slug`。

### ⚠️ 已關閉：EOM pigtail 接頭配對

第 7 次留下的唯一待辦是「去 Lab 開一次 EOSpace EOM 那條光路，確認 `30126a9_step` 從 `fc_pc_male` 改成 `fc_apc_male` 後接頭還配得上」。**本次用查詢就確認了：那個改動不可能弄壞任何配對，因為現在場景裡根本沒有任何光纖連線。**

| 查詢 | 結果 |
|---|---|
| `objects.properties ? 'fiberEndpoints'` | **0 筆**（現有的 property key 只有 `rfCableEndpoints` / `rfCableNodes` / `bindingFiberNodes` / `alignReverse` / `alignRollDeg` / `emissionVisuals` / `hiddenBindings` / `placedRelativeTo` / `ppgAttachment`） |
| `optical_links` | **0 列** |
| `element_kind = 'fiber'` 的 `physics_elements` | **0 列**（42 個 PE 裡沒有任何 fiber；`eom` 只有 1 個，EOM0） |

也就是說 `30126a9_step` 在 `Opt EOM EOSpace 20GHz` 底下**純粹是 render-only 的 sub-component**（2 筆 `component_bindings`），沒有 `fiberEndpoints` 連到它、也沒有 synthesized fiber slot 靠它算耦合 —— 符合 CLAUDE.md「`fiber_connector` sub-component under a device is render-only and couples nothing」。**接頭性別改動對 trace 零影響，這項待辦解除。**

（往後若真的拉一條 patch cable 進 EOM，屆時要配的是 **APC 母座**；`sm_apc_780` / `pm_apc_780` 的 `fiber_out` 同為 `fc_apc_male`，而現有唯二的母座 `rxm15ef_step.fiber_in` / `fiber_checker.fiber_in` 都是 `fc_pc_female` —— 配不上 APC 公頭。這是**未來要接線時**才需要處理的設計問題，不是現在的資料缺口。）

### 仍未修的文件漂移（第 4 次回報）

`CLAUDE.md` 仍寫「Alembic head：`0137_laser_source_fiber_bulkhead`」，DB 實際在 **`0139_drop_device_state_power`**；`0138_kind_deletions` / `0139` 的說明既沒進 `CLAUDE.md` 也沒進 [docs/introduce/migrations.md](introduce/migrations.md)。**這不在本任務範圍，需要你授權我單獨補一次。**

---

## ✅ 你的答案（2026-09-08 收到，已據此執行）

```
Q0.  授權 unlock → 寫 device_id → relock             → yes
Q1c. er1_step 的 kind 改成 mechanical                → 改
Q2.  rect_annotation_frame 永久留 NULL               → 留 NULL
Q3a. PDA36A 增益檔                                   → 30 dB
Q3b. conversionGainVPerW 取哪一欄                    → 50 Ω
Q3c. wavelengthRangeNm                               → 改成 350–1100
Q3d. rf_out 加 connectorType "bnc_female"            → 加
Q4.  30126a9_step                                    → (a) 建對的 device 並把參數改成 APC
Q4b. 孤兒 device mm_pc_780                           → 刪
```

Q3e（slug / display_name）你沒填，依文件約定照提議走：slug `pda36a`。
Q3f（把增益檔做成 tunable_params）你沒填，視為「現在不用」，未執行。

---

## 第 7 次（2026-09-08）執行結果：**補齊完成**

| 項目 | 狀態 |
|---|---|
| 建立 7 個 device 列 | ✅ 完成（`devices` 59 → **66**） |
| 把 7 個 asset 的 `device_id` 指過去 | ✅ 完成（由你手動跑 `wire_remaining_device_ids.py --apply`） |
| `device_id IS NULL` 的 asset | **2** —— 只剩 Q2 那兩個 annotation，**符合預期，不再是缺口** |
| 刪除孤兒 device `mm_pc_780` | ✅ 完成（`devices` 66 → **65**，孤兒 4 → 3） |

### 建立的 7 個 device 列

| slug | display_name | behavioral_kind | anchors |
|---|---|---|---|
| `ch1a_down` | Thorlabs CH1A Fixed Cylindrical Lens Mount (lower/fixed arm) | null | 0 |
| `ch1a_up` | Thorlabs CH1A Fixed Cylindrical Lens Mount (upper/sliding arm) | null | 0 |
| `er1` | Thorlabs ER1 Cage Assembly Rod (1", Ø6 mm) | null | 0 |
| `er1_5` | Thorlabs ER1.5 Cage Assembly Rod (1.5", Ø6 mm) | null | 0 |
| `rs2m` | Thorlabs RS2M Ø25.0 mm Post Spacer (2 mm thick) | null | 0 |
| `pda36a` | Thorlabs PDA36A (Si switchable-gain amplified detector, 350–1100 nm) | `detector` | 2（`intercept_in`＋`rf_out`/`bnc_female`） |
| `sm_apc_30126a9` | Thorlabs 30126A9 FC/APC Single Mode Connector (Ø126 µm bore) | `fiber_connector` | 2（`fiber_root`＋`fiber_out`/`fc_apc_male`） |

### 寫入後的驗證（逐項對照寫入前的備份）

- **7 個 asset 全部指到對的 device**，`kind_id` 各自為 `mechanical` ×5、`detector`、`fiber_connector`。
- **鎖全部回到原狀**：`locked = true` 的 asset 仍是 **60** 筆，沒有任何一列被留在 unlocked。
- **anchors 零漂移**：7 筆的 anchor 陣列與寫入前的備份**逐位元組相同**，唯二差異就是刻意加的 `pda36a_step.rf_out.connectorType = bnc_female` 與 `30126a9_step.fiber_out.connectorType = fc_apc_male`。（原封回寫 anchors 就是為了擋掉 device 模板 re-materialize 造成的 Gram-Schmidt 漂移。）
- **`pda36a_step`** → `default_params = {bandwidthHz: 785000, conversionGainVPerW: 11900, nepWPerRtHz: 1.7e-12, responsivityAPerW: 0.5}`、`wavelength_range_nm = [350, 1100]`。
- **`30126a9_step`** → `default_params = {na: 0.13, mfdUm: 5.3, polish: "APC", fiberType: "single_mode", returnLossDb: 60, slowAxisKeyed: false, polishAngleDeg: 8}`。

### ✅ ~~唯一要你自己看一眼的後續~~ —— 2026-09-09 已關閉

Q4 (a) 把 `30126a9_step` 的 `fiber_out` 從 `fc_pc_male` 改成 **`fc_apc_male`**，而它是現役 `Opt EOM EOSpace 20GHz` 兩端 pigtail 的接頭。原本要你去 Lab 開一次那條光路確認配得上 —— **第 8 次複查用查詢確認了不用**：場景裡沒有任何 `fiberEndpoints`／`optical_links`／`fiber` physics element，那兩個接頭是 render-only，配對性無從被弄壞。詳見最上面的第 8 次章節。

### ✅ `mm_pc_780` 已刪除

那列標籤填錯的孤兒 device（`mesh` 寫 `thorlabs_fc_apc_30126a9.stl` 但 display 叫 FC/PC 多模）已由你手動刪除。`DELETE /api/devices/{id}` 被 Claude Code 的 auto-mode 權限閘擋掉，即使 asset 寫入已放行 —— delete 這一類始終擋，所以是你自己跑的。

> PowerShell 的 `curl` 是 `Invoke-WebRequest` 的別名，吃不了 `-X`。要打 REST 動詞得用 `Invoke-RestMethod -Method Delete`，或明寫 `curl.exe`。

刪除後 `devices` 66 → **65**，孤兒（`usage_count = 0`）從 4 降到 **3**：`dg4202` / `horn_wr90` / `rg316_sma`，這三者 mesh 是 `primitive://…` 或未使用，可能是刻意留的程序化 device，不在本任務範圍。

---

## 已定案的決定（保留紀錄，不用再回答）

- **Q1c** → `er1_step` 的 `kind_id` 由 `unclassified` 改為 `mechanical`（✅ 已寫入）。
- **Q2** → `rect_annotation_frame` 比照 `text_annotation_label` **永久留 NULL**，兩筆自此不再列入待補清單。
- **Q3** → PDA36A 取 **30 dB / 50 Ω** 檔：`bandwidthHz = 7.85e5`、`nepWPerRtHz = 1.7e-12`、`responsivityAPerW = 0.5`、`conversionGainVPerW = 11900`；`wavelengthRangeNm` 欄改 **[350, 1100]**；`rf_out` 加 `connectorType: "bnc_female"`。
- **Q4 (a)** → `30126a9_step` 的參數改成料號的真實規格：`polish: "APC"`、`polishAngleDeg: 8`、`returnLossDb: 60`，anchor `fiber_out.connectorType` 由 `fc_pc_male` → **`fc_apc_male`**。
  ⚠️ 這會改到現役 EOSpace EOM pigtail 的配對性（PC 頭配不上 APC 座）—— 你選了 (a) 即為確認。**已寫入，請在 Lab 開一次那條光路確認接頭仍然接得上。**
- **Q3f** 視為「現在不用」。**Q1a / Q1b / Q3e** 早已關閉。

下面保留當初的查證過程與證據，供日後回溯；**不需要再回答任何一題**。

---

### 第 4 次（2026-09-06）做的事：用 component binding 反查，把 Q1-b 徹底關掉

前一版說 CH1A「查不到料號、疑似自製件」——**那是錯的，CH1A 是真的 Thorlabs 料號。**

我改從「誰在用它」下手，查 `component_bindings`，結果非常明確：

| component（kind `lens_cylindrical`） | 綁的 lens asset | 也綁了 |
|---|---|---|
| Opt CL 20.01 H15×L30 | `lj1328l2_b_step` | `ch1a_up_step` + `ch1a_down_step` |
| Opt CL 150.00 H20×L22 | `lj1934l1_b_step` | `ch1a_up_step` + `ch1a_down_step` |
| Opt CL 40.00 H10×L12 | `lj1402l1_b_step` | `ch1a_up_step` + `ch1a_down_step` |
| Opt CL −24.88 H10×L12 | `lk1426l1_b_step` | `ch1a_up_step` + `ch1a_down_step` |
| Opt CL -25.39 H16xL18 | `lk1900l1_b_step` | `ch1a_up_step` + `ch1a_down_step` |

**5 顆 Thorlabs 柱面鏡，每一顆都配一組 CH1A 上臂＋下臂。** 拿這個線索去查，原廠頁一次就中：

> **Thorlabs CH1A — Fixed Cylindrical Lens Mount, Max Optic Height: 1.60" (40.6 mm)**
> 由**兩支臂**組成，用**兩根 ER 籠桿**串起來；**上臂**沿籠桿滑動、以兩顆 4-40 頂絲鎖定，**下臂**固定不動並帶 #8 (M4) 沉孔可鎖 Ø1/2" 支柱。兩臂各襯 20.0 mm 長橡膠墊保護光學件。

和我們的資料全部對得起來：

| 證據 | 吻合情形 |
|---|---|
| 兩件式、命名 up / down | ✅ 正是「上臂（滑動）／下臂（固定）」 |
| 實測同寬 42.42 mm | ✅ 同一組件的兩支臂 |
| `ch1a_up` 僅 6.22 mm 厚、`ch1a_down` 高 58.42 mm | ✅ 上臂是薄夾臂；下臂含 M4 沉孔柱座故較高 |
| 只被 `lens_cylindrical` component 使用 | ✅ 就是柱面鏡夾持座 |
| 夾的光學件高 10–20 mm | ✅ 遠低於 CH1A 上限 40.6 mm |
| **同批資產裡有 `er1_step` / `er1_5_step`（ER 籠桿）** | ✅ CH1A 靠 ER 籠桿串接，這批機械件本來就是一套 |

最後一列順帶解釋了為什麼 ER1 / ER1.5 會和 CH1A 一起出現在這份清單裡——它們是同一組夾具的零件。

> 備註：GLB 內嵌名稱仍是空的（`THREE.GLTFExporter r170` 重輸出時清掉了），`properties.sourceFilename` 也只是 `ch1a_up_step.glb`，沒有原始零件名。這次是靠 binding 關係而非檔案內容查出來的。

前一版已完成、本次未變動的實測結果（供對照）：

| asset | 實測尺寸 (X×Y×Z mm) | 判定 | 本次追加佐證 |
|---|---|---|---|
| `rs2m_step` | 24.98 × 25.00 × 2.00 | Thorlabs **RS2M** = Ø25.0 mm Post Spacer, 厚 2 mm | ✅ 它綁的 component 就叫 **"Post Spacer 2.0 mm"** |
| `er1_step` | 5.98 × 30.48 × 5.99 | **ER1**：30.48 mm = 1.20"（1" 桿身 + 0.20" 螺柱），Ø6 mm | ✅ component 叫 **"Cage Rod 1 inch"** |
| `er1_5_step` | 5.99 × 43.18 × 5.99 | **ER1.5**：43.18 mm = 1.70"，Ø6 mm | ✅ component 叫 **"Cage Rod 1.5 inch"** |
| `ch1a_up_step` | 42.42 × 11.30 × 6.22 | **CH1A 上夾臂**（滑動臂） | ✅ 見上表 |
| `ch1a_down_step` | 42.42 × 15.82 × 58.42 | **CH1A 下夾臂**（固定臂＋柱座） | ✅ 見上表 |

**結論：Q1 的 5 筆現在規格與命名全部查證完畢，零猜測，只差 Q0 一句授權。**

---

## Q1 — 5 個純機械件（提議：照先例直接建殼、補上）

這 5 筆 `anchors=[]`、`default_params={}`，和已經有 device 的 `cp33_m` / `crm1t` / `ks1t` / `rs1p` / `s1tm08` / `pm100d2` 一模一樣（那 6 個 device 列也都是 `anchors=[] default_params={} behavioral_kind=NULL component_type=mechanical`）。slug = catalog_id 去掉 `_step`，mesh = file_path 的檔名。

| asset `catalog_id` | asset name | kind_id | 提議 device slug | 提議 display_name | 提議 mesh |
|---|---|---|---|---|---|
| `ch1a_down_step` | CH1A-down-Step | mechanical | `ch1a_down` | Thorlabs CH1A Fixed Cylindrical Lens Mount (lower/fixed arm) | `ch1a_down_step.glb` |
| `ch1a_up_step` | CH1A-up-Step | mechanical | `ch1a_up` | Thorlabs CH1A Fixed Cylindrical Lens Mount (upper/sliding arm) | `ch1a_up_step.glb` |
| `er1_5_step` | ER1.5-Step | mechanical | `er1_5` | Thorlabs ER1.5 Cage Assembly Rod (1.5", Ø6 mm) | `er1_5_step.glb` |
| `er1_step` | ER1-Step | **unclassified** | `er1` | Thorlabs ER1 Cage Assembly Rod (1", Ø6 mm) | `er1_step.glb` |
| `rs2m_step` | RS2M-Step | mechanical | `rs2m` | Thorlabs RS2M Ø25.0 mm Post Spacer (2 mm thick) | `rs2m_step.glb` |

這三筆的規格已在 2026-09-05 用**網格實測 + 原廠目錄**雙重確認（見上面的實測表），display_name 已改正：**RS2M 是 Ø25.0 mm 、厚 2 mm 的墊片**，不是上一版寫的「2" pedestal post spacer」。ER1 / ER1.5 的實測長度 30.48 / 43.18 mm 分別符合 1.20" / 1.70"（1" / 1.5" 桿身加 0.20" 螺柱）。

**Q1-a：授權我對這 5 筆 locked asset 做 unlock → 寫 device_id → relock 嗎？** → **已並入最上面的 Q0**，這裡不用再填。

**Q1-b：`ch1a_up` / `ch1a_down` 這兩個怎麼命名？** → ✅ **2026-09-06 已查明，不需要你回答。**

CH1A 是真的 Thorlabs 料號：**CH1A Fixed Cylindrical Lens Mount**（Max Optic Height 1.60" / 40.6 mm），兩支臂用 ER 籠桿串接，上臂滑動、下臂固定並帶 M4 沉孔柱座。查證過程與六項吻合證據見上方「本次新做的事」。上表的 display_name 已據此填好。

> 這也推翻了前一版「疑似自製件」的判斷 —— 當時只查了 GLB 內嵌名稱（已被清空），沒有從 component binding 反查。

**Q1-c：`er1_step` 的 `kind_id` 目前是 `unclassified`，其他 ER/RS 機械件都是 `mechanical`。要順手改成 `mechanical` 嗎？**
（先例 `pm100d2_step` 也是 `unclassified` 且沒被改，所以我不擅自動。`behavioral_kind=NULL` 不會 write-through，這欄要改就得明寫。）
→ 答（2026-09-08）：**改成 mechanical**。

---

## Q2 — 2 個 annotation 資產（提議：永久維持 NULL）

| asset | kind_id | 說明 |
|---|---|---|
| `text_annotation_label` | `text_annotation` | `primitive://text_annotation`，alembic 0119 |
| `rect_annotation_frame` | `rect_annotation` | `primitive://rect_annotation`，alembic 0124 |

`text_annotation_label` **你 2026-08-18 已經拍板不給 device**（理由：`file_path` 是 `primitive://…`，不是 asset store 裡的 mesh），所以我不會再動它。`rect_annotation_frame` 是 0124/0125 之後才出現的同型資產，照同一條理由也該留 NULL，但沒有你的明示紀錄。

**Q2：確認 `rect_annotation_frame` 比照 `text_annotation_label` 永久留 NULL 嗎？**（確認後這兩筆就從往後的檢查清單移除，不再回報）
→ 答（2026-09-08）：**留 NULL**。這兩筆自此不再列入待補清單。

---

## Q3 — `pda36a_step`（detector）— **規格已查齊，只剩挑一列**

目前 asset 的 `default_params` 是佔位值：`{"responsivityAPerW": 0.5, "bandwidthHz": 0, "nepWPerRtHz": 0, "conversionGainVPerW": 0}`。

PDA36A 是**八段可切換增益**（0–70 dB，10 dB 一階）的 Si 放大型偵測器，所以頻寬 / 轉換增益隨檔位變 —— 一組 `default_params` 只能代表一個檔位。原廠手冊（13053-S01 Rev E）完整規格如下，`responsivityAPerW` 在 780 nm 取 **0.5**（峰值 0.65 A/W @ 970 nm；目前 asset 上那個 0.5 剛好是對的）：

| 檔位 | Gain (Hi-Z) V/A | Gain (50 Ω) V/A | Bandwidth Hz | NEP W/√Hz | **conversionGainVPerW**（Hi-Z，×0.5 A/W） | （50 Ω） |
|---|---|---|---|---|---|---|
| 0 dB | 1.51e3 | 0.75e3 | 1.7e7 | 7.7e-11 | 755 | 375 |
| 10 dB | 4.75e3 | 2.38e3 | 1.25e7 | 1.4e-11 | 2375 | 1190 |
| 20 dB | 1.5e4 | 0.75e4 | 2.1e6 | 3e-12 | 7500 | 3750 |
| **30 dB** ← 提議預設 | 4.75e4 | 2.38e4 | 7.85e5 | 1.7e-12 | **23750** | 11900 |
| 40 dB | 1.51e5 | 0.75e5 | 3.2e5 | 1.9e-12 | 75500 | 37500 |
| 50 dB | 4.75e5 | 2.38e5 | 1.0e5 | 2.2e-12 | 237500 | 119000 |
| 60 dB | 1.5e6 | 0.75e6 | 3.75e4 | 1.7e-12 | 750000 | 375000 |
| 70 dB | 4.75e6 | 2.38e6 | 1.25e4 | 2.1e-12 | 2375000 | 1190000 |

其他已確認：波長範圍 **350–1100 nm**（asset 目前寫 400–1100，偏窄）、active area 3.6×3.6 mm (13 mm²)、**輸出接頭是 BNC**。

asset 已有兩個 anchor，可直接當 device 樣板（round-trip 無損）：

- `intercept_in`：pos ≈ (0.0012, 11.4307, 18.1811) mm，axisX = +Z，aperture 1.0 mm circle
- `rf_out`：pos ≈ (5.0812, −31.6693, 11.4501) mm，axisX = −Y，aperture 1.0 mm circle

**Q3-a：用哪一檔？** → 答（2026-09-08）：**30 dB**。

**Q3-b：`conversionGainVPerW` 取 Hi-Z 還是 50 Ω 那一欄？**
先例 `rxm15ef` 寫 `-200.0`（負號＝反相，且是 50 Ω 規格）。PDA36A 輸出非反相，所以取正值；但阻抗慣例要你定。若量測端是示波器 1 MΩ 就用 Hi-Z，50 Ω 終端就用 50 Ω 欄（差一倍）。
→ 答（2026-09-08）：**50 Ω** → `conversionGainVPerW = 11900`。

**Q3-c：`wavelengthRangeNm` 要不要從 asset 現值 400–1100 改成原廠的 350–1100？**
→ 答（2026-09-08）：**改成 350–1100**。

**Q3-d：`rf_out` 的 connector 確認是 BNC female（手冊寫 Output: BNC）。device anchor 要加 `connector_type: "bnc_female"` 嗎？現在 asset 上沒有。**
→ 答（2026-09-08）：**加**（device 與 asset 的 `rf_out` 都加，兩邊保持一致）。

**Q3-e：device slug 用 `pda36a`、display_name 用「Thorlabs PDA36A (Si switchable-gain amplified detector, 350–1100 nm)」可以嗎？**（授權部分已並入 Q0）
→ 未回答 → 依約定照提議走：slug `pda36a`（device 已於 2026-09-08 建立）。

**Q3-f（延伸，可跳過）：既然增益是旋鈕可切的，`bandwidthHz` / `conversionGainVPerW` 是不是該進 `tunable_params` 讓每個 instance 自己選檔位？** 目前 asset `tunable_params = []`。這超出「補 device_id」範圍，要做我另開。
→ 未回答 → 視為**現在不用**，未執行。

---

## Q4 — `30126a9_step`（fiber_connector）— **身分查明了，但參數對不上**

### 查證結果

| | 原廠 30126A9 | asset `30126a9_step` 現值 |
|---|---|---|
| polish | **APC（8° 斜角）** | `polish: "PC"`、`polishAngleDeg: 0` ❌ |
| return loss | **typ. 60 dB** | `returnLossDb: 40` ❌ |
| 光纖型別 | Single Mode（Ø126 µm bore，吃 125 µm cladding） | `single_mode`, `na: 0.13`, `mfdUm: 5.3` ✓ |
| anchor connectorType | 應為 `fc_apc_male` | `fc_pc_male` ❌ |

也就是說 asset 上的 PC / 0° / 40 dB 三個值，跟料號本身矛盾 —— 看起來是當初抄錯，或從 `sm_pc_780` 複製過來的。

### 它在哪被用

`30126a9_step` **是現役的**：被 `Opt EOM EOSpace 20GHz`（kind `eom`）拿去當**兩端 pigtail 的接頭**（2 筆 `component_bindings`）。EOSpace 20 GHz 調變器的 pigtail 一般是 **PM 光纖 + FC/APC**，這和 asset 寫的 `single_mode` 又對不上（PM 應是 `polarization_maintaining` + `slowAxisKeyed: true`）。alembic 0130 之後 PM 光纖是有偏振行為的，所以這欄不是純標籤。

### `mm_pc_780` 這個孤兒 device 的來歷

它的 `mesh` 欄寫的正是 `thorlabs_fc_apc_30126a9.stl`（檔名裡就有 **apc**），但 display 叫「Fiber Connector FC/PC (MM 50µm)」、`na: 0.22`（多模）、`polishAngleDeg: 0`。**檔名說 APC、欄位說 PC；檔名說 30126A9（單模）、欄位說多模。** 我判斷 `mm_pc_780` 是當初拿 30126A9 的網格建出來、然後標籤填錯的一列，不是真的有一條多模跳線。

### 請選

- [x] **(a) 建一個對的 device，並把 asset 參數修正成 APC** ← **你選這個（2026-09-08）**
      slug `sm_apc_30126a9`，display「Thorlabs 30126A9 FC/APC Single Mode Connector (Ø126 µm bore)」，
      `default_params` = `{na: 0.13, mfdUm: 5.3, polish: "APC", fiberType: "single_mode", returnLossDb: 60, slowAxisKeyed: false, polishAngleDeg: 8}`，
      anchor `fiber_out.connectorType` 由 `fc_pc_male` → **`fc_apc_male`**。
      ⚠️ 這會改到現役 EOM pigtail 的配對性（PC 頭配不上 APC 座），要你確認。
- [ ] **(b) 建 device，但參數原封不動照抄 asset 現值（維持 PC）** —— 明知和料號不符，先求不動到現役場景。slug 提議 `sm_pc_30126a9`。
- [ ] **(c) 指向現有 `sm_apc_780`**（參數幾乎一樣，只差 MFD 5.3 vs 5.0），並統一 MFD 為 ______。
- [ ] **(d) 其實 EOM pigtail 是 PM 的** → 改成 `polarization_maintaining` + `slowAxisKeyed: true`，指向 `pm_apc_780` 或新建。
- [ ] **(e) 其他：______**

**並：授權 unlock→寫→relock 嗎？** → **yes**（見 Q0）。

**Q4-b：孤兒 device `mm_pc_780` 要怎麼處理？**
→ 答（2026-09-08）：**刪掉**。✅ 已刪除（`devices` 66 → 65）。

---

## 附帶發現（不在本任務範圍，只回報）

1. **反向缺口**：原本 4 個 device 沒有任何 asset 指向它 —— `dg4202`、`horn_wr90`、`mm_pc_780`、`rg316_sma`。**2026-09-08 已處理一半**：`mm_pc_780` 依 Q4-b 刪除，剩 `dg4202` / `horn_wr90` / `rg316_sma` 三個，mesh 是 `primitive://…` 或未使用，可能是刻意留的程序化 device，**未動**。要不要清理由你決定。
2. **新 device 列只存在本機 DB。** alembic 0123 之後 `frontend/src/devices/` 已刪除、`backend/data/kinds.json` 也不再有 `devices[]` 區塊，device 只是 DB 列（由 PHY Editor 建）。版控裡唯一的副本是 `0123_devices_seed.json` 這份一次性 seed，所以 0123 之後新增的 device（`fiber_checker`、`02bcf_4_m`、**以及本次新建的 7 列**）**不會跟著 repo 走**，換機器要重建。這次讓問題更明顯了 —— 建議補一支 re-seed migration / 匯出腳本。
3. **文件漂移（第 3 次回報，仍未修）**：`CLAUDE.md` 寫「Alembic head：`0137_laser_source_fiber_bulkhead`」，實際 DB / `backend/alembic/versions/` 已到 **`0139_drop_device_state_power`**（中間還有 `0138_kind_deletions`）。0138/0139 的說明沒進 CLAUDE.md 也沒進 [docs/introduce/migrations.md](introduce/migrations.md)。這違反 CLAUDE.md「code 和 doc 同一次改動一起走」的規則，建議你授權我單獨補一次。

---

### 資料來源（Q3 / Q4 的查證）

- [Thorlabs PDA36A 產品頁](https://www.thorlabs.com/thorproduct.cfm?partnumber=PDA36A)
- [PDA36A Operating Manual 13053-S01 Rev E](https://physics.umd.edu/courses/Phys375/Anlage_Fall2010/ThorLabs_Detector_13053-S01.pdf)（規格表出處）
- [Thorlabs 30126A9 產品頁](https://www.thorlabs.com/thorproduct.cfm?partnumber=30126A9)
- [Thorlabs ER1](https://www.thorlabs.com/item/ER1) / [ER1.5](https://www.thorlabs.com/item/ER1.5)
- [Thorlabs CH1A 產品頁](https://www.thorlabs.com/thorproduct.cfm?partnumber=CH1A) / [Cylindrical Lens Mounts 群組頁](https://www.thorlabs.com/NewGroupPage9_PF.cfm?ObjectGroup_ID=718) — Fixed Cylindrical Lens Mount, Max Optic Height 1.60" (40.6 mm)（2026-09-06 Q1-b 出處）
- [Thorlabs RS2M](https://www.thorlabs.com/thorproduct.cfm?partnumber=RS2M) — Ø25.0 mm Post Spacer, Thickness = 2 mm（2026-09-05 更正來源）
- 網格實測：直接解 GLB 的 `POSITION` accessor min/max（`assets/files/glb/*.glb`），單位 mm
- DB 反查：`component_bindings` ⋈ `components` ⋈ `assets_3d`（2026-09-06 Q1-b 的關鍵線索來源）
