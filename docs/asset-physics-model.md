# Asset-Physics Model — 設計文件

> Status: **設計階段,尚未動程式碼。** 起草於 2026-05-21,作為「將物理收斂到 Asset3D 層」的提案。
>
> 相關文件:[`ARCHITECTURE_OVERVIEW.md`](ARCHITECTURE_OVERVIEW.md) §3, [`optical-schema-v2.md`](optical-schema-v2.md), [`vibe coding.md`](vibe%20coding.md) §4 frame conventions。

Canonical face rule:
- `faces[]` are physical optical surfaces only.
- A two-port asset uses physical faces `A` and `B`.
- Forward/reverse behavior is represented by directed transitions `A -> B` and `B -> A`.
- Do not create duplicate faces such as `A1/B1/A2/B2` just to encode direction.
- Direction, branch, non-reciprocity, diffraction order, and RF side belong on `transitions[]` (`op`, `params`, dynamic sources), not in face names.

---

## 1. 動機

目前三層資料模型(Asset3D / Component / SceneObject)的職責邊界**不夠乾淨**:

- 物理 `kind`(mirror、polarizer、aom...)掛在 **Component** 上,Asset3D 只承載 CAD 幾何
- 同一語意(光學軸、鏡面法向、RF 軸)有 2~3 種讀取路徑(V2 binding → anchor `directionBodyLocal` → 預設值)
- Ray tracer 要根據 `elementKind` 字串 dispatch 到不同 handler,每加一種元件就要動五個檔案
- Per-instance 參數(laser power、AOM freq)散在 `properties` / `kindParams` / `objectBindings` 三處

**目標**:把「**這個元件做什麼物理**」收到 Asset3D,把「**這個元件在空間怎麼跟其他元件接起來**」收到 Component,把「**這顆實體現在的狀態**」收到 SceneObject。讓 ray tracer 不再認 kind 字串,只認 Face/Transition 幾何。

**同樣的三層結構同時適用 RF 元件**(`rf_source`、`rf_amplifier`、`rf_cable`、`rf_switch`、`programmable_pulse_generator`、`horn_antenna`):只是 face 帶 `domain: "rf" | "ttl"`,transition 走的是 §7.5 的 RF tracer(graph BFS)而非 §7 的 ray tracer。AOM 是兩者交接的 hybrid 元件(§14)。

---

## 2. 三層職責劃分

| 層級 | 擁有 | 不擁有 |
|------|------|--------|
| **Kind Registry**(code,非 DB) | PhysicsOp 實作(`abcd_lens`、`jones_polarizer`、`diffract_aom`…)、kind 元資料(`needs_aperture`、`wavelengthRangeNm` 模板) | 任何幾何、任何 vendor 細節 |
| **Asset3D** | CAD 幾何、**kind**、**faces**(光學端口幾何)、**transitions**(in face → out face + op)、**defaultParams**(該 kind 的預設係數) | 空間組合、lab pose、運行時參數 |
| **Component** | binding tree(子 asset 相對 pose)、**exposedFaces**(對外暴露的端口) | 物理 kind、運行時參數 |
| **SceneObject** | lab pose `(xMm,yMm,zMm,rxDeg,ryDeg,rzDeg)`、**paramOverrides**(per-binding 係數覆寫)、**dynamicSources**(laser power / AOM freq / beam profile)、ObjectBinding pose delta | 物理 op、CAD 幾何 |

**金線約定**:
1. Asset3D 的 BodyLocal **+z = 光學軸方向**,**+x = 物理橫向參考軸**(快軸 / 聲軸 / s 偏振)。RF-only asset(無 optical face)不適用此 +z 約定,body frame 對齊 CAD 即可
2. Ray tracer / RF tracer 都不認 `kind` 字串,只認 Face 命中(ray)+ port adjacency 命中(rf)+ Transition 表
3. SceneObject 三個欄位(paramOverrides / dynamicSources / objectBindings)職責 disjoint
4. Face 的 `domain` 決定走哪個 tracer:`"optical"` → §7,`"rf"`/`"ttl"` → §7.5;同一 Asset3D 可同時有兩種(AOM 的 `A`/`B` optical + `rf_in` rf)

---

## 3. Asset3D Schema

```typescript
type Asset3D = {
  id: string                          // e.g. "thorlabs_lpvisa050-mp2"
  vendorPart?: string                 // 貨號 metadata
  geometryRef: string                 // CAD 檔路徑 (.glb / .stl)
  bodyFrameRotation?: Quaternion      // CAD 軸不符合 +z 約定時的修正

  kind: Kind                          // ★ 唯一 kind,固定(OpticalKind | RfKind,§6)
  faces: Face[]                       // ★ 端口(optical / rf / ttl;取代舊 anchor 中的光學/RF 項)
  transitions: Transition[]           // ★ in face → out face + op(optical:光學 PhysicsOp;rf:RfPhysicsOp)

  defaultParams: KindParams           // kind-specific 預設係數
  wavelengthRangeNm: [number, number] // R2 (optical-schema-v2)

  mechanicalAnchors?: MechAnchor[]    // 非光學 anchor (mount face, edge) 維持原結構
}

type Face = {
  id: string                          // Physical face id: "A", "B", "R", "T", "rf_in", "rf_out", "ttl_in", ...
  positionMmBodyLocal: Vec3
  normalBodyLocal?: Vec3              // 預設 +z(out 面)/ -z(in 面);mirror 可自訂
  apertureMm: number                  // 半寬 / 半徑;RF/TTL face 未使用,設 0
  apertureShape: "rectangle" | "ellipse" | "circle"   // circle 留 back-compat
  domain?: "optical" | "rf" | "ttl"   // 預設 "optical";RF/TTL face 必填以阻止跨域對接
}

type Transition = {
  in: string                          // face id
  out: string | string[]              // 單一(transmit)/ 多個(diffraction orders)
  op: PhysicsOpRef                    // 指向 Kind Registry 的 op
  params?: Partial<KindParams>        // 對該 transition 的局部覆寫(罕用)

  // 幾何傳輸矩陣(三選一,由 PhysicsOp 決定如何解讀)
  abcd?: Matrix2x2                    // (a) 簡單對稱元件 — 同一矩陣作用在 (q_x, q_y)
  abcdXY?: { x: Matrix2x2; y: Matrix2x2 }  // (b) 像散元件(cylindrical lens, Glan-Laser) — x/y 軸獨立
  matrix5x5?: Matrix5x5               // (c) 增廣 5×5,作用在向量 V = [x, θ_x, y, θ_y, 1]^T
                                      //     額外捕捉「元件本身造成的絕對橫向位移」(prism / wedge)
}
```

**5×5 增廣矩陣使用時機**:當元件存在**獨立於入射狀態的固定空間偏移**(prism wedge、Glan-Laser 內部 38.5° 斜面、decenter)時,需要 V 向量的第 5 分量「1」承接 `E_x` / `E_y` 偏移項。Lens、mirror、polarizer 等對稱元件用 2×2 ABCD 即可;Glan-Laser、Wollaston、wedge prism 用 5×5。

**Face `domain` 規約**:`"optical"` 走 ray tracer(§7);`"rf"` 走 RF tracer(§7.5);`"ttl"` 屬於 RF tracer 的 pre-pass(switch state 解析,§7.5)。`exposedFaces` / 連線編輯器在拖線時必須 enforce `domain` 一致才能建立 link(`optical_links` 只接 optical,`rf_links` 只接 rf,ttl 端只能接 ttl)。RF/TTL face 沒有 wavefront,`abcd` / `matrix5x5` 永遠為 null;其 `apertureMm` 也不參與 ray-hit 判定,僅作為 UI snap target 半徑。

**設計重點**:
- `kind` 跟 Asset3D 是 **1:1**。同樣 CAD 件要當 polarizer 與 quarter waveplate,就是兩個 Asset3D(可共用 `geometryRef`)。換來「看 Asset 即知物理」。
- `faces[]` 取代舊 `anchor[]` 中的「光學端口」項目;機械 anchor(mount face、edge)維持原樣放在 `mechanicalAnchors`。
- `transitions[]` 明確列出「面 A 進入 → 面 B 出去」的所有路徑,**ray tracer 直接遵守,不做 kind dispatch**。
- **幾何矩陣三層級(2×2 / 4×4 / 5×5)**:從低到高表達力遞增,各 PhysicsOp 宣告自己需要哪種。BeamRay 的 `origin` 已經承擔絕對位置,5×5 的第 5 分量只負責「**元件本身造成的固定偏移**」,不重複編碼 ray 的當前位置。

---

### 3.1 Body frame convention(座標系約定)

Asset3D 用一個 body frame 記錄 face 位置與法向。**Tracer 的物理計算只看 face 幾何**(位置 + 法向),不會去檢查「body +Z 是不是真的等於光線方向」。「body +Z = 光軸」是**矩陣編寫的約定**,不是 tracer 的硬性檢查。

| 元件型態 | body +Z 的角色 | A / B / R / ... face 配置 | matrix5x5 寫在哪個 frame |
|----------|--------------|---------------------------|-------------------------|
| 2-port slab (lens / waveplate / AOM / Faraday rod / polarizer) | **嚴格** = A→B 光軸 | A 在 -z,法向 (0,0,-1);B 在 +z,法向 (0,0,+1) | body frame ≡ beam-local frame,直接寫 |
| Mirror | **嚴格** = face A 法向(垂直入射時等於入射光方向) | A 唯一,法向 (0,0,+1) | beam-local(反射 op 內部處理方向翻轉) |
| PBS / beam splitter / Glan-Laser / dichroic | **primary transmit 軸** (A→B) | A 在 -z、B 在 +z(穿透);R / L / U / D 等側面照物理角度擺 | A↔B transition 在 body frame;側面 transition (A→R 等) 在出射 beam frame |

**為什麼仍然要保留「body +Z = 光軸」這個約定?**

純粹是**寫矩陣的方便**:5×5 的 row/col 索引 `[x, θ_x, y, θ_y, 1]` 直接對應 body-x、body-y、body-z 的分量,看數字就知道在做什麼。如果允許 body frame 隨意定,每個 matrix 都要附註「此矩陣以 R-face 法向為 z,身體 +X 為 x...」,易出錯。

**多 port 元件的處理原則**:

- body +Z = **primary transmit (A→B)**,例如 Glan-Laser 的穿透路徑、cube PBS 的直通路徑。
- 側面 face (R / L / U / D) 的位置 / 法向據實寫(例如 Glan-Laser reject face 法向 (0.9213, 0, 0.3888))。
- A→R 這類 transition 通常 **`matrix5x5 = null`**,因為我們不模擬反射路徑的 wavefront aberration(只更新 power + 方向)。要模擬的話,matrix5x5 寫在「出射 beam frame」(z 沿著 R 法向),不是 body。
- 如果未來需要強制檢查,可在 Phase 9 加 runtime assert(見 §10 Phase 9)。

