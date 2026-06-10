[← 文件索引](README.md)

# Alembic Migration 鏈

> 啟動/升級步驟見 [runbook.md](runbook.md)；已知問題見 [known-issues.md](known-issues.md)。

- **Head：** `0097_repair_dynamic_sources`；**Root：** `0001_initial_schema`。
- 97 個 migration 單一線性鏈，無 gap、無分支、無重複 revision id。`env.py` 以 `from app.models import Base` 取 metadata 當 autogenerate target。
- revision id 刻意縮寫以守 **VARCHAR(32)** 限制（曾有 0091 超限把 DB 卡在 0090 的事故，現已健康）。
- 關鍵 migration：0036–0039 多物理 sidecar 表；0082–0084 v3 asset 物理欄;0086 kinds registry;0093 flatten frame anchors（移除 body frame）;0094/0095 strip component physics;0096 drop pe intrinsic/state;0097 repair dynamic sources。
- ⚠️ **絕對不要刪**任何已套用的 migration（包括名字像實驗的 `v2`/`v3`/`baseline`/`cutover`，如 0027~0034、0082~0084）：刪除會斷鏈、讓 `alembic upgrade head` 壞掉、DB 卡在前一版。名字像實驗，實際是正史。
