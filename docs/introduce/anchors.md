[← 文件索引](README.md)

# 座標系與 Anchor 架構（現行：alembic 0093）

> 相關：[asset.md](asset.md)（anchor 存在 Asset3D 上）、[object.md](object.md)（Lab pose）、[optics.md](optics.md)（anchor 方向如何被 tracer 使用）。

**三個執行期座標系**（注意：這取代了舊文件的「4-frame」模型）：
1. **Lab frame** — 場景/世界。SceneObject 的 `x/y/z mm` + `rx/ry/rz deg` 把一個元件實例放進實驗室。
2. **Component frame** — 組裝/模板。Component 的 ComponentBinding 把資產/子元件擺在 component root 之下；tunable axes + object-level binding override 可在此 frame 內移動/旋轉。
3. **Asset/CAD frame** — 單一 Asset3D 的幾何局部系。Anchor 直接在此標註。**沒有獨立的執行期 body frame。**

**變換鏈與公式：**
```
anchor_asset_local → ComponentBinding pose → SceneObject Lab pose → Lab frame

P_lab = T_sceneObject_lab · T_componentBinding · P_anchor_asset
D_lab = R_sceneObject_lab · R_componentBinding · D_anchor_asset
```
- Lab 與 three.js **都是 Z-up**，執行期數學**不可**再做 lab↔three 軸交換。
- 旋轉用 row-vector 慣例：`M_row = Rx(rx)·Ry(ry)·Rz(rz)`，`R_lab = transpose(M_row)`。例：`ryDeg=45` 把 CAD `[0,0,1]` 映到 Lab `[-0.707, 0, 0.707]`。
- 舊的 body-frame 層（`body_frame_rotation`/`bodyFramePositionMm`）已被 **0093** 移除並烤進 anchors；執行期不得再套用 `R_body`/`bfp`。CAD 軸不順要在 catalog import 時修，不在 trace/render 時修。
- 相容性：欄名仍含 `BodyLocal`（`positionMmBodyLocal`、`directionBodyLocal`…）但語意已是 Asset/CAD-local。

**Anchors（光學介面）：** `anchors[]` **取代了舊的 `faces[]` / `transitions[]`**——每個 anchor 本身就是一個有向的光學介面，直接帶**方向**與 **aperture**，因此**不再有「雙埠資產用物理面 `A`/`B`」、也不再有有向的 `transitions[]`（A→B、B→A）那套命名**。方向 / 互易性 / 繞射階 / RF-side 等行為改由各 kind 的 PhysicsOp 依 anchor 的方向就地決定（見 [optics.md](optics.md)、[kinds.md](kinds.md)）。

每個 anchor（後端 `V3Anchor`，body-local）存：
- `id`
- `position`（介面平面通過點）
- 三軸：`axisX` = 傳播 / 法向方向、`axisY` = 橫向 1（fast axis / s-pol…）、`axisZ` = 橫向 2（= axisX × axisY）
- `apertureMm` + `apertureShape`（`circle`…）

tracer 對「過 `position`、垂直 `axisX` 的平面」做 ray-plane 命中，並用 aperture 裁切（落在 `apertureMm` 外視為 miss）。Component 透過 binding / `exposedFaces` 把對外語意埠（如 `optical_in`）映到 `assetBindingId + anchorId`。

- anchor 的 `axisX`（法向）是 Snell/Fresnel/反射的真值（s/p 分解：`s=(k×axisX)/|·|`、`p=k×s`）；**tracer 決定出射方向，op 不決定**。
- 5×5 增廣矩陣（V=[x,θx,y,θy,1]）處理橫向位移（稜鏡楔角、Glan-Laser 38.5° decenter）；一般用 2×2 ABCD；柱面鏡/Glan 用 abcdXY（x/y 分開）。

frame 數學：前端 `optical/frames.ts`、`optical/pose.ts`、`utils/anchorAccess.ts`；後端 `optical/db_scene_loader.py`。