**`bodyFrameRotation` 的職責**:

純粹**對齊 CAD STL 到 body frame**,跟物理無關。
- 你先決定 body frame 的 face 座標 → 例如 face A 在 (0,0,-2.5)、face B 在 (0,0,+2.5) → body +Z = A→B
- 如果 STL 是用 CAD +X 當建模軸,直接 import 會跟 face marker 差 90° → 設 `bodyFrameRotation` 把 CAD frame 旋到 body frame,讓 STL 顯示對齊
- **設值不影響 tracer**;tracer 只看 face 幾何

PhyEditor 的 "Body frame orientation" 下拉就是設這個 quaternion(`+Z (default)` / `±X` / `±Y` / `-Z` 6 種常見軸對齊)。

---

### 3.2 Face normal 的意義(`normalBodyLocal`)

Face normal 同時擔任 **幾何 + 語意 + 物理** 三個角色。所有 catalog 必須遵守這裡列的 convention,否則 tracer 不會報錯但 Snell / Fresnel / 偏振結果會錯邊。

**(1) 幾何角色 — 定義 face 平面**

Face 是一個平面圓盤(或矩形 / 橢圓):
- `positionMmBodyLocal` = 圓盤中心
- `normalBodyLocal` = 圓盤所在平面的單位法向
- Aperture (`apertureMm` / `apertureShape`) 是這個平面上的 2D 形狀

Tracer 做 ray-plane intersection 時靠 `(position, normal)` 解 hit point,再用 aperture 形狀 clip。

**(2) 語意角色 — outward normal convention**

法向**永遠指向元件本體之外**:

| Face | 角色 | 典型法向(body frame) |
|------|------|---------------------|
| A | 入射面(beam 從外面進來) | (0, 0, **−1**) — 從元件中心朝外指向 −z |
| B | 出射面(beam 朝外離開) | (0, 0, **+1**) — 從元件中心朝外指向 +z |
| R (Glan reject / PBS side) | 側面 reject 出口 | 例如 (0.9213, 0, 0.3888) — 從晶體中心朝 air gap 外 |
| Mirror 唯一面 | 反射面 | (0, 0, +1) — 從鏡面背後指向被照亮的那側 |

**驗證**:`k̂_beam · n̂_face` 的符號
- `< 0`:beam 朝 face 進入(打中入射面)
- `> 0`:beam 從 face 離開(通過出射面)

**(3) 物理角色 — Snell / Fresnel / 偏振基底**

法向直接進入物理公式:
- 入射角 `cos θᵢ = −k̂·n̂`(負號因為 outward normal vs incoming beam)
- Snell's law:用 n̂ 做 reference axis 解折射方向
- 反射:`k̂_out = k̂_in − 2(k̂_in·n̂)n̂`
- Fresnel reflectance R_s, R_p 用 θᵢ 算
- **s/p 偏振基底**:`s = (k̂_in × n̂) / |…|`,`p = k̂_in × s` — Jones vector 的 lab basis,Faraday / PBS / 偏振相關 op 都依賴這個基底

例子:Glan-Laser R 面法向 (0.9213, 0, 0.3888) **同時**
- 標出 R 圓盤躺在哪個傾斜平面上(幾何)
- 指出 reject 光從元件中心朝這方向射出(語意)
- 決定 reject 光出射方向 = 入射光經過 air-gap 界面後 Snell 折射的結果(物理)

**(4) Face normal vs body +Z**

|  | body +Z | face normal |
|---|---|---|
| 屬於 | 整個 Asset3D 的座標系 | 個別 face |
| 數量 | 1 個(全 asset 共用) | 每 face 1 個,各自獨立 |
| 角色 | 矩陣 row/col 索引基準(convention) | 平面定義 + 物理輸入(ground truth) |
| 修改方法 | `bodyFrameRotation` 旋整個 asset | 編輯個別 face 的 `normalBodyLocal` |

兩者**獨立**。對 2-port slab 因為 face A 法向 = (0,0,-1) = 反向 body +Z,看起來像一回事,但對 PBS 的 R 面就明顯不同 — R 法向不是 ±Z 任何一個。

**(5) 實作規則**

- 必須是**單位向量**(tracer 會 normalize,但 catalog 寫成單位長度看數字更直觀)
- Schema 上 optional(`normalBodyLocal?`),省略時預設 A=(0,0,-1)、B=(0,0,+1),但實務上所有 catalog 都明寫避免歧義
- 微小傾斜可模擬 wedge / decenter(例如 face B 法向 `(0.01, 0, 0.9999)` ≈ 0.6° wedge)
- Tracer **用 face normal 算交點 + 入射角**;**不用它判斷「這是不是入射面」**— 那由 transition 的 `in` / `out` 欄位決定

**TL;DR**:Face normal = **出射方向的單位向量 + 定義 face 平面的法向**。約定指向元件外側,正負號錯了是讓 PBS / mirror / Glan-Laser 算錯結果的最常見單一錯誤。

---

### 3.3 Multi-hop reflective transition(A* / B* topology)

針對 **PBS / BS / Glan-Laser / dichroic** 這類「內部有反射界面」的元件,使用統一的多面拓撲。所有反射一律走 mirror 公式 `k_out = k_in − 2(k·n̂)n̂`,**不再用「face normal = exit direction」的偷吃步**。

**Face 角色分類**

| 命名 | 角色 | 法向意義 | 該 face 的物理 |
|------|------|---------|-------------|
| **A1, A2, A3, A4** | 外部進出面(前 / 後 / 左 / 右) | 平面外向法向 | Snell 折射(若兩側介質不同) |
| **B1, B2** | 內部反射界面(Brewster 鍍膜 / Glan air-gap) | 真實表面法向 | `k_out = k_in − 2(k·n̂_B)n̂_B`(mirror 公式) |

A* 跟 B* 是**命名 convention 不是 schema 強制**;tracer 看 transition 的 `via` 欄位決定每 face 套哪個物理。建議 catalog 編輯者照這個命名以利閱讀。

**Transition 多段路徑(via chain)**

```typescript
type Transition = {
  in: string                       // 起始 face id
  via?: string[]                   // 內部 / 中間 face id 序列(按通過順序)
  out: string | string[]           // 終點 face id(多個 = 多 order)
  op: PhysicsOpRef
  abcd?  | abcdXY? | matrix5x5?    // 整段路徑的等效幾何矩陣
}
```

Tracer 對 `[in, ...via, out]` 依序處理:
- 落在 A*:Snell 折射(用該 face 法向 + 兩側折射率)
- 落在 B*:Mirror 反射(用該 face 法向)

Op 拿到的 `PhysicsOpContext` 包含完整 face chain(`face_in`, `face_via[]`, `face_out`),負責 polarization / power 演化;**幾何方向由 tracer 從 face 法向 + 公式自動算**,op 不再硬寫 exit direction。

**路徑形態**

- **穿透**(transmit through interface):`A1 → [B1, B2] → A_opposite`
  - 例:Glan-Laser p 穿透 `A1 → [B1, B2] → A2`(過 air gap 兩次 Snell)
  - 例:Cube PBS p 穿透 `A1 → [B1, B2] → A2`(過 Brewster plate 兩次 Snell,薄板 lateral shift ≈ 0)
- **反射**(reflect off interface):`A1 → [B1] → A_side`
  - 例:Glan-Laser s reject `A1 → [B1] → A3`(s 在 gap mirror reflect,出側面)
  - 例:Cube PBS s reflect `A1 → [B1] → A3` 或 `A4`(出射 A 由 B1 法向 + mirror 公式決定)
- **單界面**(老的 2-port slab):`A1 → A2`(via = [])
  - Lens / waveplate / AOM / Faraday rod 沿用,沒有 B 面

**範例:Glan-Laser IO-3 ( L=5.0mm, gap angle 38.5° )**

```
faces:
  A1 (input)    pos (0, 0, -2.5)    normal (0, 0, -1)         outward
  A2 (transmit) pos (0, 0, +2.5)    normal (0, 0, +1)         outward
  A3 (reject)   pos (2.3, 0, 0)     normal (1, 0, 0)          側面外向
  B1 (gap front) pos (0, 0, 0)      normal (0.6225, 0, -0.7826)   真實 gap 表面
  B2 (gap back)  pos (0.1, 0, 0)    normal (0.6225, 0, -0.7826)   平行於 B1

transitions:
  A1 → A2 via [B1, B2]   op=glan_transmit_p   p 過兩次 Snell
  A1 → A3 via [B1]       op=glan_reject_s     s mirror reflect at B1 → A3 Snell
  A2 → A1 via [B2, B1]   op=glan_transmit_p   反向
  A2 → A3 via [B2]       op=glan_reject_s     反向 reject(理論不該觸發)
```

驗證:beam=(0,0,1) 進 A1 走 reject 路徑
1. B1 mirror:`k_out = (0,0,1) − 2·(0,0,1)·(0.6225, 0, -0.7826) · (0.6225, 0, -0.7826)`
   - `(k·n̂) = -0.7826`,`2(k·n̂)n̂ = (-0.974, 0, 1.225)`
   - `k_after_B1 = (0,0,1) − (-0.974, 0, 1.225) = (0.974, 0, -0.225)` (晶體內)
2. A3 Snell(crystal n=1.48 → air n=1,面法向 (1,0,0)):
   - 平面內分量保持,法向分量按 Snell 折射
   - 折射後 `k_air ≈ (0.9213, 0, 0.3888)` ← 跟舊版 catalog 對得上

如果折射算完跟舊版不一致 ±0.001,就是 catalog 物理數值(gap 角度、晶體折射率)需要校正,不是 convention 錯。

---

## 4. Component Schema

```typescript
type Component = {
  id: string                          // "isolator_1064_io3"
  vendorPart?: string
  bindings: ComponentBinding[]        // 子 Asset 的相對 pose
  exposedFaces: ExposedFace[]         // 對外暴露的端口
  // 沒有 kind, 沒有物理參數
}

type ComponentBinding = {
  bindingId: string                   // "input_pol" | "faraday" | "output_pol"
  assetId: string
  local_x_mm: number
  local_y_mm: number
  local_z_mm: number
  local_rx_deg: number
  local_ry_deg: number
  local_rz_deg: number
  tunableAxes?: Axis[]                // 哪些軸允許 SceneObject 透過 ObjectBinding 覆寫
}

type ExposedFace = {
  componentFaceId: string             // 對外名稱 "optical_in"
  assetBindingId: string              // 指向 bindings[].bindingId
  assetFaceId: string                 // 該 asset 的 face id
}
```

