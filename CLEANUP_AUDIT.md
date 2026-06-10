# QMsimulation / qmem-digital-twin — 清理審查報告

> 產生日期：2026-06-01　**這是報告，未變更任何檔案。**
> 範圍：frontend/src、backend(app+alembic)、assets、repo 根目錄。
> 規模：frontend/src 280 檔、backend/app 313 檔、alembic 97 migration、assets 244 檔。

## 重要前提：`.gitignore` 已涵蓋大半「雜訊」

`.gitignore` 已正確忽略，**這些不在版控、不算殘檔、不需處理**：
- `__pycache__/`、`*.pyc`（本機有 1140 個 pycache 目錄 / 9036 個 .pyc，全是本機產物）
- UUID-prefixed 的 CAD 上傳檔（`cad_sources/<uuid>_*.stp/.step`、`stl/<uuid>_*.stl`）
- `assets/agent_uploads/`、`.claude-runtime/`、`.local-postgres/`、uvicorn log

所以下面真正要你決策的，是**有進版控、確實該動的檔**。

---

## A. 可直接刪除（高信心：死碼 / 純 scratch）

### A1. 根目錄 scratch 檔（grep 全 repo 零引用）
| 檔案 | 類型 | 建議 |
|---|---|---|
| `_query_bindings.py` | 一次性 DB 查詢腳本 | 刪 |
| `asset3d-after.png` | debug 截圖 | 刪 |
| `la1540-after-fix.png` | debug 截圖 | 刪 |
| `scene-debug.json` | scene dump（含過時 uploads 路徑） | 刪 |
| `_audit_files.txt` | 檔案清單 dump | 刪 |

### A2. backend 死碼（無任何 importer，未掛載）
| 檔案 | 證據 |
|---|---|
| `backend/app/routers/onshape.py` | 不在 main.py 的 include_router / import tuple；只是 `{"status":"planned"}` stub |
| `backend/app/services/onshape_client.py` | 無 importer，docstring 自述 MVP 外 |
| `backend/app/services/instrument_polling.py` | 無 importer，只匯出一個 mock `fake_poll_device_state` |

### A3. frontend 死碼（plugin registry 已移除）
| 檔案 | 證據 |
|---|---|
| `frontend/src/kinds/fiber_end/index.ts` | `kinds/_plugins.ts:29,93` 註明「fiberEndPlugin removed (Phase 9.X)」 |
| `frontend/src/kinds/isolator/index.ts` | `kinds/_plugins.ts:34,93`「isolatorPlugin removed」。⚠️ 注意：同目錄的 `pbsOverlay.ts` 仍在用，只有 `index.ts` 死掉 |

---

## B. 需你確認後才刪（test-only / 可能還要用）

| 檔案 | 狀況 | 決策點 |
|---|---|---|
| `backend/app/timing_program.py`（單數） | 只有 `tests/test_timing_program.py` 引用；線上走的是 `routers/timing_programs.py`（複數）+ `models/timing.py` | 是要接回線上、還是連同測試一起刪？ |
| `frontend/src/types/units.ts` | 零 importer，純編譯期 brand types | 是預留漸進採用、還是廢案？ |
| `docker-compose.yml` | 只有 docs 提到；定義 port 5432，但實際用 55432 + local-postgres 腳本，且未裝 Docker | 團隊有人用 Docker 路徑嗎？沒有就刪 |

---

## C. 命名正名（當初 v2/v3/實驗名，現在是線上正式碼，建議改名）

> **這些都是線上使用中的檔，不能刪，只是名字誤導。** 改名要連同所有 import 一起改。

### C1. frontend
| 現名 | 被誰 import | 建議新名 |
|---|---|---|
| `components/ComponentsV2Editor.tsx` | `PhyEditor.tsx` | `ComponentsEditor.tsx` |
| `components/Asset3DV3Editor.tsx` | `PhyEditor.tsx` | `Asset3DEditor.tsx` |
| `store/v3CatalogStore.ts` | `Asset3DV3Editor.tsx` | `catalogStore.ts` |
| `utils/v2Bindings.ts` | `AomAdjustControls`、`PhysicsElementPanel`、`rayTrace.ts`、`beamAnchor`、`beamPlacement` | `objectBindings.ts` |
| `three/v3TraceAdapter.ts` | `DigitalTwinViewer.tsx` | 可留——v3 對應真實 API `/api/v3/solver`，改名反而失準 |

