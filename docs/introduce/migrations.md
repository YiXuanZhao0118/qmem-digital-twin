[← 文件索引](README.md)

# Alembic Migration 鏈

> 啟動/升級步驟見 [runbook.md](runbook.md)；已知問題見 [known-issues.md](known-issues.md)。

- **Head：** `0118_asset_device_id`；**Root：** `0001_initial_schema`。
- 單一線性鏈，無 gap、無分支、無重複 revision id。`env.py` 以 `from app.models import Base` 取 metadata 當 autogenerate target。
- revision id 刻意縮寫以守 **VARCHAR(32)** 限制（曾有 0091 超限把 DB 卡在 0090 的事故，現已健康；最新 `0118_asset_device_id` = 20 字元）。
- 關鍵 migration：0036–0039 多物理 sidecar 表；0082–0084 v3 asset 物理欄；0086 kinds registry；0093 flatten frame anchors（移除 body frame）；0094/0095 strip component physics；0096 drop pe intrinsic/state；0097 repair dynamic sources；**0106 drop assets_3d.faces + transitions（v2 face 路徑退役 → anchors）**；0107 rename anchor_template；0108 rf_switch filepath；**0109 drop circuits 表 + 清除已移除模組（Optics/Electronics/EM）的 simulation runs**；0110 unclassified kind；0111 asset kind NOT NULL；0112 locked flag；**0113 drop objects.param_overrides + add assets_3d.tunable_params（逐實例可調改由 Asset 標記、值走 dynamic_sources）**；0114–0117 連接器 kind/asset/component（見 [kinds.md](kinds.md)）；**0118 add assets_3d.device_id（device registry 指標；見 [kinds.md](kinds.md) device 節）**。
- ⚠️ **絕對不要刪**任何已套用的 migration（包括名字像實驗的 `v2`/`v3`/`baseline`/`cutover`，如 0027~0034、0082~0084）：刪除會斷鏈、讓 `alembic upgrade head` 壞掉、DB 卡在前一版。名字像實驗，實際是正史。