**設計重點**:
- Component **沒有 kind**,純粹空間組合 + 對外端口宣告
- `exposedFaces` 是 ray tracer 在「component 邊界」與「内部 sub-asset」之間的橋樑 — 外部光只能從 exposed face 進入,內部 sub-asset 之間的傳播由 ray tracer 自己處理
- 單一 Asset 也包成 Component(vendor part = single asset),這樣 SceneObject 永遠指向 Component,介面統一

---

## 5. SceneObject Schema

```typescript
type SceneObject = {
  id: string
  componentId: string

  // Lab pose (現狀保留)
  xMm: number; yMm: number; zMm: number
  rxDeg: number; ryDeg: number; rzDeg: number

  // ★ kind 係數覆寫(per-binding,僅覆寫 defaultParams 子集)
  paramOverrides?: {
    [bindingId: string]: Partial<KindParams>
  }

  // ★ 動態源(只有 SceneObject 有,kind 預設為 undefined)
  dynamicSources?: {
    laserPowerMw?: number             // laser_source
    centerWavelengthNm?: number       // laser tunable
    aomFreqMhz?: number               // aom
    aomRfPowerDbm?: number
    beamProfile?: {
      w0Mm: number                    // 1/e² 半徑
      m2?: number                     // beam quality
      z0Mm?: number                   // waist 位置(component-local +z)
    }
    // ... 各 kind 自己宣告自己的動態欄位
  }

  // Per-instance pose delta(現狀保留)
  objectBindings?: ObjectBinding[]

  properties?: {
    placedRelativeTo?: PlacementIntent  // Smart Placement metadata
  }
}
```

**三類欄位的邊界規則**:

| 欄位 | 何時用 | 例子 |
|------|--------|------|
| `paramOverrides` | 同 kind 的「靜態 calibration 差異」 | 某顆 waveplate 實測 retardance = 88° 而非預設 90° |
| `dynamicSources` | 「這顆實體當前的操作狀態」 | laser 開到 50 mW、AOM RF 設 80 MHz |
| `objectBindings` | per-instance pose 微調(已存在) | 鏡子 yaw 微調 0.3° 對齊 |

**Solver 計算的 state**(beam jones、power flux、polarization)**不存任何地方**,每次 solve 重新算出。

---

## 6. Kind Registry

**Split between DB(metadata) 與 code(PhysicsOp)**(alembic 0086, 2026-05-25 起):

- **DB `kinds` table** 存可序列化的 metadata:`name`、`display_name`、`domain`、`op_set_name`、`default_params`、`face_template`、`needs_aperture`、`wavelength_range_nm`、`description`。前後端透過 `/api/kinds` 做 CRUD。
- **Code REGISTRY** 存 PhysicsOp 實作(`abcd_lens`、`jones_polarizer`、`diffract_aom`...)。函式不適合 ORM 序列化,所以留在 code 兩端鏡像(frontend `src/optical/registry.ts` ↔ backend `app/optical/registry.py`)。
- **DB row 透過 `op_set_name` 引用 code 端的 op 集合**。建一個新 kind row(例如 `my_custom_lens`)→ 設 `op_set_name = "lens_biconvex"` → tracer 用 lens_biconvex 的 ops 跑這個 kind。要做**真正新的物理行為**仍要在 code 註冊新 op,才能讓 UI 的 `op_set_name` dropdown 出現新選項。

```typescript
// frontend/src/optical/registry.ts
// backend/app/optical/registry.py — 鏡像
// 只負責 PhysicsOp(callable 函式),沒有 metadata。

type OpticalKind = 
  | "laser_source" | "tapered_amplifier"
  | "lens" | "mirror" | "dichroic_mirror"
  | "polarizer" | "waveplate"
  | "beam_splitter" | "pbs"
  | "aom" | "eom"
  | "faraday_rotator"
  | "fiber_coupler" | "fiber" | "fiber_end"
  | "isolator"                            // 注意:仍可作為 single asset 用,
                                          //   但 vendor "Thorlabs IO-3" 走 Component 路線
  | "nonlinear_crystal" | "saturable_absorber"
  | "detector" | "camera" | "spectrometer" | "wavemeter"
  | "beam_dump"

type RfKind =                             // ★ RF 圖節點(走 §7.5 RF tracer,不走 ray tracer)
  | "rf_source"                           // emitter:AD9959 DDS、generic synth
  | "rf_amplifier"                        // passthrough:ZHL-1-2W+ 等
  | "rf_cable"                            // 雙向 passthrough:同軸 / SMA / BNC
  | "rf_switch"                           // passthrough(N-throw,TTL 控):ZYSWA-2-50DR 等
  | "programmable_pulse_generator"        // emitter(TTL/Trigger 域):綁 Pulse&Timing TimingProgram
  | "horn_antenna"                        // sink:輻射出系統

type Kind = OpticalKind | RfKind          // Asset3D.kind 允許其中之一(且必須對應到 DB kinds.name)

type PhysicsOp = (
  rayIn: BeamRay,                       // (origin, dir, λ, jones, power) in face-local frame
  faceIn: Face,
  faceOut: Face,
  params: KindParams,
  dynamic?: DynamicSources              // 來自 SceneObject (laser power etc.)
) => BeamRay[]                          // 多條輸出(diffraction orders / BS 雙臂)

// 每個 op set 註冊自己的 ops(僅函式,metadata 在 DB)
const REGISTRY: Record<OpticalKind, {
  ops: Record<string, PhysicsOp>        // op name → impl
}>
```

```sql
-- DB schema (alembic 0086)
CREATE TABLE kinds (
  id                UUID PRIMARY KEY,
  name              TEXT UNIQUE NOT NULL,         -- 對應 Asset3D.physics_kind
  display_name      TEXT NOT NULL,
  domain            TEXT NOT NULL,                -- 'optical' | 'rf' | 'mechanical'
  op_set_name       TEXT NOT NULL,                -- 指到 code REGISTRY 的 key
  default_params    JSONB NOT NULL DEFAULT '{}',
  face_template     JSONB NOT NULL DEFAULT '{}',  -- anchors 範本(required / optional / needs_direction / needs_aperture)
  needs_aperture    BOOL  NOT NULL DEFAULT false,
  wavelength_range_nm FLOAT[],
  description       TEXT,
  created_at, updated_at …
);
```

**Registry / Kind table 的角色分工**:
- **Code REGISTRY**:提供 PhysicsOp 實作(`abcd_lens`、`jones_polarizer`、`diffract_aom`...);UI 不能新增,要 PR 改 code
- **DB `kinds`**:提供 kind metadata(display name、defaultParams、faceTemplate);UI 在 PHY Editor → 🔧 Binding dev → Kinds tab 做 CRUD;新 row 要選一個 code 端註冊過的 `op_set_name`
- **Asset3D 仍是固化的**:建好後它的 faces/transitions/default_params 都存自己一份,改 kinds row 不會回頭動已建好的 Asset3D(避免遠端追溯改 production scene)
- **新增「真正新物理」的流程**:(1) 在 code 加 PhysicsOp + register;(2) UI 開 Kinds tab → 新增一個 row,opSetName 選新註冊的那個

---

## 6.5 RF Signal Model(RF tracer 的 ray 等價物)

RF 元件不走 ray tracer(沒有 wavefront、沒有 Jones vector、沒有 q-parameter)。RF tracer 用一個更窄的 data type `RfSignalState` 在 graph 上傳遞:

```typescript
type RfSignalState = {
  frequencyMhz: number                    // 載波頻率(單音;modulation 預留未來)
  vpp: number                             // peak-to-peak voltage,假設 50 Ω 負載
  cumulativeGainDb: number                // 從 source 累計到當前 port 的增益(可 < 0)
  saturated: boolean                      // 是否在沿途任一 amp 撞到 outputPowerMaxDbm clamp
  sourceObjectId: string                  // 起源 rf_source SceneObject id
  sourceAnchorName: string                // 起源 anchor name(AD9959 的 "CH0"~"CH3")
  passthroughObjectIds: string[]          // 沿途經過的 SceneObject id(用於 debug + 防 loop)
  // phase / modulation envelope 是 Phase RF.6 開放欄位,目前不存
}

type RfPhysicsOp = (
  incoming: RfSignalState,
  faceIn: Face,
  faceOut: Face,
  params: KindParams,
  ctx: RfTraceContext                     // switch_ttl_states / powered_off_object_ids 等 pre-pass 結果
) => Array<{ outAnchorName: string; outgoing: RfSignalState }> | null
//   null  = signal terminated(power gate、unbound PPG)
//   []    = ambiguous(SP4T+ 在 LOW state 無 active throw)
//   [x..] = 一個或多個輸出 anchor(rf_switch 雖有 N throws,只 active 一個)
```

**單位約定(前/後端 parity 強制)**:
- `AD9959_VPP_FULL_SCALE = 1.0 V`(AD9959 滿幅輸出進 50 Ω)
- `RF_LOAD_Z_OHM = 50`(所有 dBm ↔ Vpp 轉換的硬性假設)
- `P_w = Vpp² / (8 × Z)`、`Vpp = √(8 × Z × P_w)`、`P_w = 10^((dBm − 30) / 10)`

**與光學 BeamRay 的對照**:

| 概念 | 光學 | RF |
|------|------|----|
| 載體 | BeamRay(origin, dir, λ, jones, q, power) | RfSignalState(freq, vpp, gain, ...) |
| 命中判定 | rayPlaneIntersect(face) + aperture | port-adjacency map(cable endpoint 預先建好) |
| Source | `emit_laser_source` 從 dynamicSources 讀 power | `emit_rf_source` 從 dynamicSources.channels[] 讀 freq + amp |
| Sink | beam_dump、detector | horn_antenna、aom.rf_in |
| 多輸出 | beamsplitter / AOM diffraction orders | rf_switch active throw(同時只一條) |
| Power gate | (尚無對應機制) | `powered_off_object_ids` → op return null |

**State 不存任何地方**:跟光學一樣,每次 solve 重新走 BFS 算出每個 RF port 的 `RfSignalState`,不快取。

---

## 7. Ray Tracer 運作流程

不再認 `elementKind` 字串。流程如下:

```
loop until ray escapes / absorbed / power < threshold:

  1. ray = (origin_lab, dir_lab, λ, jones, power)

  2. For each SceneObject in scene:
       pose = sceneObjectToQuaternion(sceneObject) ⊗ T(xMm,yMm,zMm)
       ray_comp = pose⁻¹ · ray

       For each ComponentBinding in component.bindings:
         sub_pose = local_pose(binding) ⊕ objectBinding_delta(binding)
         ray_asset = sub_pose⁻¹ · ray_comp

         For each Face in asset.faces:
           hit = rayPlaneIntersect(ray_asset, face)
           if hit and within aperture:
             collect (sceneObject, binding, face, distance)

  3. 取最近的命中 (so, bnd, faceIn, t)

  4. 查 asset.transitions 找 in = faceIn:
       對每個匹配的 transition:
         params = asset.defaultParams
                  ⊕ paramOverrides[binding.bindingId]
                  ⊕ transition.params
         dynamic = sceneObject.dynamicSources
         out_rays = transition.op(rayAtFace, faceIn, faceOut, params, dynamic)

  5. 把 out_rays 轉回 lab frame, push 進 queue
```