### C2. backend
| 現名 | 被誰 import | 建議 |
|---|---|---|
| `app/optical/ray_tracer_v3.py` | db_scene_loader、solver_v3、anchor_tracer、v3_solver | → `ray_tracer.py`（唯一一個，無 v1/v2） |
| `app/optical/solver_v3.py` | v3_solver、simulations、optics_seq | → `solver.py` |
| `app/optical/kinds/aom_v3/` | `kinds/__init__.py` 註冊 `aom` kind | → `aom/`（與其他 kind 命名一致；先確認註冊字串是 `"aom"`） |
| `app/v2_bindings.py` | components、physics_elements、scene、db_scene_loader | → `bindings.py` |
| `app/schemas_v3.py` | v3_catalog、seed_v3_assets | 可併入 `schemas.py` 或留 |
| `app/routers/v3_solver.py`、`v3_catalog.py` | main.py 掛 `/api/v3/...` | ⚠️ URL 是公開 API contract，**route path 別動**；檔名改價值低 |

---

## D. 資產重複 / 佔空間（⚠️ 刪前須查線上 DB）

> 二進位資產可能只被 DB 的 `assets_3d.file_path` 引用，而我看不到線上 DB。
> **刪前先跑：`SELECT file_path FROM assets_3d;` 與磁碟檔比對。**

### D1. 巨大重複 CAD 來源（`cad_sources/` 共 973 MB）
- **4 份完全相同的 `*_ad9959-pcbz.stp`，各 ~232 MB（合計 ~930 MB）** ← 全 repo 最大空間黑洞
- 3 份相同的 `*_io-3-850-hp-step.step`（各 3.28 MB）+ 1 份乾淨命名 `IO-3-850-HP-Step.step`
- 這些 UUID-prefixed 的**已被 .gitignore 忽略**（不在版控），但本機佔空間。去重可立即回收 ~700 MB+。

### D2. 疑似孤兒 STL（repo 文字零引用，低信心，須查 DB）
| 檔案 | 說明 |
|---|---|
| `assets/files/stl/io_3_850_hp_step_converted.stl` | STEP→STL 中間產物；線上用的是 `thorlabs_io_3_850_hp.stl` |
| `assets/files/stl/e7159bfb-..._ad9959_pcbz.stl` | UUID 版，已被乾淨的 `ad9959_pcbz.stl` 取代 |
| `assets/cf175c_m_edrawing.html` | migration `0063` docstring 自述是孤兒 |

### D3. 斷掉的引用（不是孤兒，是 bug）
- `assets/catalog/.../thorlabs_io_3_850_faraday_rod.json` 的 `geometryRef` 指向 `files/stl/thorlabs_io_3_850_hp/faraday_rod.stl`，**該子目錄不存在**。可能是 `split_io_3_hp_stl.py` 沒跑或檔案遺失。須確認線上 faraday-rod asset 能否解析。

---

## E. 測試檔清單（你說要刪測試 → 先看清單再決定）

> ⚠️ 提醒：這些是正規單元/整合測試，是資產不是垃圾。刪掉等於失去自動測試能力。
> 你原話「有些檔案當初只是測試但現在正在線上」→ 那種情況是上面 **C 區（正名）**，不是這裡。
> 這區純粹列出「真正的測試檔」，要不要刪由你定。

