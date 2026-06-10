# QMsimulation / qmem-digital-twin — 文件索引

> 本目錄是整個專案的說明文件。原本的單一「完整解說」(`docs/README.md`) 已於 **2026-06-10** 依主題拆分為下列概念說明檔；本檔現為**索引與導覽**。
> （根目錄另有較大的英文 `README.md` 主文件，但部分內容已過時——架構/概念解說以本目錄為準。逐檔清理建議見根目錄 `CLEANUP_AUDIT.md`。）

---

## 說明檔導覽

### 入門
- [系統概觀 · overview.md](overview.md) — 這是什麼、三層服務架構、目錄結構

### 核心資料模型（系統脊椎）
- [資料模型總覽 · data-model.md](data-model.md) — 四層模型、參數歸屬規則、參數合併順序
- [Asset3D · asset.md](asset.md) — 幾何 + 物理真值層
- [BUILD · build.md](build.md) — 瀏覽器內 CAD→GLB、產生 Asset3D（Geometry Builder）
- [Component / ComponentBinding · component.md](component.md) — 目錄模板 + 綁定樹
- [SceneObject · object.md](object.md) — 場景實例層
- [座標系與 Anchor · anchors.md](anchors.md) — 三 frame、變換鏈、anchor 光學介面（方向 + aperture）

### 渲染與光學
- [渲染管線 · rendering.md](rendering.md) — 前端場景建構
- [Kind 分類 · kinds.md](kinds.md) — 28 kinds + 每 kind 契約
- [光學物理模型 · optics.md](optics.md) — 偏振、求解器、RF tracer、TA

### 多物理與時間
- [多物理場模組 · multiphysics.md](multiphysics.md) — 現只剩 Lab tab + Magnetics overlay（Optics/Electronics/EM 已移除）
- [時間域模擬 · timing.md](timing.md) — Sequence、Scrub time、AD9959、RF 鏈
- [擺放與吸附 · placement.md](placement.md) — Placement & Snapping 引擎

### 運維與參考
- [主要 API 端點 · api.md](api.md)
- [啟動與開發 Runbook · runbook.md](runbook.md)
- [Alembic Migration 鏈 · migrations.md](migrations.md)
- [已知過時 / 待處理 · known-issues.md](known-issues.md)

### 既有專題文件（在上層 `docs/`）
- [AOM 模型 · ../aom-model.md](../aom-model.md) + `../aom_align_*.png` / `../aom_align_*.py`（AOM 對準圖表腳本與圖）
- [Object Sense kinds · ../object-sense-kinds.md](../object-sense-kinds.md)

---

## 附錄：本文件整合來源

上述說明檔的內容，整合自以下原 `docs/` 檔（已於 2026-06-01 整合後移除）：
**架構** — `ARCHITECTURE_OVERVIEW.md`、`vibe coding.md`、`frame-anchor-architecture.md`；
**光學/物理** — `optical-schema-v2.md`、`optical-kinds-spec.md`、`asset-physics-model.md`、`asset-physics-implementation.md`、`asset-params-inventory.md`、`legacy-physics-retirement.md`、`tapered-amplifier-model.md`、`phase-3b-review.md`；
**多物理/時間/擺放** — `MULTIPHYSICS_PLAN.md`、`MULTIPHYSICS_PROGRESS.md`、`PHYSICS_TIME_DESIGN.md`、`PHYSICS_TIME_CHECKPOINT.md`、`PLACEMENT_DESIGN.md`、`PLACEMENT_PROGRESS.md`、`AD9959_TIMING_INTEGRATION.md`、`PHASE_C_WORKSTATION_SETUP.md`。

`docs/aom_align_*.png` 與 `aom_align_*.py`（AOM 對準圖表的產生腳本與圖）予以保留。

> 文件版本衝突解析原則：當舊文件矛盾時以最新者為準——`frame-anchor-architecture.md`(0093) > `ARCHITECTURE_OVERVIEW.md`(0043) > `vibe coding.md`(~0020)；v3 取代 v2；`PhysicsElement` 取代舊 `OpticalElement`；`ComponentBinding` 是規劃中 `anchorBindings` 的實作版。