**重點**:
- 沒有 `switch (elementKind) { case "mirror": ... }`
- Kind 字串只在 PhysicsOp 內部使用(該 op 知道自己是 jones 還是 abcd)
- 多階輸出(AOM、beamsplitter)由 `out_rays[]` 自然支援

---

## 7.5 RF Tracer 運作流程(graph BFS,非 ray tracing)

RF 元件不做 ray-plane intersection。RF tracer 在「port adjacency graph」上做 BFS,規則對應 §6.5 的 `RfSignalState`。

```
pre-pass A — 建 port adjacency map:
  for each rf_cable SceneObject:
      endpoints = sceneObject.properties.rfCableEndpoints  // { A: {objectId, anchorName}, B: ... }
      adjacency[endpoints.A] += endpoints.B
      adjacency[endpoints.B] += endpoints.A
  (cable 不走 rf_links 表 — 簡化編輯 UX;其他 RF 連線都走 rf_links 表)
  for each rf_link in rf_links:
      adjacency[(from_obj, from_port)] += (to_obj, to_port)
      adjacency[(to_obj, to_port)] += (from_obj, from_port)

pre-pass B — 解析所有 rf_switch 的 TTL state:
  for each rf_switch SceneObject sw:
      peer = adjacency.lookupOneHop(sw, "ttl_in")
      if peer is programmable_pulse_generator with bound timingProgramId:
          program = fetchTimingProgram(peer.timingProgramId)
          switch_ttl_states[sw.id] = program.rest_state  // "HIGH" | "LOW"
      else:
          switch_ttl_states[sw.id] = sw.kindParams.ttlState  // manual fallback

seed — 從每個 rf_source 注入:
  for each rf_source SceneObject src:
      if src.id in powered_off_object_ids: continue
      for each out_anchor in src.asset.faces where domain == "rf":
          channel = src.dynamicSources.channels.find(c => c.anchorName == out_anchor.name)
                  ?? defaults(80 MHz, amplitudeScale=1.0)
          signal = RfSignalState(
              frequencyMhz = channel.frequencyMhz,
              vpp = channel.amplitudeScale × AD9959_VPP_FULL_SCALE,
              cumulativeGainDb = 0,
              saturated = false,
              sourceObjectId = src.id,
              sourceAnchorName = out_anchor.name,
              passthroughObjectIds = []
          )
          enqueue((src.id, out_anchor.name), signal)

BFS — 走訪到 sink:
  while queue:
      (portKey, signal) = dequeue()
      for peer in adjacency[portKey]:
          if (peer.objectId, peer.anchorName) already visited: continue   // first-arrival 勝
          signalAtPort[(peer.objectId, peer.anchorName)] = signal
          
          op = REGISTRY[peer.kind].rfOps[peer.transitionForIncoming(peer.anchorName)]
          if op is None: continue   // sink — 不再往下傳(AOM rf_in、horn_antenna.aperture)
          
          outputs = op(signal, faceIn, faceOut, peer.params, ctx)
          if outputs is None: continue   // power gate / unbound PPG → 訊號終止
          if outputs == []: continue     // SP4T+ LOW 無 active → 此分支空
          for { outAnchorName, outgoing } in outputs:
              enqueue((peer.objectId, outAnchorName), outgoing)
```

**Sink 們**:`aom.rf_in`、`horn_antenna.aperture`、任何 kind 沒在 RF registry 註冊 op 的 face。

**Power gate**(`powered_off_object_ids`,跟 `lab_power_panel.md` 規則一致):
- `rf_source` 在 gate 中:不 emit
- `rf_amplifier` 在 gate 中:op return null(無 DC bias → 訊號終止,不只是 unity gain)
- `rf_switch` 在 gate 中:op return null(無偏壓 → 無 active throw)
- 對應到 AOM 的下游影響:`signalAtPort[(aom.id, "rf_in")]` 變 undefined → AOM efficiency = 0 → beam 走 0th order

**重點**:
- 跟 ray tracer 一樣,**沒有 `switch (elementKind)` dispatch**;peer 的 kind 只用來去 registry 查 op
- 跟 ray tracer 不同:**沒有 ray-plane intersection**,連線是 explicit graph edges(cable endpoints + rf_links)
- AOM 是 hybrid:在 ray tracer 看是 optical 元件(face A → face B,diffract op),同時在 RF tracer 看是 sink(rf_in 拿到 RfSignalState 後注入 AOM physics op 的 `ctx.dynamic`)— 詳見 §14

---

## 8. 範例:用新模型實作 13 種元件(7 optical + 6 RF)

### 8.0 Laser Source(scene emitter)

```json
{
  "id": "generic_780nm_gaussian_laser",
  "kind": "laser_source",
  "faces": [
    { "id": "out", "positionMmBodyLocal": {"x":0,"y":0,"z":0},
      "normalBodyLocal": {"x":0,"y":0,"z":1},
      "apertureMm": 1.0, "apertureShape": "circle" }
  ],
  "transitions": [
    { "in": "out", "out": "out", "op": "emit_laser_source" }
  ],
  "defaultParams": {
    "centerWavelengthNm": 780.241,
    "nominalPowerMw": 50,
    "spatialModeX": { "waistUm": 250, "waistZOffsetMm": 0, "mSquared": 1.05 },
    "spatialModeY": { "waistUm": 80, "waistZOffsetMm": 1.2, "mSquared": 1.30 },
    "polarization": { "exRe": 1, "exIm": 0, "eyRe": 0, "eyIm": 0 }
  }
}
```

Laser source 是 **scene emitter**,不是等 beam 撞到才作用的 passive element。
`out.normalBodyLocal` 定義出光方向。若 `/api/v3/solver/run` 沒有收到
`initialRays`,solver 會從 scene 內的 `laser_source` object 自動產生 initial
beam。`SceneObject.dynamicSources` 可覆寫 `centerWavelengthNm`,
`laserPowerMw` / `powerMw`, `polarization`, `spatialModeX/Y`。

Current scene object contract for `LASER_SOURCE0`:

- `Component.catalogId = "dbr_852_tosa_high_power"`.
- Component binding `source` points to Asset3D
  `dbr_852_tosa_high_power_laser_source`.
- Asset3D `kind = "laser_source"`, face `out` is positioned on the DBR TOSA
  output aperture and points along body-local `+x`.
- Transition is `{ "in": "out", "out": "out", "op": "emit_laser_source" }`.
- Live beam values (`powerMw`, `spectrum`, `polarization`,
  `spatialEnvelope`, `transverseMode`) live on
  `SceneObject.dynamicSources`. The old
  `SceneObject.properties.opticalSources[]` may remain as a compatibility
  mirror, but it is not the v3 source of truth.

### 8.1 Lens(最簡單,1 個 transition)

```json
{
  "id": "thorlabs_lb1471_a",
  "kind": "lens",
  "geometryRef": "thorlabs/LB1471-A.glb",
  "faces": [
    { "id": "A", "positionMmBodyLocal": {"x":0,"y":0,"z":-1.5}, "apertureMm": 12.7, "apertureShape": "circle" },
    { "id": "B", "positionMmBodyLocal": {"x":0,"y":0,"z":+1.5}, "apertureMm": 12.7, "apertureShape": "circle" }
  ],
  "transitions": [
    { "in": "A", "out": "B", "op": "abcd_thin_lens" }
  ],
  "defaultParams": { "focalLengthMm": 50, "ar_coating_band_nm": [350, 700] },
  "wavelengthRangeNm": [350, 700]
}
```

PhysicsOp `abcd_thin_lens`:接 ray、套 [[1,0],[-1/f,1]],出射在 face B 中央。

### 8.2 Mirror(同面進出)

```json
{
  "id": "thorlabs_pf10-03-p01",
  "kind": "mirror",
  "faces": [
    { "id": "A", "positionMmBodyLocal": {"x":0,"y":0,"z":0},
      "normalBodyLocal": {"x":0,"y":0,"z":1},
      "apertureMm": 12.7, "apertureShape": "circle" }
  ],
  "transitions": [
    { "in": "A", "out": "A", "op": "reflect_specular" }
  ],
  "defaultParams": { "reflectivity": 0.99 }
}
```

PhysicsOp `reflect_specular`:`d' = d - 2(d·n)n`,出射還是 face A。

### 8.3 Polarizer(jones)

```json
{
  "id": "thorlabs_lpvisa050",
  "kind": "polarizer",
  "faces": [
    { "id": "A", "positionMmBodyLocal": {"x":0,"y":0,"z":-1.5}, "apertureMm": 12.5 },
    { "id": "B", "positionMmBodyLocal": {"x":0,"y":0,"z":+1.5}, "apertureMm": 12.5 }
  ],
  "transitions": [
    { "in": "A", "out": "B", "op": "jones_polarizer" }
  ],
  "defaultParams": { "transmissionAxisDegBodyLocal": 0, "extinctionDb": 30 }
}
```

注意:`transmissionAxisDegBodyLocal: 0` 表示透射軸沿 **+x**。要把 polarizer 安裝成 45°,**不改 asset**,改 ComponentBinding 的 `local_rz_deg = 45`(以下 Isolator 範例)。

### 8.4 AOM(RF 驅動繞射)

```json
{
  "id": "aa_mt110-a1-1064",
  "kind": "aom",
  "faces": [
    { "id": "A", "positionMmBodyLocal": {"x":0,"y":0,"z":-25}, "normalBodyLocal": {"x":0,"y":0,"z":-1}, "apertureMm": 1.0 },
    { "id": "B", "positionMmBodyLocal": {"x":0,"y":0,"z":+25}, "normalBodyLocal": {"x":0,"y":0,"z":+1}, "apertureMm": 1.0 }
  ],
  "transitions": [
    { "in": "A", "out": "B", "op": "diffract_aom", "params": { "order": 1 } },
    { "in": "B", "out": "A", "op": "diffract_aom", "params": { "order": -1 } }
  ],
  "defaultParams": {
    "acousticVelocityMps": 4200,
    "crystalLengthMm": 1.6,
    "baseEfficiency": 0.85,
    "centerFreqMhz": 110,
    "rfPropagationDirectionBodyLocal": [1, 0, 0],
    "requiresRfDrive": true
  }
}
```