### E1. frontend 測試（41 個）
- `kinds/__tests__/`：plugin_alignment、plugin_exhaustiveness、plugin_partition
- `modules/_registry.test.ts`
- `optical/`：frames、generalizedAbcd、pose、__tests__/{parity/parity, profileUtils, ray-tracer-v3}
- `optical/fiber/__tests__/`：arc_length、attenuation_bend、coupling、fresnel、polarization
- `optical/kinds/*/`：aom、aom-v3、dichroic-mirror、faraday-rotator、lens、mirror、pbs、polarizer、waveplate（各 physics.test.ts）
- `store/__tests__/v3FeatureFlags.test.ts`
- `three/`：deltaAlphaFromHit、lensOpticalGeometry、opticalBeams、__tests__/{beam_mesh_alignment, bindingRendererGate.swap, bindingTreeObject, labRoot.invariant, loadAsset.skipAutoCenter, pbs252.swap}
- `utils/__tests__/`：anchorAccess、componentBindings、fiberAlignment、fiberBodyEndpointResolver、rfPropagation、rigidGroup.frame

### E2. backend 測試（`backend/tests/`，pytest）
- 設定：`pytest.ini`、`tests/conftest.py`
- 核心：test_assembly_solver、test_collins_fft、test_component_bindings、test_generalized_abcd、test_hg_modes、test_kind_params_partition、test_kinds_manifest、test_optical_schemas、test_relation_solver、test_spinapi_compile、test_tapered_amplifier、test_timing_program、test_touchstone、test_agent_session_lifecycle、test_aom_anchor_migration（test_optics_cavity／test_optics_crystal／test_palace_io／test_spice_parser 已於 2026-06-10 隨模組移除）
- v2 階段：test_v2_phase{1..8}（mirror/laser/polarization/beam_splitter/aom/isolator）
- optical：test_aom_v3、test_db_scene_loader_binding_tree、test_dichroic_mirror、test_faraday_rotator、test_glan_laser、test_lens、test_mirror、test_pbs、test_polarizer、test_ray_tracer_v3、test_solver_v3、test_solver_v3_isolator、test_waveplate、parity/test_parity

---

## F. frontend v3 光追島（19 檔，UNCERTAIN — 別急著刪）

`frontend/src/optical/` 下有一整套 TypeScript 光追引擎（`ray-tracer-v3.ts`、`registry.ts`、`geometry.ts`、`optical/kinds/*/physics.ts`、`optical/fiber/*` 等），**目前只被 vitest 測試引用，main.tsx 完全到不了**。

- 線上實際光束走的是：`three/rayTrace.ts` → `three/v3TraceAdapter.ts` → 後端 `/api/v3/solver`（見記憶 object_sense_beam）。
- 這個 `optical/` 島是**平行的、尚未上線的**引擎，有完整 parity 測試 + golden fixtures → 很可能是**進行中的重構**，不是廢案。
- **刪前務必確認 roadmap**。唯一例外：`optical/kinds/laser-source/physics.ts` 連測試都沒引用，是島內也斷的 dangling 檔。

---

## G. Alembic 鏈健康度（結論：完全正常）

- Head：`0097_repair_dynamic_sources`；Root：`0001_initial_schema`。
- **97 個 migration 單一線性鏈，無 gap、無分支、無重複 revision id。**
- revision id 都刻意縮寫以守 VARCHAR(32) 限制（見記憶 qmem_alembic_revision_id_limit），全部對得上，無 0091 那種斷裂。
- **⚠️ 絕對不要刪**任何 `v2`/`v3`/`baseline`/`cutover` 命名的 migration（0027~0034、0082~0084 等）。它們是歷史已套用的 migration，刪掉會斷鏈、讓 `alembic upgrade head` 壞掉、DB 卡在前一版。名字看起來像實驗，實際是正史。

---

## 建議執行順序

1. **A 區**：直接刪 scratch + 死碼（最安全，零風險）。
2. **D1 去重**：回收 ~700 MB（UUID 檔已 gitignore，刪本機即可）。
3. **B 區**：逐項問你後再刪。
4. **C 區正名**：一個檔一個 PR，連 import 一起改，改完跑 `tsc --noEmit` / pytest 驗證。
5. **D2/D3、F 區**：查線上 DB / 確認 roadmap 後再動。
6. **E 區測試**：強烈建議**保留**；若真要刪，逐區確認。
7. **G 區 Alembic**：不要動。