幾何規則:
- `A` and `B` are the physical optical surfaces. Do not duplicate them as `A1/B1/A2/B2` just to encode direction.
- RF is not an optical face; it is a body-local vector: `rfPropagationDirectionBodyLocal`.
- `rfPropagationDirectionBodyLocal` must be perpendicular to the physical `A -> B` optical axis.

PhysicsOp `diffract_aom` 接 ray + `dynamicSources` 中的 RF signal:
- `SceneObject.dynamicSources.aomFreqMhz` / `rfFrequencyMhz` drive the Bragg angle.
- `SceneObject.dynamicSources.rfDrivePowerW` / `aomRfVpp` drive diffraction efficiency.
- The selected diffraction branch is carried by transition `params.order`.
- q propagation is slab-like: `q_out = q_in + L/n`.

### 8.5 Isolator IO-3-850-HP(複合 Component,5 個子 Asset)

**Canonical A/B rule**: faces are physical surfaces. Direction and non-reciprocity live in directed transitions, not in duplicated face IDs.

**5 個 Asset3D**(3 個光學 + 2 個機械):

```yaml
# Glan-Laser polarizer(被引用 2 次)
thorlabs_glan_laser_gl10:
  kind: polarizer
  faces:
    - A @ (0,0,-7.5)
    - B @ (0,0,+7.5)
  transitions:
    - { in:"A", out:"B", op:"jones_polarize_p" }
    - { in:"B", out:"A", op:"jones_polarize_p" }

# Faraday rotator 核心
thorlabs_io_3_850_faraday:
  kind: faraday_rotator
  faces: [A@(0,0,-15), B@(0,0,+15)]
  transitions:
    - { in:"A", out:"B", op:"faraday_rotate", abcd:[[1,L/n],[0,1]] }
    - { in:"B", out:"A", op:"faraday_rotate", abcd:[[1,L/n],[0,1]] }
  defaultParams: { rotationDeg: 45, reciprocal: false }

# 3 個機械殼(無 kind / faces / transitions)
thorlabs_io_3_850_input_housing:   { mechanicalAnchors: [...] }
thorlabs_io_3_850_faraday_housing: { mechanicalAnchors: [...] }
thorlabs_io_3_850_output_housing:  { mechanicalAnchors: [...] }
```

**Component**(綁 5 個 Asset3D + 2 個對外端口):

```json
{
  "id": "thorlabs_io_3_850_hp",
  "bindings": [
    { "bindingId":"input_pol",       "assetId":"thorlabs_glan_laser_gl10",       "local_z_mm":-18, "local_rz_deg":0 },
    { "bindingId":"input_housing",   "assetId":"thorlabs_io_3_850_input_housing","local_z_mm":-18 },
    { "bindingId":"faraday",         "assetId":"thorlabs_io_3_850_faraday",      "local_z_mm":0 },
    { "bindingId":"faraday_housing", "assetId":"thorlabs_io_3_850_faraday_housing","local_z_mm":0 },
    { "bindingId":"output_pol",      "assetId":"thorlabs_glan_laser_gl10",       "local_z_mm":+18, "local_rz_deg":45 },
    { "bindingId":"output_housing",  "assetId":"thorlabs_io_3_850_output_housing","local_z_mm":+18 }
  ],
  "exposedFaces": [
    { "componentFaceId":"optical_in",  "assetBindingId":"input_pol",  "assetFaceId":"A" },
    { "componentFaceId":"optical_out", "assetBindingId":"output_pol", "assetFaceId":"B" }
  ]
}
```

**Isolator 行為從 ray tracer 自然湧現**:
- Forward: `input_pol.A -> faraday.A -> output_pol.A`. The output polarizer binding is rotated 45 deg, so it transmits the Faraday-rotated beam.
- Reverse: `output_pol.B -> faraday.B -> input_pol.B`. The Faraday op adds another same-signed 45 deg, so the returning polarization is blocked by the input polarizer.

**沒有任何 `isolator-specific` 程式碼**。

### 8.6 PBS(4 port,8 transitions)

PBS cube 有 4 個 outer face(back/front/left/right),每 face 同時是某些 transition 的入口、某些 transition 的出口。**斜面物理在 op 內部,不需要 first-class face**。

```json
{
  "id": "thorlabs_pbs252",
  "kind": "pbs",
  "geometryRef": "files/stl/thorlabs_pbs252.stl",
  "faces": [
    { "id":"back",  "positionMmBodyLocal":{"x":0,"y":0,"z":-d/2}, "normalBodyLocal":{"x":0,"y":0,"z":-1}, "apertureMm":12.5, "apertureShape":"rectangle" },
    { "id":"front", "positionMmBodyLocal":{"x":0,"y":0,"z":+d/2}, "normalBodyLocal":{"x":0,"y":0,"z":+1}, "apertureMm":12.5, "apertureShape":"rectangle" },
    { "id":"right", "positionMmBodyLocal":{"x":+d/2,"y":0,"z":0}, "normalBodyLocal":{"x":+1,"y":0,"z":0}, "apertureMm":12.5, "apertureShape":"rectangle" },
    { "id":"left",  "positionMmBodyLocal":{"x":-d/2,"y":0,"z":0}, "normalBodyLocal":{"x":-1,"y":0,"z":0}, "apertureMm":12.5, "apertureShape":"rectangle" }
  ],
  "transitions": [
    { "in":"back",  "out":"front", "op":"pbs_transmit_p", "abcd":[[1,"d/n"],[0,1]] },
    { "in":"back",  "out":"right", "op":"pbs_reflect_s",  "abcd":[[1,"d/n"],[0,1]] },
    { "in":"front", "out":"back",  "op":"pbs_transmit_p", "abcd":[[1,"d/n"],[0,1]] },
    { "in":"front", "out":"left",  "op":"pbs_reflect_s",  "abcd":[[1,"d/n"],[0,1]] },
    { "in":"right", "out":"back",  "op":"pbs_reflect_s",  "abcd":[[1,"d/n"],[0,1]] },
    { "in":"right", "out":"left",  "op":"pbs_transmit_p", "abcd":[[1,"d/n"],[0,1]] },
    { "in":"left",  "out":"front", "op":"pbs_reflect_s",  "abcd":[[1,"d/n"],[0,1]] },
    { "in":"left",  "out":"right", "op":"pbs_transmit_p", "abcd":[[1,"d/n"],[0,1]] }
  ],
  "defaultParams": { "extinctionRatioPpDb": 30, "extinctionRatioSpDb": 20, "cubeSize_mm": 12.5, "refractiveIndex": 1.5168 }
}
```

**Ray tracer 行為**:ray 從 back 入射,**同時**觸發 `back→front`(transmit_p)與 `back→right`(reflect_s)兩個 transition,共產生 2 條輸出 ray。各 op 內部做 Jones 投影(`J_p = diag(1,0)`、`J_s = diag(0,1)`)。

### 8.7 RF Source(AD9959 DDS,scene emitter)

對應 `laser_source`,但發 RF 訊號而非 BeamRay。

```json
{
  "id": "ad9959_pcbz_dds",
  "kind": "rf_source",
  "geometryRef": "analog_devices/AD9959_PCBZ.glb",
  "faces": [
    { "id": "rf_out", "name": "CH0", "domain": "rf",
      "positionMmBodyLocal": {"x":82.55,"y":-30,"z":4},
      "normalBodyLocal": {"x":1,"y":0,"z":0},
      "apertureMm": 0, "apertureShape": "circle" },
    { "id": "rf_out", "name": "CH1", "domain": "rf",
      "positionMmBodyLocal": {"x":82.55,"y":-10,"z":4},
      "normalBodyLocal": {"x":1,"y":0,"z":0},
      "apertureMm": 0, "apertureShape": "circle" },
    { "id": "rf_out", "name": "CH2", "domain": "rf",
      "positionMmBodyLocal": {"x":82.55,"y":10,"z":4},
      "normalBodyLocal": {"x":1,"y":0,"z":0},
      "apertureMm": 0, "apertureShape": "circle" },
    { "id": "rf_out", "name": "CH3", "domain": "rf",
      "positionMmBodyLocal": {"x":82.55,"y":30,"z":4},
      "normalBodyLocal": {"x":1,"y":0,"z":0},
      "apertureMm": 0, "apertureShape": "circle" }
  ],
  "transitions": [
    { "in": "rf_out", "out": "rf_out", "op": "emit_rf_source" }
  ],
  "defaultParams": {
    "referenceClockMhz": null,
    "sysClockMhz": null,
    "pllMultiplier": 25,
    "pllBypass": false,
    "serialInterface": "SPI",
    "syncRole": "standalone",
    "serialPortMode": "4wire"
  }
}
```

`emit_rf_source` 從 `SceneObject.dynamicSources.channels[]` 找 matching `anchorName`(CH0~CH3),讀其 `frequencyMhz` + `amplitudeScale`,輸出對應 `RfSignalState`。沒給 channels → fallback 到 `dynamicSources.frequencyMhz` + `powerDbm`(legacy 單音);還沒給 → 用 80 MHz / 1.0 V scale 預設。

`SceneObject.dynamicSources` 可覆寫的欄位:
- `channels: { anchorName, frequencyMhz, amplitudeScale (0-1), phase, sweepParams }[]`
- `frequencyMhz`(legacy 單音)、`powerDbm`(legacy)、`phaseDeg`、`modulation`("none" 暫時固定)

注意 4 個 face 共用 `id = "rf_out"`,用 `name` 區分 — 跟 §8.6 PBS 的多 face 是同套機制,只是 PBS 用不同 id(`back/front/...`)是因為各面物理角色不同;AD9959 四個通道物理對等,所以共用 id + 不同 name。

### 8.8 RF Amplifier(passthrough,單向)

```json
{
  "id": "minicircuits_zhl_1_2w_plus",
  "kind": "rf_amplifier",
  "geometryRef": "minicircuits/ZHL-1-2W+.glb",
  "faces": [
    { "id": "rf_in",  "domain": "rf",
      "positionMmBodyLocal": {"x":0,"y":0,"z":-30},
      "normalBodyLocal": {"x":0,"y":0,"z":-1},
      "apertureMm": 0, "apertureShape": "circle" },
    { "id": "rf_out", "domain": "rf",
      "positionMmBodyLocal": {"x":0,"y":0,"z":+30},
      "normalBodyLocal": {"x":0,"y":0,"z":+1},
      "apertureMm": 0, "apertureShape": "circle" }
  ],
  "transitions": [
    { "in": "rf_in", "out": "rf_out", "op": "rf_amplify" }
  ],
  "defaultParams": {
    "gainDb": 29,
    "frequencyRangeMhz": [5, 500],
    "outputPowerP1dbDbm": 29,
    "outputPowerMaxDbm": 30,
    "inputPowerMaxDbm": 0,
    "noiseFigureDb": 9,
    "supplyVoltageV": 24,
    "supplyCurrentA": 0.6,
    "inputReturnLossDb": 14,
    "outputReturnLossDb": 14,
    "connectorType": "sma"
  }
}
```

**RfPhysicsOp `rf_amplify`**:
```
if object.id in powered_off_object_ids: return null   // 無 DC bias → 訊號終止
vpp_out  = vpp_in × 10^(gainDb / 20)
vpp_max  = √(8 × 50 × 10^((outputPowerMaxDbm − 30) / 10))
saturated = (vpp_out > vpp_max)
vpp_out  = min(vpp_out, vpp_max)
return [{
  outAnchorName: "rf_out",
  outgoing: { ...incoming, vpp: vpp_out,
              cumulativeGainDb: incoming.cumulativeGainDb + gainDb,
              saturated, passthroughObjectIds: [...incoming.passthroughObjectIds, object.id] }
}]
```

**沒有 dynamic sources** — 所有參數都是 spec sheet,catalog 一次寫死。

### 8.9 RF Cable(passthrough,**雙向**)

```json
{
  "id": "primitive_thorlabs_ca2906_cable",
  "kind": "rf_cable",
  "geometryRef": "primitive://sma_short_cable",
  "faces": [
    { "id": "rf_in",  "domain": "rf",
      "positionMmBodyLocal": {"x":0,"y":0,"z":-76.2},
      "normalBodyLocal": {"x":0,"y":0,"z":-1},
      "apertureMm": 0, "apertureShape": "circle" },
    { "id": "rf_out", "domain": "rf",
      "positionMmBodyLocal": {"x":0,"y":0,"z":+76.2},
      "normalBodyLocal": {"x":0,"y":0,"z":+1},
      "apertureMm": 0, "apertureShape": "circle" }
  ],
  "transitions": [
    { "in": "rf_in",  "out": "rf_out", "op": "rf_pass" },
    { "in": "rf_out", "out": "rf_in",  "op": "rf_pass" }
  ],
  "defaultParams": {
    "lengthMm": 152.4,
    "impedanceOhm": 50,
    "maxFrequencyGhz": 3.0,
    "connectorType": "sma",
    "endAConnector": "sma",
    "endBConnector": "sma",
    "cableType": "RG-316",
    "jacketOuterDiameterMm": 3.2,
    "jacketColor": "#c4a884",
    "workingVoltageVRms": null,
    "dielectricVoltageVRms": null,
    "minBendRadiusMm": 15
  }
}
```

**Op `rf_pass`** 目前為 identity(不套衰減);未來可改成 `vpp × 10^(-lossDbPerM × lengthMm / 1000 / 20)`。

**特殊性 — cable 的端點不存在 `rf_links` 表**:
- 一般 RF 連線(amp ↔ switch ↔ AOM)走 `rf_links` 表(directed graph,from/to objectId + anchorName)
- **Cable 端點**存在 `SceneObject.properties.rfCableEndpoints = { A: {objectId, anchorName}, B: {objectId, anchorName} }`
- 理由:cable 編輯 UX(拖端點到不同連接器、改長度)只動 SceneObject,不用同步 link 表
- §7.5 RF tracer 的 pre-pass A 把這兩種來源合成同一個 port adjacency map

**異接頭轉接 cable**(SMA↔BNC 等)用 `endAConnector` ≠ `endBConnector` 表達;UI 渲染時各端點用對應 GLB primitive。

### 8.10 RF Switch(SP2T,TTL 控制,**多 out face**)

```json
{
  "id": "minicircuits_zyswa_2_50dr",
  "kind": "rf_switch",
  "geometryRef": "minicircuits/ZYSWA-2-50DR.glb",
  "faces": [
    { "id": "rf_in",  "name": "RFIN", "domain": "rf",
      "positionMmBodyLocal": {"x":-25,"y":0,"z":0},
      "normalBodyLocal": {"x":-1,"y":0,"z":0},
      "apertureMm": 0, "apertureShape": "circle" },
    { "id": "rf_out", "name": "RF1",  "domain": "rf",
      "positionMmBodyLocal": {"x":+25,"y":-10,"z":0},
      "normalBodyLocal": {"x":+1,"y":0,"z":0},
      "apertureMm": 0, "apertureShape": "circle" },
    { "id": "rf_out", "name": "RF2",  "domain": "rf",
      "positionMmBodyLocal": {"x":+25,"y":+10,"z":0},
      "normalBodyLocal": {"x":+1,"y":0,"z":0},
      "apertureMm": 0, "apertureShape": "circle" },
    { "id": "ttl_in", "name": "TTL",  "domain": "ttl",
      "positionMmBodyLocal": {"x":0,"y":+25,"z":0},
      "normalBodyLocal": {"x":0,"y":+1,"z":0},
      "apertureMm": 0, "apertureShape": "circle" }
  ],
  "transitions": [
    { "in": "rf_in", "out": ["rf_out:RF1", "rf_out:RF2"], "op": "rf_switch_route" }
  ],
  "defaultParams": {
    "switchType": "SP2T",
    "throwCount": 2,
    "frequencyMinGhz": 0,
    "frequencyMaxGhz": 5,
    "insertionLossDb": 1,
    "isolationDb": 35,
    "switchingTimeNs": 250,
    "absorptionType": "absorptive",
    "controlLogic": "TTL",
    "controlVoltageHighV": 5,
    "supplyPositiveV": 5,
    "supplyNegativeV": -5,
    "supplyCurrentMa": 25,
    "maxInputPowerDbm": 27,
    "connectorType": "sma",
    "ttlActiveHighThrow": 2,
    "ttlState": "LOW"
  }
}
```

**RfPhysicsOp `rf_switch_route`**:
```
if object.id in powered_off_object_ids: return null
state = ctx.switch_ttl_states[object.id] ?? params.ttlState
high  = params.ttlActiveHighThrow      // e.g. 2
if state == "HIGH":      active = high
elif params.throwCount == 2:  active = (3 - high)    // SPDT 的另一個
else:                    return []                   // SP4T+ LOW 無法解 → 無 active path
target_anchor_name = `RF${active}`                   // "RF1" or "RF2"
vpp_out = vpp_in × 10^(-insertionLossDb / 20)
return [{
  outAnchorName: target_anchor_name,
  outgoing: { ...incoming, vpp: vpp_out,
              cumulativeGainDb: incoming.cumulativeGainDb - insertionLossDb }
}]
```

**注意 transition `out` 是 array** — 這個用法跟 §8.6 PBS(同一 in face 對應多個 transition row)不同。Switch 用 array 表達「**邏輯上**多個可能 out,但 op runtime 只 active 一個」;PBS 用多 row 表達「**同時** active 多個 out」。兩種寫法都被 Asset3D schema(§3 `out: string | string[]`)允許。

`ttl_in` 的 `domain: "ttl"` 確保 UI 在拖線時只接受 PPG 的 `rf_out`(雖然命名是 `rf_out`,該 face 在 §8.11 標 `domain: "ttl"`)。

### 8.11 Programmable Pulse Generator(TTL emitter,**綁 TimingProgram**)

```json
{
  "id": "programmable_pulse_generator_sma",
  "kind": "programmable_pulse_generator",
  "geometryRef": "qmem/programmable_pulse_generator_sma.glb",
  "faces": [
    { "id": "rf_out", "domain": "ttl",
      "positionMmBodyLocal": {"x":0,"y":0,"z":+15},
      "normalBodyLocal": {"x":0,"y":0,"z":+1},
      "apertureMm": 0, "apertureShape": "circle" }
  ],
  "transitions": [
    { "in": "rf_out", "out": "rf_out", "op": "emit_ttl_steady" }
  ],
  "defaultParams": {
    "connectorType": "sma",
    "timingProgramId": null,
    "outputDomain": "ttl",
    "highVoltageV": 3.2
  }
}
```

**RfPhysicsOp `emit_ttl_steady`**:
```
if params.timingProgramId is null: return null    // unbound — 無輸出
program = fetchTimingProgram(params.timingProgramId)
level   = program.rest_state                       // "HIGH" | "LOW"
return [{
  outAnchorName: "rf_out",
  outgoing: { frequencyMhz: 0, vpp: (level == "HIGH" ? params.highVoltageV × 2 : 0),
              cumulativeGainDb: 0, saturated: false,
              sourceObjectId: object.id, sourceAnchorName: "rf_out",
              passthroughObjectIds: [] }
}]
```

**命名警告**:該 face `id = "rf_out"` 是為了跟 RF tracer 共用 port lookup,但 `domain = "ttl"`,**不是 RF**。連線編輯器以 `domain` enforce 相容性。

**為什麼動態 timeline 不影響 solver**:PPG 的 TimingProgram 在 scrub UI 上有完整 pulse train,但 solver 只看 `rest_state`(steady-state idle level)— 因為 solver 是 quasi-static,不模擬 ns 級時序。Time-domain 模擬留給 Phase RF.6(或外部 SPICE)。

### 8.12 Horn Antenna(RF sink,對應 beam_dump)

```json
{
  "id": "generic_horn_9_2ghz",
  "kind": "horn_antenna",
  "geometryRef": "generic/horn_antenna.glb",
  "faces": [
    { "id": "aperture", "domain": "rf",
      "positionMmBodyLocal": {"x":0,"y":0,"z":+50},
      "normalBodyLocal": {"x":0,"y":0,"z":+1},
      "apertureMm": 0, "apertureShape": "circle" }
  ],
  "transitions": [],
  "defaultParams": {
    "frequencyGhz": 9.2,
    "gainDbi": 12,
    "beamwidth3dbDeg": 30,
    "polarAxisBodyLocal": [0, 0, 1],
    "cosineExponent": 8
  }
}
```

**`transitions = []`** — 沒有任何 op,訊號到達 `aperture` 後 BFS 停下(等價於 `beam_dump` 在 ray tracer 的角色)。`signalAtPort[(horn.id, "aperture")]` 保留,UI 可顯示「horn 收到的 RF 功率」。Phase RF.7 會加 cos^n lobe 視覺化 + Palace farfield S-parameter import。

---

## 9. 與現狀對照表

| 現狀欄位 / 概念 | 新模型欄位 | 備註 |
|---------------|----------|------|
| `Component.kind` | `Asset3D.kind` | 物理下放(optical + RF 共用) |
| Asset anchor `optical_anchor.directionBodyLocal` | Asset3D Face `normalBodyLocal` + 約定 +z | mirror 法向 |
| Asset anchor `optical_in/out.positionMmBodyLocal` | `Asset3D.faces[*].positionMmBodyLocal` | 重命名收緊 |
| `kindParams.rfPropagationDirectionBodyLocal`(AOM) | AOM `faces[id="rf_in"].normalBodyLocal` | §14.1 升級成 face 法向 |
| `kindParams.acousticAxisBodyLocal` | 同上 | 廢除冗餘欄位 |
| `Component.kindParams` | `Asset3D.defaultParams` | per-asset 預設 |
| `Asset.anchor.fastAxisDegBodyLocal` | `Asset3D.defaultParams.fastAxisDeg` + 約定 +x base | 純角度 |
| `SceneObject.properties.kindParamOverride` | `SceneObject.paramOverrides[bindingId]` | per-binding 範圍 |
| `SceneObject.properties.{laserPowerMw,...}` | `SceneObject.dynamicSources` | 集中 |
| Mechanical anchors(mount face, edge) | `Asset3D.mechanicalAnchors` | 不變 |
| V2 `opticalSurface` binding | 移除,by face | V1/V2 雙路徑廢除 |
| `derivedFromFiberEndpoint` | Face 上加 `derivedFrom: "fiber_node:A"` | 動態端點機制保留但移到 Face |
| Anchor `rf_in/rf_out/ttl_in`(現有 RF kinds) | `Asset3D.faces[*]` with `domain ∈ {"rf","ttl"}` | §3 face schema 擴充 |
| `rf_chain_nodes` 表(linear chain) | `rf_links` graph + RF tracer 算 cumulativeGainDb | §10 Phase RF.5 廢除 |
| `SceneObject.properties.rfCableEndpoints` | 維持,或併入 `rf_links`(§10 Phase RF.4 二選一) | UX 取捨 |
| `SceneObject.dynamicSources.{aomFreqMhz, aomRfVpp}`(手填) | RF tracer hydration(§14.3),手填變 override | §10 Phase RF.6 |

---

## 10. 遷移路徑(分階段,每階段可獨立 ship)

### Phase 0:設計凍結
- 本文件 review、open questions 收斂
- 鎖定 schema 版本 v3(現行為 v2)

### Phase 1:Kind Registry 新增
- 在 `frontend/src/optical/kinds/registry.ts` + `backend/app/optical/kinds/registry.py` 註冊 PhysicsOp 與 face 範本
- 不動既有資料,只是平行存在的新模組
- 寫 vitest 覆蓋每個 PhysicsOp 的單元行為

### Phase 2:Asset3D schema 並存
- DB 加 `faces JSON`、`transitions JSON`、`kind ENUM`、`defaultParams JSON` 欄位
- 既有 `anchors` 欄位保留(不刪)
- 寫 alembic migration:從現有資料 backfill 新欄位
  - `Component.kind` → 對應 Asset3D 加 `kind`
  - Asset anchor `optical_in/out` → `faces`
  - kindParams → `defaultParams`

### Phase 3:Ray tracer 新後端
- 新增 `frontend/src/utils/rayTrace_v3.ts`,完全用 face/transition
- 加 feature flag `useV3RayTracer`
- 跟舊 `rayTrace.ts` 跑 parity test(同場景 → 同 beam path,1e-6 容差)
- 後端 `optical_solver.py` 同步加 v3 path

### Phase 4:逐 kind 切換
- 從 lens 開始(最簡單,1 個 transition),依序:mirror → polarizer → waveplate → faraday → AOM → beamsplitter → fiber_*
- 每個 kind 切完跑全套 vitest + parity test
- 切完後該 kind 的舊 dispatch 程式碼可刪

### Phase 5:Rust spike(WASM 準備)
- 開新 Rust crate `op-core/`,用最簡單的 op(`abcd_thin_lens`)寫 spike
- 加 `wasm-pack` build,前端 import 試水溫
- 不取代 TS+Python,平行存在驗證 toolchain
- 評估 dev iteration 速度、debug 體驗、build 時間

### Phase 6:Rust ops 全面遷移(若 Phase 5 評估通過)
- 把所有 PhysicsOp 逐個翻成 Rust
- 用 PyO3+maturin 生 Python wheel,後端 import
- 砍 TS+Python 舊實作 — parity test 升級為「TS/Python wrapper 對 WASM 結果」一致性測試

### Phase 7:Component 收緊
- 移除 `Component.kind`、`Component.kindParams` 欄位(已遷移到 Asset3D)
- 寫 alembic migration 清理欄位

### Phase 8:SceneObject 收緊
- `properties` 內的 dynamic 欄位搬到 `dynamicSources`
- `properties` 內的 kindParam override 搬到 `paramOverrides`
- 寫 alembic migration

### Phase 9:Frame 約定強制
- 啟動時 runtime assert:每個 optical Asset3D 的 +z 命中至少一個 face
- 不符合 → 在 Asset Editor 顯示 warning + 提示加 `bodyFrameRotation`

### Phase 10:清理
- 刪舊 `anchors` 中的光學項(機械保留)
- 刪 V2 binding 程式碼
- 刪 `kindParams.{rfPropagationDirectionBodyLocal, acousticAxisBodyLocal}` 等舊欄位

---

### RF Migration Track(平行於 Phase 1~10,獨立 ship)

RF tracer 跟 ray tracer 解耦,可以單獨推進。**前置依賴**:Phase 1 的 Kind Registry skeleton(共用 `defaultParams` / face 範本基礎設施)。

#### Phase RF.1:RF Kind Registry + RfSignalState type
- 在 `frontend/src/kinds/_plugins.ts` + `backend/app/kinds_manifest.py` 註冊 6 個 RF kind 範本(face 模板 + defaultParams)
- 定義 `RfSignalState` type(TS + Python),50Ω + `AD9959_VPP_FULL_SCALE` 常數放共用模組
- vitest / pytest 覆蓋每個 op 的單元行為(`rf_amplify`、`rf_switch_route`、`emit_rf_source`、`emit_ttl_steady`、`rf_pass`)
- **現狀**:5 個 kind 已經是這狀態(`rf_source`、`rf_amplifier`、`rf_cable`、`rf_switch`、`programmable_pulse_generator`、`horn_antenna`),只差形式化進 registry

#### Phase RF.2:RF Asset3D face/transition schema 並存
- DB 加 `faces JSON`、`transitions JSON` 到 RF 類的 Asset3D(同 Phase 2 機制)
- Backfill alembic:RF asset 現有 anchor 改寫成 face(domain="rf"/"ttl")+ transition
- 舊 `anchors` 欄位保留

#### Phase RF.3:RF tracer v3(graph BFS)
- 新增 `frontend/src/utils/rfPropagation_v3.ts` + `backend/app/solvers/rf_propagation_v3.py`,完全用 face/transition + RfPhysicsOp
- 跟現有 `rfPropagation.ts` / `rf_propagation.py` parity test(同場景 → 同 signalAtPort,vpp/freq 1e-9 容差)
- Feature flag `useV3RfTracer`

#### Phase RF.4:cable endpoint 模型統一(option A 或 B)
- Option A(保守):維持 `SceneObject.properties.rfCableEndpoints`,只把 §7.5 pre-pass A 形式化
- Option B(激進):cable endpoint 也走 `rf_links` 表,廢除 `rfCableEndpoints` 欄位
- 決定點:UX(端點拖移)能否在純 `rf_links` 模型下保持流暢

#### Phase RF.5:rf_chain_nodes 廢除
- 舊 `rf_chain_nodes` 表(linear chain)所有 reader 改成走 `rf_links` graph
- Chain-summation UI 改用 `signalAtPort[(aom.id, "rf_in")].cumulativeGainDb` 顯示
- alembic 刪表

#### Phase RF.6:AOM hydration(取代 dynamicSources 手填)
- Solver 在執行 AOM `diffract_aom` op 前 hydrate `ctx.dynamic.{aomFreqMhz, aomRfVpp, rfDrivePowerW}` from `signalAtPort[(aom, "rf_in")]`(§14.3)
- 加 override 優先順序 enforce(§14.4)
- 廢除「使用者必須手填 dynamicSources」的 UX,改成 chain 自動算 + 可選 override

#### Phase RF.7:Horn farfield + cable spline
- Horn antenna cos^n lobe 視覺化
- (Option)Palace farfield S-parameter import 取代 cos^n
- Cable spline 編輯(取代直線 cylinder 渲染),配 `lengthMm` 自動算路徑長

#### Phase RF.8:RF frame 約定強制
- Runtime assert:`rf_in.normalBodyLocal ⊥ A→B optical axis`(AOM 專屬)
- Runtime assert:cable 兩端 face `domain` 一致(都是 "rf" 或都是 "ttl",不能跨域)

每個 RF Phase 之間都有 working 系統,可獨立 ship。**RF.6 是 AOM 自動化的關鍵節點**,完成後 AOM 不再需要使用者手填 RF 參數。

---

**每個 Phase 之間都有 working 系統**,任何階段卡住可以退回上一階段。**完整檔案地圖、DB schema、IO-3 遷移實例見 [`asset-physics-implementation.md`](asset-physics-implementation.md)**。

---

## 11. 開放問題

1. **Aperture shape:circle 留還是砍?** 現行 [optical-schema-v2.md §3.3](optical-schema-v2.md) 決定保留 type、PHY Editor 不顯示。新模型沿用此政策。

2. **`Component.kind = "isolator"` 還要不要存在?** 現有 vendor catalog 有 29 條 Thorlabs isolators 帶 `kind=isolator`。建議:**砍掉**,所有 isolator 都用 3-asset Component 表示。**Open question**:有沒有不能拆 3 個 asset 的 isolator 模型?(磁光晶體 + 雙折射 cube,內部多次反射)→ 若有,該 kind 保留但走 single-asset 路線。

3. **fiber 模型:Asset 還是 Component?** 一根 fiber 物理上是「連續介質 + 兩個端點」。建議:**Component**(2 個 fiber_end Asset + 1 個動態 spline)。

4. **PhysicsOp 寫前端還是後端?** 前端要做即時 ray tracing,後端要做權威 solver。兩邊都要實作。建議:**寫一份 spec(輸入輸出向量、容差),前後端各自實作,parity test 強制一致**(已是現狀做法)。

5. **transition 是不是該支援 recursive op?**(例如 etalon 內部多次反射 → 一個 transition 內部跑 loop 然後吐出 transmitted + reflected)目前傾向 **是**,因為 PhysicsOp 已經回傳 `BeamRay[]`,recursive 在 op 內部處理即可,schema 不需要動。

6. **Smart Placement 介面要不要改?** [PLACEMENT_DESIGN.md](PLACEMENT_DESIGN.md) 目前認 anchor。需要把 snap target 邏輯改成認 Face(光學)+ MechAnchor(機械)。建議:Phase 4 之後再處理,避免一次改太多。

7. **Asset Editor UI 怎麼編輯 faces/transitions?** 預設:選了 kind → registry 給出 face/transition 範本 → 使用者只調 face 位置與 aperture。STL/GLB import 後使用者點 CAD 表面 → 浮現半透明黃色標記面 → 可調法向、形狀(矩形/橢圓/圓)、aperture。罕用 case(自訂 transition)需要 advanced mode。

8. **RF cable endpoint:保留 `SceneObject.properties.rfCableEndpoints` 還是統一進 `rf_links` 表?** 現狀走 properties(編輯 UX 流暢);統一進 link 表會跟其他 RF 連線一致。Phase RF.4 決定。Open question:cable spline 編輯(Phase RF.7)會把端點當成 spline endpoint,可能反過來需要更獨立的儲存。

9. **RF `combiner` / `mixer` / `circulator` 何時要加?** 目前 6 個 RF kind 涵蓋 single-tone single-path 場景;加 combiner/mixer 後 BFS 需要支援多 input 對單 output(combiner)、頻率轉換(mixer 產生 sum/diff)。建議:用到時再加,**第一個用例驅動 schema** — 不預先抽象。

10. **AOM `rf_in` face 是強制還是可選?** 強制:若 AOM 沒有 `rf_in` face,RF tracer 無法 hydrate setpoint,使用者只能手填 dynamicSources。傾向**強制**(catalog 預設給,使用者離線情境下也可以不連線,signalAtPort 自動 fallback 到 dynamicSources / centerFreqMhz,§14.4)。

11. **PPG 的 face `domain` 命名衝突**:現有 face id 叫 `rf_out` 但 `domain: "ttl"`。要不要改 id 為 `ttl_out` 更直觀?Trade-off:改名會破壞既有 catalog 的 anchor name lookup,Phase RF.2 backfill 需要 rename。傾向 Phase RF.2 一次做掉。

---

## 11.5 Out of scope(Phase 1~10 不處理)

明確標出避免審查時糾結為何沒處理。需要時加在 BeamRay struct 預留的欄位上,不需重構。

| 項目 | 為什麼 out-of-scope | 預留的擴展點 |
|------|--------------------|-------------|
| Coherent recombination / MZI 拍頻 | Phase tracking 困難,需要 rendezvous 偵測 | BeamRay 帶 `phaseAccumRad` / `pathLengthMm` 資料,但不自動疊加 |
| Mueller matrix(depolarizing) | 大部分元件用 Jones 足夠 | PhysicsOp interface 可擴展 |
| 非線性過程(SHG/Raman/FWM) | 需要 χ⁽²⁾ / χ⁽³⁾ 模型 | 留 `nonlinear_crystal` kind |
| Pulsed lasers / 時域整形 | 假設 CW | BeamRay 預留 `temporalEnvelope?` 欄位 |
| Thermal lensing | 假設常溫 | — |
| AR coating 多波長反射曲線 | 用單一 `arResidualR` 數值 | `arResidualR` 可改 `(λ) => R` 函式 |
| RF time-domain(ns 級 pulse train、phase noise) | RF tracer 是 quasi-static,只看 steady-state | PPG TimingProgram `rest_state` / RfSignalState 預留 `phaseDeg` 欄位 |
| RF magnetic / vacuum coupling | 留給其他 multiphysics 模組 | — |
| RF combiner / mixer / circulator | 6 個現有 kind 未涵蓋 | 走同套 §7.5 BFS 機制,新增 kind + op 即可 |
| RF S-parameter import(Palace farfield、SPICE) | Phase RF.7 才考慮 | rf_amplifier / horn_antenna 預留 `linkedEmProblemId` |
| MOT / atom-light interaction | 留給 cell solver | — |
| 高階 ghost ray 追蹤(> 1 次 back-reflection) | 預設 power threshold 截斷 | 可調 threshold |

---

## 12. 預期收益

| 項目 | 現狀 | 新模型 |
|------|------|--------|
| 新增一個元件需動的檔案 | 5+(kindParams、ray tracer dispatch、UI controls、anchor contracts、solver) | 2(註冊 PhysicsOp + 建 Asset3D) |
| 同語意的讀取路徑數 | 2~3(V1 / V2 / 預設) | 1(face / transition) |
| Ray tracer 內 kind 字串 dispatch | 多處 | 0 |
| RF tracer 內 kind 字串 dispatch | 多處(switch / amp / cable 各自 handler) | 0(per-kind RfPhysicsOp 統一介面) |
| 複合元件需要的物理代碼 | 自訂 handler | 0(自然湧現) |
| Per-instance 參數的儲存位置 | 3 處(properties/kindParams/objectBindings) | 3 處,**但職責 disjoint** |
| AOM RF setpoint 來源 | 使用者手填 dynamicSources(或仰賴 rf_chain_nodes legacy 拍合) | RF tracer 從 chain 自動算,使用者只在離線情境 override(§14.4) |
| Optical / RF 元件抽象一致性 | 光 face/transition,RF 走 graph link + 特殊 endpoint storage | 同一套 face/transition 描述,只是 tracer 不同(ray vs BFS) |

---

## 13. 下一步

1. 本文件 review,收斂第 11 節的 open questions(尤其 Q2、Q3)
2. 同意後進入 **Phase 1**:Kind Registry skeleton + 1 個 PhysicsOp(建議 `abcd_thin_lens`)+ 對應 vitest
3. 用一個 lens Asset3D + 一個 SceneObject 驗證 ray 通過 face A → face B,ABCD 套用正確
4. 通過後再展開 Phase 2(DB schema)

---

## 14. AOM RF dynamic contract

AOM 同時是 ray tracer 的 optical 元件,也是 RF tracer 的 sink。本節定義兩個 tracer 在 AOM 處的交接介面。

### 14.1 AOM Asset3D 上的 face 配置

AOM 有 3 個 face — 2 optical + 1 RF sink:

```json
{
  "id": "aa_mt110-a1-1064",
  "kind": "aom",
  "faces": [
    { "id": "A",     "domain": "optical",
      "positionMmBodyLocal": {"x":0,"y":0,"z":-25},
      "normalBodyLocal": {"x":0,"y":0,"z":-1},
      "apertureMm": 1.0 },
    { "id": "B",     "domain": "optical",
      "positionMmBodyLocal": {"x":0,"y":0,"z":+25},
      "normalBodyLocal": {"x":0,"y":0,"z":+1},
      "apertureMm": 1.0 },
    { "id": "rf_in", "domain": "rf",
      "positionMmBodyLocal": {"x":+10,"y":0,"z":0},
      "normalBodyLocal": {"x":+1,"y":0,"z":0},
      "apertureMm": 0 }
  ],
  "transitions": [
    { "in": "A", "out": "B", "op": "diffract_aom", "params": { "order": 1 } },
    { "in": "B", "out": "A", "op": "diffract_aom", "params": { "order": -1 } }
  ]
}
```

`rf_in` face 沒有出現在 `transitions[]`(它是 RF sink,不是 optical → optical 的橋)。`rf_in.normalBodyLocal` **就是** `rfPropagationDirectionBodyLocal`(舊欄位名 deprecated):從 §8.4 的 `kindParams.rfPropagationDirectionBodyLocal` 升級成 face 法向,並由 §3.1 約定強制垂直 A→B 光軸。

### 14.2 AOM Asset3D 只存的常數(vendor/model)

不能存 live RF setpoint。

- `centerFreqMhz`:nominal fallback,**不是** live source of truth
- `acousticVelocityMps`、`refractiveIndex`、`crystalLengthMm`
- `acousticBeamWidthMm`、`figureOfMeritM2`、`rfPowerMaxW`
- `requiresRfDrive`(boolean:是否強制 RF 訊號才能繞射;true 時無 RF → 0th order only)

### 14.3 Live RF setpoint 的來源(`rf_in` ← §7.5 RF tracer)

不再仰賴使用者手動寫 `SceneObject.dynamicSources.aomFreqMhz`。Live 值由 RF tracer 從圖上算出:

```
[rf_source] → [rf_cable] → [rf_amplifier] → [rf_switch active throw] → [rf_cable] → [aom.rf_in]
              (§8.9)        (§8.8)            (§8.10)                                  (sink)
```

RF tracer(§7.5)走完 BFS 後,`signalAtPort[(aom.id, "rf_in")] = RfSignalState { frequencyMhz, vpp, cumulativeGainDb, saturated, ... }`。

Solver 在執行 AOM ray transition 之前先做一個 hydration step:

```
ctx.dynamic.aomFreqMhz    = signalAtPort[(aom.id, "rf_in")].frequencyMhz
ctx.dynamic.aomRfVpp      = signalAtPort[(aom.id, "rf_in")].vpp
ctx.dynamic.rfDrivePowerW = signalAtPort[(aom.id, "rf_in")].vpp² / (8 × 50)
```

如果 `signalAtPort[(aom.id, "rf_in")]` 不存在(沒接 RF chain、PPG unbound、power gate 切了上游 amp、SP4T+ LOW state 無 active throw):
- `requiresRfDrive = true` → diffraction efficiency = 0,beam 全走 0th order
- `requiresRfDrive = false` → fallback 到 `Asset3D.defaultParams.centerFreqMhz`(nominal 值,主要給離線 design 用)

**RF amplifier gain 不複製進 AOM**:gain 已經反映在 `RfSignalState.vpp` 上(amp 在傳遞中乘了 `10^(gainDb/20)`)。AOM 只看 vpp,不看歷史。

### 14.4 AOM ↔ SceneObject.dynamicSources 的關係

`SceneObject.dynamicSources.aomFreqMhz` / `aomRfVpp` 仍可由使用者**手動覆寫**(離線 design / 不想接整條 chain 時):

| 情境 | `signalAtPort[(aom, "rf_in")]` 來源 |
|------|-------------------------------------|
| RF chain 連完整(AD9959 → amp → switch → cable → AOM) | RF tracer 算出 |
| 使用者手動覆寫 dynamicSources | dynamicSources 值 **勝過** RF tracer(明確 override) |
| 都沒有,但 `requiresRfDrive = false` | `defaultParams.centerFreqMhz` 帶值,vpp = 0 |
| 都沒有,且 `requiresRfDrive = true` | undefined → efficiency = 0 |

優先順序在 hydration step 內 enforce:`dynamicSources` > RF tracer > defaultParams。

### 14.5 Bragg 公式(不變)

```text
theta_B = asin(lambda * f_rf / (2 * v_acoustic))     # external-angle convention
theta_deflect(order) = order * 2 * theta_B
```

`refractiveIndex` 用於 ABCD q propagation(`q_out = q_in + L/n`);**不**用於 external deflection 角度的除算。`rf_in.normalBodyLocal` 提供繞射的橫向方向(deflection 平面內的單位向量)。
