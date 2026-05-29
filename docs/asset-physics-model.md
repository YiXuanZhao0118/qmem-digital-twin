# Asset-Physics Model ??閮剛??辣

> Status: **閮剛??挾,撠??撘Ⅳ??* 韏瑁???2026-05-21,雿???拍??嗆???Asset3D 撅扎?????
>
> ?賊??辣:[`ARCHITECTURE_OVERVIEW.md`](ARCHITECTURE_OVERVIEW.md) 禮3, [`optical-schema-v2.md`](optical-schema-v2.md), [`vibe coding.md`](vibe%20coding.md) 禮4 frame conventions??

Canonical face rule:
- `faces[]` are physical optical surfaces only.
- A two-port asset uses physical faces `A` and `B`.
- Forward/reverse behavior is represented by directed transitions `A -> B` and `B -> A`.
- Do not create duplicate faces such as `A1/B1/A2/B2` just to encode direction.
- Direction, branch, non-reciprocity, diffraction order, and RF side belong on `transitions[]` (`op`, `params`, dynamic sources), not in face names.

**Canonical runtime frame rule (0093)**:

- ObjectPanel `x/y/z mm` and `rx/ry/rz deg` are the Lab frame pose of a `SceneObject`.
- `ComponentBinding` rows define each asset or subcomponent pose inside the Component frame.
- `Asset3D.anchors[]` are authored directly in the Asset/CAD frame. The legacy `*BodyLocal` suffix is a field-name compatibility artifact, not a separate runtime frame.
- Runtime transform chain: `anchor_asset_local -> ComponentBinding pose -> SceneObject Lab pose -> Lab frame`.

---

## 1. ??

?桀?銝惜鞈?璅∪?(Asset3D / Component / SceneObject)?鞎祇???*銝?銋暹楊**:

- ?拍? `kind`(mirror?olarizer?om...)? **Component** 銝?Asset3D ?芣頛?CAD 撟曆?
- ??隤?(?飛頠詻?Ｘ??F 頠???2~3 蝔株??楝敺?V2 binding ??anchor `directionBodyLocal` ???身??
- Ray tracer 閬??`elementKind` 摮葡 dispatch ?唬???handler,瘥?銝蝔桀?隞嗅停閬?鈭?獢?
- Per-instance ?(laser power?OM freq)?? `properties` / `kindParams` / `objectBindings` 銝?

**?格?**:??*??隞嗅?隞暻潛??*???Asset3D,??*??隞嗅蝛粹??獐頝隞?隞嗆韏瑚?**???Component,??*??撖阡??曉????*???SceneObject?? ray tracer 銝?隤?kind 摮葡,?芾? Face/Transition 撟曆???

**?見??撅斤?瑽????RF ?辣**(`rf_source`?rf_amplifier`?rf_cable`?rf_switch`?programmable_pulse_generator`?horn_antenna`):?芣 face 撣?`domain: "rf" | "ttl"`,transition 韏啁???禮7.5 ??RF tracer(graph BFS)?? 禮7 ??ray tracer?OM ?臬?漱?亦? hybrid ?辣(禮14)??

---

## 2. 銝惜?瑁痊??

| 撅斤? | ?? | 銝???|
|------|------|--------|
| **Kind Registry**(code,??DB) | PhysicsOp 撖虫?(`abcd_lens`?jones_polarizer`?diffract_aom`???ind ????`needs_aperture`?wavelengthRangeNm` 璅⊥) | 隞颱?撟曆??遙雿?vendor 蝝啁? |
| **Asset3D** | CAD 撟曆???*kind**??*faces**(?飛蝡臬撟曆?)??*transitions**(in face ??out face + op)??*defaultParams**(閰?kind ??閮凋??? | 蝛粹?蝯??ab pose??銵?? |
| **Component** | binding tree(摮?asset ?詨? pose)??*exposedFaces**(撠??湧?垢?? | ?拍? kind??銵?? |
| **SceneObject** | lab pose `(xMm,yMm,zMm,rxDeg,ryDeg,rzDeg)`??*paramOverrides**(per-binding 靽閬神)??*dynamicSources**(laser power / AOM freq / beam profile)?bjectBinding pose delta | ?拍? op?AD 撟曆? |

**??蝝?**:
1. Asset3D ??BodyLocal **+z = ?飛頠豢??*,**+x = ?拍?璈怠??遘**(敹怨遘 / ?脰遘 / s ?)?F-only asset(??optical face)銝?冽迨 +z 蝝?,body frame 撠? CAD ?喳
2. Ray tracer / RF tracer ?賭?隤?`kind` 摮葡,?芾? Face ?賭葉(ray)+ port adjacency ?賭葉(rf)+ Transition 銵?
3. SceneObject 銝?雿?paramOverrides / dynamicSources / objectBindings)?瑁痊 disjoint
4. Face ??`domain` 瘙箏?韏啣??tracer:`"optical"` ??禮7,`"rf"`/`"ttl"` ??禮7.5;?? Asset3D ?臬????拍車(AOM ??`A`/`B` optical + `rf_in` rf)

---

## 3. Asset3D Schema

```typescript
type Asset3D = {
  id: string                          // e.g. "thorlabs_lpvisa050-mp2"
  vendorPart?: string                 // 鞎刻? metadata
  geometryRef: string                 // CAD 瑼楝敺?(.glb / .stl)

  kind: Kind                          // ???臭? kind,?箏?(OpticalKind | RfKind,禮6)
  faces: Face[]                       // ??蝡臬(optical / rf / ttl;?誨??anchor 銝剔??飛/RF ??
  transitions: Transition[]           // ??in face ??out face + op(optical:?飛 PhysicsOp;rf:RfPhysicsOp)

  defaultParams: KindParams           // kind-specific ?身靽
  wavelengthRangeNm: [number, number] // R2 (optical-schema-v2)

  mechanicalAnchors?: MechAnchor[]    // ??摮?anchor (mount face, edge) 蝬剜???瑽?
}

type Face = {
  id: string                          // Physical face id: "A", "B", "R", "T", "rf_in", "rf_out", "ttl_in", ...
  positionMmBodyLocal: Vec3
  normalBodyLocal?: Vec3              // ?身 +z(out ??/ -z(in ??;mirror ?航閮?
  apertureMm: number                  // ?祝 / ??;RF/TTL face ?芯蝙??閮?0
  apertureShape: "rectangle" | "ellipse" | "circle"   // circle ??back-compat
  domain?: "optical" | "rf" | "ttl"   // ?身 "optical";RF/TTL face 敹‵隞仿甇Ｚ楊????
}

type Transition = {
  in: string                          // face id
  out: string | string[]              // ?桐?(transmit)/ 憭?diffraction orders)
  op: PhysicsOpRef                    // ?? Kind Registry ??op
  params?: Partial<KindParams>        // 撠府 transition ???刻?撖?蝵)

  // 撟曆??唾撓?拚(銝銝,??PhysicsOp 瘙箏?憒?閫??)
  abcd?: Matrix2x2                    // (a) 蝪∪撠迂?辣 ?????拚雿??(q_x, q_y)
  abcdXY?: { x: Matrix2x2; y: Matrix2x2 }  // (b) ??辣(cylindrical lens, Glan-Laser) ??x/y 頠貊蝡?
  matrix5x5?: Matrix5x5               // (c) 憓誨 5?5,雿?典???V = [x, 庛_x, y, 庛_y, 1]^T
                                      //     憿?????隞嗆頨恍???撠帖??蝘颯?prism / wedge)
}
```

**5?5 憓誨?拚雿輻??**:?嗅?隞嗅???*?函??澆撠????箏?蝛粹??宏**(prism wedge?lan-Laser ?折 38.5簞 ??ecenter)???閬?V ???洵 5 ???????`E_x` / `E_y` ?宏?ens?irror?olarizer 蝑?蝔勗?隞嗥 2?2 ABCD ?喳;Glan-Laser?ollaston?edge prism ??5?5??

**Face `domain` 閬?**:`"optical"` 韏?ray tracer(禮7);`"rf"` 韏?RF tracer(禮7.5);`"ttl"` 撅祆 RF tracer ??pre-pass(switch state 閫??,禮7.5)?exposedFaces` / ???蝺刻摩?典??????enforce `domain` 銝?湔??賢遣蝡?link(`optical_links` ?芣 optical,`rf_links` ?芣 rf,ttl 蝡臬?賣 ttl)?F/TTL face 瘝? wavefront,`abcd` / `matrix5x5` 瘞賊???null;??`apertureMm` 銋??? ray-hit ?文?,????UI snap target ????

**閮剛???**:
- `kind` 頝?Asset3D ??**1:1**??璅?CAD 隞嗉???polarizer ??quarter waveplate,撠望?拙?Asset3D(?臬??`geometryRef`)??靘? Asset ?喟?拍???
- `faces[]` ?誨??`anchor[]` 銝剔???摮貊垢?????璈１ anchor(mount face?dge)蝬剜??見?曉 `mechanicalAnchors`??
- `transitions[]` ?Ⅱ?? A ?脣 ????B ?箏????楝敺?**ray tracer ?湔?萄?,銝? kind dispatch**??
- **撟曆??拚銝惜蝝?2?2 / 4?4 / 5?5)**:敺??圈?銵券???憓???PhysicsOp 摰???芸楛?閬蝔柴eamRay ??`origin` 撌脩??踵?蝯?雿蔭,5?5 ?洵 5 ???芾?鞎研?*?辣?祈澈???摰?蝘?*??銝?銴楊蝣?ray ???蝵柴?

---

### 3.1 Asset/CAD frame convention

Asset3D geometry, faces, and anchors are authored in the same Asset/CAD-local frame. The legacy field suffixes `BodyLocal` remain in JSON for compatibility, but their runtime meaning is Asset/CAD-local after alembic `0093_flatten_asset_frame_anchors`.

Rules:
- If imported CAD axes or origin are inconvenient, fix the mesh/anchor data during import or catalog bake.
- `ComponentBinding` owns asset placement inside a Component.
- `SceneObject` owns Component placement inside the Lab frame.
### 3.2 Face normal ??蝢?`normalBodyLocal`)

Face normal ???遙 **撟曆? + 隤? + ?拍?** 銝??脯???catalog 敹??萄??ㄐ?? convention,?血? tracer 銝??梢雿?Snell / Fresnel / ?蝯????

**(1) 撟曆?閫 ??摰儔 face 撟喲**

Face ?臭??像?Ｗ????敶?/ 璈Ｗ?):
- `positionMmBodyLocal` = ?銝剖?
- `normalBodyLocal` = ???典像?Ｙ??桐?瘜?
- Aperture (`apertureMm` / `apertureShape`) ?舫像?Ｖ???2D 敶Ｙ?

Tracer ??ray-plane intersection ?? `(position, normal)` 閫?hit point,? aperture 敶Ｙ? clip??

**(2) 隤?閫 ??outward normal convention**

瘜?**瘞賊????辣?祇?銋?**:

| Face | 閫 | ?詨?瘜?(body frame) |
|------|------|---------------------|
| A | ?亙???beam 敺??ａ脖?) | (0, 0, **??**) ??敺?隞嗡葉敹?憭???? |
| B | ?箏???beam ???ａ?) | (0, 0, **+1**) ??敺?隞嗡葉敹?憭???+z |
| R (Glan reject / PBS side) | ?湧 reject ?箏 | 靘? (0.9213, 0, 0.3888) ??敺擃葉敹? air gap 憭?|
| Mirror ?臭???| ????| (0, 0, +1) ??敺?Ｚ?敺??◤?找漁???|

**撽?**:`k?_beam 繚 n?_face` ?泵??
- `< 0`:beam ??face ?脣(?葉?亙???
- `> 0`:beam 敺?face ?ａ?(???箏???

**(3) ?拍?閫 ??Snell / Fresnel / ??箏?**

瘜??湔?脣?拍??砍?:
- ?亙?閫?`cos 庛廘?= ??繚n?`(鞎?? outward normal vs incoming beam)
- Snell's law:??n? ??reference axis 閫??撠??
- ??:`k?_out = k?_in ??2(k?_in繚n?)n?`
- Fresnel reflectance R_s, R_p ??庛廘?蝞?
- **s/p ??箏?**:`s = (k?_in ? n?) / |?帆`,`p = k?_in ? s` ??Jones vector ??lab basis,Faraday / PBS / ??賊? op ?賭?鞈湧摨?

靘?:Glan-Laser R ?Ｘ???(0.9213, 0, 0.3888) **??**
- 璅 R ?頨箏?芸?像?Ｖ?(撟曆?)
- ? reject ???辣銝剖??????隤?)
- 瘙箏? reject ?撠??= ?亙?????air-gap ?敺?Snell ???????拍?)

**(4) Face normal vs body +Z**

|  | body +Z | face normal |
|---|---|---|
| 撅祆 | ?游?Asset3D ?漣璅頂 | ? face |
| ?賊? | 1 ????asset ?梁) | 瘥?face 1 ????函? |
| 閫 | ?拚 row/col 蝝Ｗ??箸?(convention) | 撟喲摰儔 + ?拍?頛詨(ground truth) |

?抵?*?函?**?? 2-port slab ? face A 瘜? = (0,0,-1) = ?? body +Z,?絲靘?銝??,雿? PBS ??R ?Ｗ停?＊銝? ??R 瘜?銝 簣Z 隞颱?銝??

**(5) 撖虫?閬?**

- 敹???*?桐???**(tracer ??normalize,雿?catalog 撖急??桐??瑕漲?摮?渲?)
- Schema 銝?optional(`normalBodyLocal?`),???閮?A=(0,0,-1)?=(0,0,+1),雿祕?????catalog ?賣?撖恍?郁蝢?
- 敺桀??暹??舀芋??wedge / decenter(靘? face B 瘜? `(0.01, 0, 0.9999)` ??0.6簞 wedge)
- Tracer **??face normal 蝞漱暺?+ ?亙?閫?*;**銝摰?瑯銝?亙??Ｕ?*???? transition ??`in` / `out` 甈?瘙箏?

**TL;DR**:Face normal = **?箏??孵??雿???+ 摰儔 face 撟喲????*??摰???隞嗅???甇???鈭霈?PBS / mirror / Glan-Laser 蝞蝯???撣貉??桐??航炊??

---

### 3.3 Multi-hop reflective transition(A* / B* topology)

?? **PBS / BS / Glan-Laser / dichroic** ????冽???????辣,雿輻蝯曹????Ｘ??脯???撠?敺粥 mirror ?砍? `k_out = k_in ??2(k繚n?)n?`,**銝??具ace normal = exit direction???瑕?甇?*??

**Face 閫??**

| ?賢? | 閫 | 瘜??儔 | 閰?face ???|
|------|------|---------|-------------|
| **A1, A2, A3, A4** | 憭?脣????/ 敺?/ 撌?/ ?? | 撟喲憭?瘜? | Snell ??(?亙?港?鞈芯??? |
| **B1, B2** | ?折???(Brewster ?? / Glan air-gap) | ?祕銵券瘜? | `k_out = k_in ??2(k繚n?_B)n?_B`(mirror ?砍?) |

A* 頝?B* ??*?賢? convention 銝 schema 撘瑕**;tracer ??transition ??`via` 甈?瘙箏?瘥?face 憟??遣霅?catalog 蝺刻摩???誑?拚霈??

**Transition 憭挾頝臬?(via chain)**

```typescript
type Transition = {
  in: string                       // 韏瑕? face id
  via?: string[]                   // ?折 / 銝剝? face id 摨?(????)
  out: string | string[]           // 蝯? face id(憭?= 憭?order)
  op: PhysicsOpRef
  abcd?  | abcdXY? | matrix5x5?    // ?湔挾頝臬????嗾雿??
}
```

Tracer 撠?`[in, ...via, out]` 靘???:
- ?賢 A*:Snell ??(?刻府 face 瘜? + ?拙????
- ?賢 B*:Mirror ??(?刻府 face 瘜?)

Op ?踹??`PhysicsOpContext` ?摰 face chain(`face_in`, `face_via[]`, `face_out`),鞎痊 polarization / power 瞍?;**撟曆??孵???tracer 敺?face 瘜? + ?砍??芸?蝞?*,op 銝?蝖砍神 exit direction??

**頝臬?敶Ｘ?**

- **蝛輸?*(transmit through interface):`A1 ??[B1, B2] ??A_opposite`
  - 靘?Glan-Laser p 蝛輸?`A1 ??[B1, B2] ??A2`(??air gap ?拇活 Snell)
  - 靘?Cube PBS p 蝛輸?`A1 ??[B1, B2] ??A2`(??Brewster plate ?拇活 Snell,? lateral shift ??0)
- **??**(reflect off interface):`A1 ??[B1] ??A_side`
  - 靘?Glan-Laser s reject `A1 ??[B1] ??A3`(s ??gap mirror reflect,?箏??
  - 靘?Cube PBS s reflect `A1 ??[B1] ??A3` ??`A4`(?箏? A ??B1 瘜? + mirror ?砍?瘙箏?)
- **?桃???*(?? 2-port slab):`A1 ??A2`(via = [])
  - Lens / waveplate / AOM / Faraday rod 瘝輻,瘝? B ??

**蝭?:Glan-Laser IO-3 ( L=5.0mm, gap angle 38.5簞 )**

```
faces:
  A1 (input)    pos (0, 0, -2.5)    normal (0, 0, -1)         outward
  A2 (transmit) pos (0, 0, +2.5)    normal (0, 0, +1)         outward
  A3 (reject)   pos (2.3, 0, 0)     normal (1, 0, 0)          ?湧憭?
  B1 (gap front) pos (0, 0, 0)      normal (0.6225, 0, -0.7826)   ?祕 gap 銵券
  B2 (gap back)  pos (0.1, 0, 0)    normal (0.6225, 0, -0.7826)   撟唾???B1

transitions:
  A1 ??A2 via [B1, B2]   op=glan_transmit_p   p ?甈?Snell
  A1 ??A3 via [B1]       op=glan_reject_s     s mirror reflect at B1 ??A3 Snell
  A2 ??A1 via [B2, B1]   op=glan_transmit_p   ??
  A2 ??A3 via [B2]       op=glan_reject_s     ?? reject(??銝府閫貊)
```

撽?:beam=(0,0,1) ??A1 韏?reject 頝臬?
1. B1 mirror:`k_out = (0,0,1) ??2繚(0,0,1)繚(0.6225, 0, -0.7826) 繚 (0.6225, 0, -0.7826)`
   - `(k繚n?) = -0.7826`,`2(k繚n?)n? = (-0.974, 0, 1.225)`
   - `k_after_B1 = (0,0,1) ??(-0.974, 0, 1.225) = (0.974, 0, -0.225)` (?園???
2. A3 Snell(crystal n=1.48 ??air n=1,?Ｘ???(1,0,0)):
   - 撟喲?批?????瘜?????Snell ??
   - ??敺?`k_air ??(0.9213, 0, 0.3888)` ??頝???catalog 撠?銝?

憒???蝞?頝???銝??簣0.001,撠望 catalog ?拍??詨?gap 閫漲?擃?撠?)?閬甇?銝 convention ?胯?

---

## 4. Component Schema

```typescript
type Component = {
  id: string                          // "isolator_1064_io3"
  vendorPart?: string
  bindings: ComponentBinding[]        // 摮?Asset ?撠?pose
  exposedFaces: ExposedFace[]         // 撠??湧?垢??
  // 瘝? kind, 瘝??拍??
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
  tunableAxes?: Axis[]                // ?芯?頠詨?閮?SceneObject ?? ObjectBinding 閬神
}

type ExposedFace = {
  componentFaceId: string             // 撠??迂 "optical_in"
  assetBindingId: string              // ?? bindings[].bindingId
  assetFaceId: string                 // 閰?asset ??face id
}
```

**閮剛???**:
- Component **瘝? kind**,蝝硃蝛粹?蝯? + 撠?蝡臬摰??
- `exposedFaces` ??ray tracer ?具omponent ????????sub-asset????璈? ??憭??賢? exposed face ?脣,?折 sub-asset 銋???剔 ray tracer ?芸楛??
- ?桐? Asset 銋???Component(vendor part = single asset),?見 SceneObject 瘞賊??? Component,隞蝯曹?

---

## 5. SceneObject Schema

```typescript
type SceneObject = {
  id: string
  componentId: string

  // Lab pose (?曄?靽?)
  xMm: number; yMm: number; zMm: number
  rxDeg: number; ryDeg: number; rzDeg: number

  // ??kind 靽閬神(per-binding,??撖?defaultParams 摮?)
  paramOverrides?: {
    [bindingId: string]: Partial<KindParams>
  }

  // ????皞??芣? SceneObject ??kind ?身??undefined)
  dynamicSources?: {
    laserPowerMw?: number             // laser_source
    centerWavelengthNm?: number       // laser tunable
    aomFreqMhz?: number               // aom
    aomRfPowerDbm?: number
    beamProfile?: {
      w0Mm: number                    // 1/e簡 ??
      m2?: number                     // beam quality
      z0Mm?: number                   // waist 雿蔭(component-local +z)
    }
    // ... ??kind ?芸楛摰???芸楛????雿?
  }

  // Per-instance pose delta(?曄?靽?)
  objectBindings?: ObjectBinding[]

  properties?: {
    placedRelativeTo?: PlacementIntent  // Smart Placement metadata
  }
}
```

**銝?甈???????*:

| 甈? | 雿???| 靘? |
|------|--------|------|
| `paramOverrides` | ??kind ????calibration 撌桃??| ?? waveplate 撖行葫 retardance = 88簞 ???身 90簞 |
| `dynamicSources` | ??撖阡??嗅???雿???| laser ? 50 mW?OM RF 閮?80 MHz |
| `objectBindings` | per-instance pose 敺株矽(撌脣??? | ?∪? yaw 敺株矽 0.3簞 撠? |

**Solver 閮???state**(beam jones?ower flux?olarization)**銝?隞颱??唳**,瘥活 solve ?蝞??

---

## 6. Kind Registry

**Split between DB(metadata) ??code(PhysicsOp)**(alembic 0086, 2026-05-25 韏?:

- **DB `kinds` table** 摮摨??? metadata:`name`?display_name`?domain`?op_set_name`?default_params`?face_template`?needs_aperture`?wavelength_range_nm`?description`??敺垢?? `/api/kinds` ??CRUD??
- **Code REGISTRY** 摮?PhysicsOp 撖虫?(`abcd_lens`?jones_polarizer`?diffract_aom`...)?撘??拙? ORM 摨????隞亦???code ?拍垢?∪?(frontend `src/optical/registry.ts` ??backend `app/optical/registry.py`)??
- **DB row ?? `op_set_name` 撘 code 蝡舐? op ??**?遣銝? kind row(靘? `my_custom_lens`)??閮?`op_set_name = "lens_biconvex"` ??tracer ??lens_biconvex ??ops 頝?kind????*?迤?啁??拍?銵**隞???code 閮餃???op,?霈?UI ??`op_set_name` dropdown ?箇?圈??

```typescript
// frontend/src/optical/registry.ts
// backend/app/optical/registry.py ???∪?
// ?芾?鞎?PhysicsOp(callable ?賢?),瘝? metadata??

type OpticalKind = 
  | "laser_source" | "tapered_amplifier"
  | "lens" | "mirror" | "dichroic_mirror"
  | "polarizer" | "waveplate"
  | "beam_splitter" | "pbs"
  | "aom" | "eom"
  | "faraday_rotator"
  | "fiber_coupler" | "fiber" | "fiber_end"
  | "isolator"                            // 瘜冽?:隞雿 single asset ??
                                          //   雿?vendor "Thorlabs IO-3" 韏?Component 頝舐?
  | "nonlinear_crystal" | "saturable_absorber"
  | "detector" | "camera" | "spectrometer" | "wavemeter"
  | "beam_dump"

type RfKind =                             // ??RF ??暺?韏?禮7.5 RF tracer,銝粥 ray tracer)
  | "rf_source"                           // emitter:AD9959 DDS?eneric synth
  | "rf_amplifier"                        // passthrough:ZHL-1-2W+ 蝑?
  | "rf_cable"                            // ?? passthrough:?遘 / SMA / BNC
  | "rf_switch"                           // passthrough(N-throw,TTL ??:ZYSWA-2-50DR 蝑?
  | "programmable_pulse_generator"        // emitter(TTL/Trigger ??:蝬?Pulse&Timing TimingProgram
  | "horn_antenna"                        // sink:頛餃??箇頂蝯?

type Kind = OpticalKind | RfKind          // Asset3D.kind ?迂?嗡葉銋?(銝???? DB kinds.name)

type PhysicsOp = (
  rayIn: BeamRay,                       // (origin, dir, 弇, jones, power) in face-local frame
  faceIn: Face,
  faceOut: Face,
  params: KindParams,
  dynamic?: DynamicSources              // 靘 SceneObject (laser power etc.)
) => BeamRay[]                          // 憭?頛詨(diffraction orders / BS ??)

// 瘥?op set 閮餃??芸楛??ops(?撘?metadata ??DB)
const REGISTRY: Record<OpticalKind, {
  ops: Record<string, PhysicsOp>        // op name ??impl
}>
```

```sql
-- DB schema (alembic 0086)
CREATE TABLE kinds (
  id                UUID PRIMARY KEY,
  name              TEXT UNIQUE NOT NULL,         -- 撠? Asset3D.physics_kind
  display_name      TEXT NOT NULL,
  domain            TEXT NOT NULL,                -- 'optical' | 'rf' | 'mechanical'
  op_set_name       TEXT NOT NULL,                -- ? code REGISTRY ??key
  default_params    JSONB NOT NULL DEFAULT '{}',
  face_template     JSONB NOT NULL DEFAULT '{}',  -- anchors 蝭(required / optional / needs_direction / needs_aperture)
  needs_aperture    BOOL  NOT NULL DEFAULT false,
  wavelength_range_nm FLOAT[],
  description       TEXT,
  created_at, updated_at ??
);
```

**Registry / Kind table ???脣?撌?*:
- **Code REGISTRY**:?? PhysicsOp 撖虫?(`abcd_lens`?jones_polarizer`?diffract_aom`...);UI 銝?啣?,閬?PR ??code
- **DB `kinds`**:?? kind metadata(display name?efaultParams?aceTemplate);UI ??PHY Editor ??? Binding dev ??Kinds tab ??CRUD;??row 閬銝??code 蝡航酉????`op_set_name`
- **Asset3D 隞?箏???*:撱箏末敺???faces/transitions/default_params ?賢??芸楛銝隞???kinds row 銝???歇撱箏末??Asset3D(?踹??垢餈賣滲??production scene)
- **?啣???甇??拍???瘚?**:(1) ??code ??PhysicsOp + register;(2) UI ??Kinds tab ???啣?銝??row,opSetName ?豢閮餃????

---

## 6.5 RF Signal Model(RF tracer ??ray 蝑??

RF ?辣銝粥 ray tracer(瘝? wavefront????Jones vector????q-parameter)?F tracer ?其??蝒? data type `RfSignalState` ??graph 銝??

```typescript
type RfSignalState = {
  frequencyMhz: number                    // 頛郭?餌?(?桅;modulation ???芯?)
  vpp: number                             // peak-to-peak voltage,?身 50 峏 鞎?
  cumulativeGainDb: number                // 敺?source 蝝航??啁??port ??????< 0)
  saturated: boolean                      // ?臬?冽窒?遙銝 amp ? outputPowerMaxDbm clamp
  sourceObjectId: string                  // 韏瑟? rf_source SceneObject id
  sourceAnchorName: string                // 韏瑟? anchor name(AD9959 ??"CH0"~"CH3")
  passthroughObjectIds: string[]          // 瘝輸??? SceneObject id(?冽 debug + ??loop)
  // phase / modulation envelope ??Phase RF.6 ?甈?,?桀?銝?
}

type RfPhysicsOp = (
  incoming: RfSignalState,
  faceIn: Face,
  faceOut: Face,
  params: KindParams,
  ctx: RfTraceContext                     // switch_ttl_states / powered_off_object_ids 蝑?pre-pass 蝯?
) => Array<{ outAnchorName: string; outgoing: RfSignalState }> | null
//   null  = signal terminated(power gate?nbound PPG)
//   []    = ambiguous(SP4T+ ??LOW state ??active throw)
//   [x..] = 銝??憭撓??anchor(rf_switch ?? N throws,??active 銝??
```

**?桐?蝝?(??敺垢 parity 撘瑕)**:
- `AD9959_VPP_FULL_SCALE = 1.0 V`(AD9959 皛踹?頛詨??50 峏)
- `RF_LOAD_Z_OHM = 50`(???dBm ??Vpp 頧??′?批?閮?
- `P_w = Vpp簡 / (8 ? Z)`?Vpp = ??8 ? Z ? P_w)`?P_w = 10^((dBm ??30) / 10)`

**??摮?BeamRay ????*:

| 璁艙 | ?飛 | RF |
|------|------|----|
| 頛? | BeamRay(origin, dir, 弇, jones, q, power) | RfSignalState(freq, vpp, gain, ...) |
| ?賭葉?文? | rayPlaneIntersect(face) + aperture | port-adjacency map(cable endpoint ??撱箏末) |
| Source | `emit_laser_source` 敺?dynamicSources 霈 power | `emit_rf_source` 敺?dynamicSources.channels[] 霈 freq + amp |
| Sink | beam_dump?etector | horn_antenna?om.rf_in |
| 憭撓??| beamsplitter / AOM diffraction orders | rf_switch active throw(???芯?璇? |
| Power gate | (撠撠?璈) | `powered_off_object_ids` ??op return null |

**State 銝?隞颱??唳**:頝?摮訾?璅?瘥活 solve ?韏?BFS 蝞瘥?RF port ??`RfSignalState`,銝翰??

---

## 7. Ray Tracer ??瘚?

銝?隤?`elementKind` 摮葡??蝔?銝?

```
loop until ray escapes / absorbed / power < threshold:

  1. ray = (origin_lab, dir_lab, 弇, jones, power)

  2. For each SceneObject in scene:
       pose = sceneObjectToQuaternion(sceneObject) ??T(xMm,yMm,zMm)
       ray_comp = pose?鄞?繚 ray

       For each ComponentBinding in component.bindings:
         sub_pose = local_pose(binding) ??objectBinding_delta(binding)
         ray_asset = sub_pose?鄞?繚 ray_comp

         For each Face in asset.faces:
           hit = rayPlaneIntersect(ray_asset, face)
           if hit and within aperture:
             collect (sceneObject, binding, face, distance)

  3. ??餈??賭葉 (so, bnd, faceIn, t)

  4. ??asset.transitions ??in = faceIn:
       撠???? transition:
         params = asset.defaultParams
                  ??paramOverrides[binding.bindingId]
                  ??transition.params
         dynamic = sceneObject.dynamicSources
         out_rays = transition.op(rayAtFace, faceIn, faceOut, params, dynamic)

  5. ??out_rays 頧? lab frame, push ??queue
```

**??**:
- 瘝? `switch (elementKind) { case "mirror": ... }`
- Kind 摮葡?芸 PhysicsOp ?折雿輻(閰?op ?仿??芸楛??jones ? abcd)
- 憭?頛詨(AOM?eamsplitter)??`out_rays[]` ?芰?舀

---

## 7.5 RF Tracer ??瘚?(graph BFS,??ray tracing)

RF ?辣銝? ray-plane intersection?F tracer ?具ort adjacency graph????BFS,閬?撠? 禮6.5 ??`RfSignalState`??

```
pre-pass A ??撱?port adjacency map:
  for each rf_cable SceneObject:
      endpoints = sceneObject.properties.rfCableEndpoints  // { A: {objectId, anchorName}, B: ... }
      adjacency[endpoints.A] += endpoints.B
      adjacency[endpoints.B] += endpoints.A
  (cable 銝粥 rf_links 銵???蝪∪?蝺刻摩 UX;?嗡? RF ????質粥 rf_links 銵?
  for each rf_link in rf_links:
      adjacency[(from_obj, from_port)] += (to_obj, to_port)
      adjacency[(to_obj, to_port)] += (from_obj, from_port)

pre-pass B ??閫?????rf_switch ??TTL state:
  for each rf_switch SceneObject sw:
      peer = adjacency.lookupOneHop(sw, "ttl_in")
      if peer is programmable_pulse_generator with bound timingProgramId:
          program = fetchTimingProgram(peer.timingProgramId)
          switch_ttl_states[sw.id] = program.rest_state  // "HIGH" | "LOW"
      else:
          switch_ttl_states[sw.id] = sw.kindParams.ttlState  // manual fallback

seed ??敺???rf_source 瘜典:
  for each rf_source SceneObject src:
      if src.id in powered_off_object_ids: continue
      for each out_anchor in src.asset.faces where domain == "rf":
          channel = src.dynamicSources.channels.find(c => c.anchorName == out_anchor.name)
                  ?? defaults(80 MHz, amplitudeScale=1.0)
          signal = RfSignalState(
              frequencyMhz = channel.frequencyMhz,
              vpp = channel.amplitudeScale ? AD9959_VPP_FULL_SCALE,
              cumulativeGainDb = 0,
              saturated = false,
              sourceObjectId = src.id,
              sourceAnchorName = out_anchor.name,
              passthroughObjectIds = []
          )
          enqueue((src.id, out_anchor.name), signal)

BFS ??韏啗赤??sink:
  while queue:
      (portKey, signal) = dequeue()
      for peer in adjacency[portKey]:
          if (peer.objectId, peer.anchorName) already visited: continue   // first-arrival ??
          signalAtPort[(peer.objectId, peer.anchorName)] = signal
          
          op = REGISTRY[peer.kind].rfOps[peer.transitionForIncoming(peer.anchorName)]
          if op is None: continue   // sink ??銝?敺銝(AOM rf_in?orn_antenna.aperture)
          
          outputs = op(signal, faceIn, faceOut, peer.params, ctx)
          if outputs is None: continue   // power gate / unbound PPG ??閮?蝯迫
          if outputs == []: continue     // SP4T+ LOW ??active ??甇文??舐征
          for { outAnchorName, outgoing } in outputs:
              enqueue((peer.objectId, outAnchorName), outgoing)
```

**Sink ??*:`aom.rf_in`?horn_antenna.aperture`?遙雿?kind 瘝 RF registry 閮餃? op ??face??

**Power gate**(`powered_off_object_ids`,頝?`lab_power_panel.md` 閬?銝??:
- `rf_source` ??gate 銝?銝?emit
- `rf_amplifier` ??gate 銝?op return null(??DC bias ??閮?蝯迫,銝??unity gain)
- `rf_switch` ??gate 銝?op return null(?∪?憯?????active throw)
- 撠???AOM ??皜詨蔣??`signalAtPort[(aom.id, "rf_in")]` 霈?undefined ??AOM efficiency = 0 ??beam 韏?0th order

**??**:
- 頝?ray tracer 銝璅?**瘝? `switch (elementKind)` dispatch**;peer ??kind ?芰靘 registry ??op
- 頝?ray tracer 銝?:**瘝? ray-plane intersection**,?????explicit graph edges(cable endpoints + rf_links)
- AOM ??hybrid:??ray tracer ? optical ?辣(face A ??face B,diffract op),????RF tracer ? sink(rf_in ?踹 RfSignalState 敺釣??AOM physics op ??`ctx.dynamic`)??閰唾? 禮14

---

## 8. 蝭?:?冽璅∪?撖虫? 13 蝔桀?隞?7 optical + 6 RF)

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

Laser source ??**scene emitter**,銝蝑?beam ????函? passive element??
`out.normalBodyLocal` 摰儔?箏??孵?? `/api/v3/solver/run` 瘝??嗅
`initialRays`,solver ?? scene ?抒? `laser_source` object ?芸??Ｙ? initial
beam?SceneObject.dynamicSources` ?航?撖?`centerWavelengthNm`,
`laserPowerMw` / `powerMw`, `polarization`, `spatialModeX/Y`??

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

### 8.1 Lens(?蝪∪,1 ??transition)

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

PhysicsOp `abcd_thin_lens`:??ray?? [[1,0],[-1/f,1]],?箏???face B 銝剖亢??

### 8.2 Mirror(??脣)

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

PhysicsOp `reflect_specular`:`d' = d - 2(d繚n)n`,?箏?? face A??

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

瘜冽?:`transmissionAxisDegBodyLocal: 0` 銵函內??頠豢窒 **+x**????polarizer 摰???45簞,**銝 asset**,??ComponentBinding ??`local_rz_deg = 45`(隞乩? Isolator 蝭?)??

### 8.4 AOM(RF 撽?蝜?)

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

撟曆?閬?:
- `A` and `B` are the physical optical surfaces. Do not duplicate them as `A1/B1/A2/B2` just to encode direction.
- RF is not an optical face; it is a body-local vector: `rfPropagationDirectionBodyLocal`.
- `rfPropagationDirectionBodyLocal` must be perpendicular to the physical `A -> B` optical axis.

PhysicsOp `diffract_aom` ??ray + `dynamicSources` 銝剔? RF signal:
- `SceneObject.dynamicSources.aomFreqMhz` / `rfFrequencyMhz` drive the Bragg angle.
- `SceneObject.dynamicSources.rfDrivePowerW` / `aomRfVpp` drive diffraction efficiency.
- The selected diffraction branch is carried by transition `params.order`.
- q propagation is slab-like: `q_out = q_in + L/n`.

### 8.5 Isolator IO-3-850-HP(銴? Component,5 ?? Asset)

**Canonical A/B rule**: faces are physical surfaces. Direction and non-reciprocity live in directed transitions, not in duplicated face IDs.

**5 ??Asset3D**(3 ??摮?+ 2 ??璇?:

```yaml
# Glan-Laser polarizer(鋡怠???2 甈?
thorlabs_glan_laser_gl10:
  kind: polarizer
  faces:
    - A @ (0,0,-7.5)
    - B @ (0,0,+7.5)
  transitions:
    - { in:"A", out:"B", op:"jones_polarize_p" }
    - { in:"B", out:"A", op:"jones_polarize_p" }

# Faraday rotator ?詨?
thorlabs_io_3_850_faraday:
  kind: faraday_rotator
  faces: [A@(0,0,-15), B@(0,0,+15)]
  transitions:
    - { in:"A", out:"B", op:"faraday_rotate", abcd:[[1,L/n],[0,1]] }
    - { in:"B", out:"A", op:"faraday_rotate", abcd:[[1,L/n],[0,1]] }
  defaultParams: { rotationDeg: 45, reciprocal: false }

# 3 ??璇唳挺(??kind / faces / transitions)
thorlabs_io_3_850_input_housing:   { mechanicalAnchors: [...] }
thorlabs_io_3_850_faraday_housing: { mechanicalAnchors: [...] }
thorlabs_io_3_850_output_housing:  { mechanicalAnchors: [...] }
```

**Component**(蝬?5 ??Asset3D + 2 ??憭垢??:

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

**Isolator 銵敺?ray tracer ?芰皝抒**:
- Forward: `input_pol.A -> faraday.A -> output_pol.A`. The output polarizer binding is rotated 45 deg, so it transmits the Faraday-rotated beam.
- Reverse: `output_pol.B -> faraday.B -> input_pol.B`. The Faraday op adds another same-signed 45 deg, so the returning polarization is blocked by the input polarizer.

**瘝?隞颱? `isolator-specific` 蝔?蝣?*??

### 8.6 PBS(4 port,8 transitions)

PBS cube ??4 ??outer face(back/front/left/right),瘥?face ???舀?鈭?transition ????鈭?transition ????*??拍???op ?折,銝?閬?first-class face**??

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

**Ray tracer 銵**:ray 敺?back ?亙?,**??**閫貊 `back?ront`(transmit_p)??`back?ight`(reflect_s)?拙?transition,?梁??2 璇撓??ray?? op ?折??Jones ?蔣(`J_p = diag(1,0)`?J_s = diag(0,1)`)??

### 8.7 RF Source(AD9959 DDS,scene emitter)

撠? `laser_source`,雿 RF 閮??? BeamRay??

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

`emit_rf_source` 敺?`SceneObject.dynamicSources.channels[]` ??matching `anchorName`(CH0~CH3),霈??`frequencyMhz` + `amplitudeScale`,頛詨撠? `RfSignalState`??蝯?channels ??fallback ??`dynamicSources.frequencyMhz` + `powerDbm`(legacy ?桅);??蝯?????80 MHz / 1.0 V scale ?身??

`SceneObject.dynamicSources` ?航?撖怎?甈?:
- `channels: { anchorName, frequencyMhz, amplitudeScale (0-1), phase, sweepParams }[]`
- `frequencyMhz`(legacy ?桅)?powerDbm`(legacy)?phaseDeg`?modulation`("none" ?急??箏?)

瘜冽? 4 ??face ?梁 `id = "rf_out"`,??`name` ?????頝?禮8.6 PBS ?? face ?臬?憟????芣 PBS ?其???id(`back/front/...`)?臬??箏??Ｙ???脖???AD9959 ???拍?撠?,?隞亙??id + 銝? name??

### 8.8 RF Amplifier(passthrough,?桀?)

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
if object.id in powered_off_object_ids: return null   // ??DC bias ??閮?蝯迫
vpp_out  = vpp_in ? 10^(gainDb / 20)
vpp_max  = ??8 ? 50 ? 10^((outputPowerMaxDbm ??30) / 10))
saturated = (vpp_out > vpp_max)
vpp_out  = min(vpp_out, vpp_max)
return [{
  outAnchorName: "rf_out",
  outgoing: { ...incoming, vpp: vpp_out,
              cumulativeGainDb: incoming.cumulativeGainDb + gainDb,
              saturated, passthroughObjectIds: [...incoming.passthroughObjectIds, object.id] }
}]
```

**瘝? dynamic sources** ??????賊??spec sheet,catalog 銝甈∪神甇颯?

### 8.9 RF Cable(passthrough,**??**)

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

**Op `rf_pass`** ?桀???identity(銝?銵唳?);?芯??舀??`vpp ? 10^(-lossDbPerM ? lengthMm / 1000 / 20)`??

**?寞?????cable ?垢暺?摮 `rf_links` 銵?*:
- 銝??RF ???(amp ??switch ??AOM)韏?`rf_links` 銵?directed graph,from/to objectId + anchorName)
- **Cable 蝡舫?**摮 `SceneObject.properties.rfCableEndpoints = { A: {objectId, anchorName}, B: {objectId, anchorName} }`
- ?:cable 蝺刻摩 UX(?垢暺銝????具?瑕漲)?芸? SceneObject,銝?郊 link 銵?
- 禮7.5 RF tracer ??pre-pass A ?蝔桐?皞???銝??port adjacency map

**?唳?剛???cable**(SMA?NC 蝑???`endAConnector` ??`endBConnector` 銵券?;UI 皜脫???蝡舫??典???GLB primitive??

### 8.10 RF Switch(SP2T,TTL ?批,**憭?out face**)

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
elif params.throwCount == 2:  active = (3 - high)    // SPDT ?銝??
else:                    return []                   // SP4T+ LOW ?⊥?閫?????active path
target_anchor_name = `RF${active}`                   // "RF1" or "RF2"
vpp_out = vpp_in ? 10^(-insertionLossDb / 20)
return [{
  outAnchorName: target_anchor_name,
  outgoing: { ...incoming, vpp: vpp_out,
              cumulativeGainDb: incoming.cumulativeGainDb - insertionLossDb }
}]
```

**瘜冽? transition `out` ??array** ???瘜? 禮8.6 PBS(?? in face 撠?憭?transition row)銝??witch ??array 銵券???*?摩銝?*憭??out,雿?op runtime ??active 銝??PBS ?典? row 銵券???*??** active 憭?out?蝔桀神瘜鋡?Asset3D schema(禮3 `out: string | string[]`)?迂??

`ttl_in` ??`domain: "ttl"` 蝣箔? UI ?冽?蝺??芣??PPG ??`rf_out`(??賢???`rf_out`,閰?face ??禮8.11 璅?`domain: "ttl"`)??

### 8.11 Programmable Pulse Generator(TTL emitter,**蝬?TimingProgram**)

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
if params.timingProgramId is null: return null    // unbound ???∟撓??
program = fetchTimingProgram(params.timingProgramId)
level   = program.rest_state                       // "HIGH" | "LOW"
return [{
  outAnchorName: "rf_out",
  outgoing: { frequencyMhz: 0, vpp: (level == "HIGH" ? params.highVoltageV ? 2 : 0),
              cumulativeGainDb: 0, saturated: false,
              sourceObjectId: object.id, sourceAnchorName: "rf_out",
              passthroughObjectIds: [] }
}]
```

**?賢?霅血?**:閰?face `id = "rf_out"` ?舐鈭? RF tracer ?梁 port lookup,雿?`domain = "ttl"`,**銝 RF**???蝺刻摩?其誑 `domain` enforce ?詨捆?扼?

**?箔?暻澆???timeline 銝蔣??solver**:PPG ??TimingProgram ??scrub UI 銝?摰 pulse train,雿?solver ?芰? `rest_state`(steady-state idle level)??? solver ??quasi-static,銝芋??ns 蝝?摨ime-domain 璅⊥?策 Phase RF.6(????SPICE)??

### 8.12 Horn Antenna(RF sink,撠? beam_dump)

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

**`transitions = []`** ??瘝?隞颱? op,閮??圈? `aperture` 敺?BFS ??(蝑??`beam_dump` ??ray tracer ?????signalAtPort[(horn.id, "aperture")]` 靽?,UI ?舫＊蝷箝orn ?嗅??RF ???hase RF.7 ?? cos^n lobe 閬死??+ Palace farfield S-parameter import??

---

## 9. ??撠銵?

| ?曄?甈? / 璁艙 | ?唳芋??雿?| ?酉 |
|---------------|----------|------|
| `Component.kind` | `Asset3D.kind` | ?拍?銝(optical + RF ?梁) |
| Asset anchor `optical_anchor.directionBodyLocal` | Asset3D Face `normalBodyLocal` + 蝝? +z | mirror 瘜? |
| Asset anchor `optical_in/out.positionMmBodyLocal` | `Asset3D.faces[*].positionMmBodyLocal` | ??蝺?|
| `kindParams.rfPropagationDirectionBodyLocal`(AOM) | AOM `faces[id="rf_in"].normalBodyLocal` | 禮14.1 ????face 瘜? |
| `kindParams.acousticAxisBodyLocal` | ?? | 撱ａ??甈? |
| `Component.kindParams` | `Asset3D.defaultParams` | per-asset ?身 |
| `Asset.anchor.fastAxisDegBodyLocal` | `Asset3D.defaultParams.fastAxisDeg` + 蝝? +x base | 蝝?摨?|
| `SceneObject.properties.kindParamOverride` | `SceneObject.paramOverrides[bindingId]` | per-binding 蝭? |
| `SceneObject.properties.{laserPowerMw,...}` | `SceneObject.dynamicSources` | ?葉 |
| Mechanical anchors(mount face, edge) | `Asset3D.mechanicalAnchors` | 銝? |
| V2 `opticalSurface` binding | 蝘駁,by face | V1/V2 ?楝敺誥??|
| `derivedFromFiberEndpoint` | Face 銝? `derivedFrom: "fiber_node:A"` | ??蝡舫?璈靽?雿宏??Face |
| Anchor `rf_in/rf_out/ttl_in`(?暹? RF kinds) | `Asset3D.faces[*]` with `domain ??{"rf","ttl"}` | 禮3 face schema ?游? |
| `rf_chain_nodes` 銵?linear chain) | `rf_links` graph + RF tracer 蝞?cumulativeGainDb | 禮10 Phase RF.5 撱ａ |
| `SceneObject.properties.rfCableEndpoints` | 蝬剜?,?蔥??`rf_links`(禮10 Phase RF.4 鈭銝) | UX ? |
| `SceneObject.dynamicSources.{aomFreqMhz, aomRfVpp}`(?‵) | RF tracer hydration(禮14.3),?‵霈?override | 禮10 Phase RF.6 |

---

## 10. ?瑞宏頝臬?(??畾?瘥?畾萄?函? ship)

### Phase 0:閮剛???
- ?祆?隞?review?pen questions ?嗆?
- ?? schema ? v3(?曇???v2)

### Phase 1:Kind Registry ?啣?
- ??`frontend/src/optical/kinds/registry.ts` + `backend/app/optical/kinds/registry.py` 閮餃? PhysicsOp ??face 蝭
- 銝??Ｘ?鞈?,?芣撟唾?摮?璅∠?
- 撖?vitest 閬?瘥?PhysicsOp ?????

### Phase 2:Asset3D schema 銝血?
- DB ??`faces JSON`?transitions JSON`?kind ENUM`?defaultParams JSON` 甈?
- ?Ｘ? `anchors` 甈?靽?(銝)
- 撖?alembic migration:敺????backfill ?唳?雿?
  - `Component.kind` ??撠? Asset3D ??`kind`
  - Asset anchor `optical_in/out` ??`faces`
  - kindParams ??`defaultParams`

### Phase 3:Ray tracer ?啣?蝡?
- ?啣? `frontend/src/utils/rayTrace_v3.ts`,摰??face/transition
- ??feature flag `useV3RayTracer`
- 頝? `rayTrace.ts` 頝?parity test(???????beam path,1e-6 摰孵榆)
- 敺垢 `optical_solver.py` ?郊??v3 path

### Phase 4:??kind ??
- 敺?lens ??(?蝪∪,1 ??transition),靘?:mirror ??polarizer ??waveplate ??faraday ??AOM ??beamsplitter ??fiber_*
- 瘥?kind ??頝憟?vitest + parity test
- ??敺府 kind ?? dispatch 蝔?蝣澆??

### Phase 5:Rust spike(WASM 皞?)
- ? Rust crate `op-core/`,?冽?蝪∪??op(`abcd_thin_lens`)撖?spike
- ??`wasm-pack` build,?垢 import 閰行偌皞?
- 銝?隞?TS+Python,撟唾?摮撽? toolchain
- 閰摯 dev iteration ?漲?ebug 擃??uild ??

### Phase 6:Rust ops ?券?瑞宏(??Phase 5 閰摯??)
- ????PhysicsOp ?蕃??Rust
- ??PyO3+maturin ??Python wheel,敺垢 import
- ??TS+Python ?祕雿???parity test ???箝S/Python wrapper 撠?WASM 蝯????湔扳葫閰?

### Phase 7:Component ?嗥?
- 蝘駁 `Component.kind`?Component.kindParams` 甈?(撌脤蝘餃 Asset3D)
- 撖?alembic migration 皜?甈?

### Phase 8:SceneObject ?嗥?
- `properties` ?抒? dynamic 甈??砍 `dynamicSources`
- `properties` ?抒? kindParam override ?砍 `paramOverrides`
- 撖?alembic migration

### Phase 9:Frame 蝝?撘瑕
- ????runtime assert:瘥?optical Asset3D ??+z ?賭葉?喳?銝??face

### Phase 10:皜?
- ?芾? `anchors` 銝剔??飛??璈１靽?)
- ??V2 binding 蝔?蝣?
- ??`kindParams.{rfPropagationDirectionBodyLocal, acousticAxisBodyLocal}` 蝑?甈?

---

### RF Migration Track(撟唾???Phase 1~10,?函? ship)

RF tracer 頝?ray tracer 閫???臭誑?桃?券脯?*?蔭靘陷**:Phase 1 ??Kind Registry skeleton(?梁 `defaultParams` / face 蝭?箇?閮剜)??

#### Phase RF.1:RF Kind Registry + RfSignalState type
- ??`frontend/src/kinds/_plugins.ts` + `backend/app/kinds_manifest.py` 閮餃? 6 ??RF kind 蝭(face 璅⊥ + defaultParams)
- 摰儔 `RfSignalState` type(TS + Python),50峏 + `AD9959_VPP_FULL_SCALE` 撣豢?曉?冽芋蝯?
- vitest / pytest 閬?瘥?op ?????`rf_amplify`?rf_switch_route`?emit_rf_source`?emit_ttl_steady`?rf_pass`)
- **?曄?**:5 ??kind 撌脩??舫???`rf_source`?rf_amplifier`?rf_cable`?rf_switch`?programmable_pulse_generator`?horn_antenna`),?芸榆敶Ｗ???registry

#### Phase RF.2:RF Asset3D face/transition schema 銝血?
- DB ??`faces JSON`?transitions JSON` ??RF 憿? Asset3D(??Phase 2 璈)
- Backfill alembic:RF asset ?暹? anchor ?孵神??face(domain="rf"/"ttl")+ transition
- ??`anchors` 甈?靽?

#### Phase RF.3:RF tracer v3(graph BFS)
- ?啣? `frontend/src/utils/rfPropagation_v3.ts` + `backend/app/solvers/rf_propagation_v3.py`,摰??face/transition + RfPhysicsOp
- 頝??`rfPropagation.ts` / `rf_propagation.py` parity test(???????signalAtPort,vpp/freq 1e-9 摰孵榆)
- Feature flag `useV3RfTracer`

#### Phase RF.4:cable endpoint 璅∪?蝯曹?(option A ??B)
- Option A(靽?):蝬剜? `SceneObject.properties.rfCableEndpoints`,?芣? 禮7.5 pre-pass A 敶Ｗ???
- Option B(瞈??:cable endpoint 銋粥 `rf_links` 銵?撱ａ `rfCableEndpoints` 甈?
- 瘙箏?暺?UX(蝡舫??宏)?賢?函? `rf_links` 璅∪?銝?????

#### Phase RF.5:rf_chain_nodes 撱ａ
- ??`rf_chain_nodes` 銵?linear chain)???reader ?寞?韏?`rf_links` graph
- Chain-summation UI ?寧 `signalAtPort[(aom.id, "rf_in")].cumulativeGainDb` 憿舐內
- alembic ?芾”

#### Phase RF.6:AOM hydration(?誨 dynamicSources ?‵)
- Solver ?典銵?AOM `diffract_aom` op ??hydrate `ctx.dynamic.{aomFreqMhz, aomRfVpp, rfDrivePowerW}` from `signalAtPort[(aom, "rf_in")]`(禮14.3)
- ??override ?芸??? enforce(禮14.4)
- 撱ａ?蝙?刻???憛?dynamicSources?? UX,?寞? chain ?芸?蝞?+ ?舫 override

#### Phase RF.7:Horn farfield + cable spline
- Horn antenna cos^n lobe 閬死??
- (Option)Palace farfield S-parameter import ?誨 cos^n
- Cable spline 蝺刻摩(?誨?渡? cylinder 皜脫?),??`lengthMm` ?芸?蝞楝敺

#### Phase RF.8:RF frame 蝝?撘瑕
- Runtime assert:`rf_in.normalBodyLocal ??A? optical axis`(AOM 撠惇)
- Runtime assert:cable ?拍垢 face `domain` 銝???賣 "rf" ???"ttl",銝頝典?)

瘥?RF Phase 銋??賣? working 蝟餌絞,?舐蝡?ship??*RF.6 ??AOM ?芸????蝭暺?*,摰?敺?AOM 銝??閬蝙?刻?憛?RF ???

---

**瘥?Phase 銋??賣? working 蝟餌絞**,隞颱??挾?∩??臭誑???銝?挾??*摰瑼??啣??B schema?O-3 ?瑞宏撖虫?閬?[`asset-physics-implementation.md`](asset-physics-implementation.md)**??

---

## 11. ???

1. **Aperture shape:circle ???舐??** ?曇? [optical-schema-v2.md 禮3.3](optical-schema-v2.md) 瘙箏?靽? type?HY Editor 銝＊蝷箝璅∪?瘝輻甇斗蝑?

2. **`Component.kind = "isolator"` ??銝?摮?** ?暹? vendor catalog ??29 璇?Thorlabs isolators 撣?`kind=isolator`?遣霅?**??**,???isolator ?賜 3-asset Component 銵函內??*Open question**:?????賣? 3 ??asset ??isolator 璅∪??(蝤??園? + ??撠?cube,?折憭活??)???交?,閰?kind 靽?雿粥 single-asset 頝舐???

3. **fiber 璅∪?:Asset ? Component?** 銝??fiber ?拍?銝???隞釭 + ?拙垢暺遣霅?**Component**(2 ??fiber_end Asset + 1 ????spline)??

4. **PhysicsOp 撖怠?蝡舫??臬?蝡?** ?垢閬??單? ray tracing,敺垢閬?甈? solver??閬祕雿遣霅?**撖思?隞?spec(頛詨頛詨???捆撌?,??蝡臬??芸祕雿?parity test 撘瑕銝??*(撌脫?曄???)??

5. **transition ?臭??航府?舀 recursive op?**(靘? etalon ?折憭活?? ??銝??transition ?折頝?loop ?嗅?? transmitted + reflected)?桀??曉? **??*,? PhysicsOp 撌脩?? `BeamRay[]`,recursive ??op ?折???喳,schema 銝?閬???

6. **Smart Placement 隞閬?閬?** [PLACEMENT_DESIGN.md](PLACEMENT_DESIGN.md) ?桀?隤?anchor??閬? snap target ?摩?寞?隤?Face(?飛)+ MechAnchor(璈１)?遣霅?Phase 4 銋??????踹?銝甈⊥憭芸???

7. **Asset Editor UI ?獐蝺刻摩 faces/transitions?** ?身:?訾? kind ??registry 蝯血 face/transition 蝭 ??雿輻?隤?face 雿蔭??aperture?TL/GLB import 敺蝙?刻? CAD 銵券 ??瘚桃??暺璅??????航矽瘜??耦?(?拙耦/璈Ｗ?/???perture????case(?芾? transition)?閬?advanced mode??

8. **RF cable endpoint:靽? `SceneObject.properties.rfCableEndpoints` ?蝯曹???`rf_links` 銵?** ?曄?韏?properties(蝺刻摩 UX 瘚);蝯曹???link 銵冽?頝隞?RF ???銝?氬hase RF.4 瘙箏??pen question:cable spline 蝺刻摩(Phase RF.7)??蝡舫??嗆? spline endpoint,?航??靘?閬?函??摮?

9. **RF `combiner` / `mixer` / `circulator` 雿?閬??** ?桀? 6 ??RF kind 瘨菔? single-tone single-path ?湔;??combiner/mixer 敺?BFS ?閬?游? input 撠 output(combiner)?????mixer ?Ｙ? sum/diff)?遣霅??典????**蝚砌??靘???schema** ??銝??鞊～?

10. **AOM `rf_in` face ?臬撥?園??臬??** 撘瑕:??AOM 瘝? `rf_in` face,RF tracer ?⊥? hydrate setpoint,雿輻??賣?憛?dynamicSources???*撘瑕**(catalog ?身蝯?雿輻?蝺?憓?銋隞乩????,signalAtPort ?芸? fallback ??dynamicSources / centerFreqMhz,禮14.4)??

11. **PPG ??face `domain` ?賢?銵?**:?暹? face id ??`rf_out` 雿?`domain: "ttl"`??銝???id ??`ttl_out` ?渡閫?Trade-off:?孵??憯??catalog ??anchor name lookup,Phase RF.2 backfill ?閬?rename???Phase RF.2 銝甈∪???

---

## 11.5 Out of scope(Phase 1~10 銝???

?Ⅱ璅?踹?撖拇?鳥蝯雿?????閬?? BeamRay struct ????雿?,銝?????

| ? | ?箔?暻?out-of-scope | ???撅? |
|------|--------------------|-------------|
| Coherent recombination / MZI ? | Phase tracking ?圈,?閬?rendezvous ?菜葫 | BeamRay 撣?`phaseAccumRad` / `pathLengthMm` 鞈?,雿??芸??? |
| Mueller matrix(depolarizing) | 憭折??隞嗥 Jones 頞喳? | PhysicsOp interface ?舀撅?|
| ???折?蝔?SHG/Raman/FWM) | ?閬???蝓聆 / ??蝓喇 璅∪? | ??`nonlinear_crystal` kind |
| Pulsed lasers / ???游耦 | ?身 CW | BeamRay ?? `temporalEnvelope?` 甈? |
| Thermal lensing | ?身撣豢澈 | ??|
| AR coating 憭郭?瑕?撠蝺?| ?典銝 `arResidualR` ?詨?| `arResidualR` ?舀 `(弇) => R` ?賢? |
| RF time-domain(ns 蝝?pulse train?hase noise) | RF tracer ??quasi-static,?芰? steady-state | PPG TimingProgram `rest_state` / RfSignalState ?? `phaseDeg` 甈? |
| RF magnetic / vacuum coupling | ?策?嗡? multiphysics 璅∠? | ??|
| RF combiner / mixer / circulator | 6 ???kind ?芣項??| 韏啣?憟?禮7.5 BFS 璈,?啣? kind + op ?喳 |
| RF S-parameter import(Palace farfield?PICE) | Phase RF.7 ? | rf_amplifier / horn_antenna ?? `linkedEmProblemId` |
| MOT / atom-light interaction | ?策 cell solver | ??|
| 擃? ghost ray 餈質馱(> 1 甈?back-reflection) | ?身 power threshold ?芣 | ?航矽 threshold |

---

## 12. ???嗥?

| ? | ?曄? | ?唳芋??|
|------|------|--------|
| ?啣?銝??隞園???瑼? | 5+(kindParams?ay tracer dispatch?I controls?nchor contracts?olver) | 2(閮餃? PhysicsOp + 撱?Asset3D) |
| ????霈?楝敺 | 2~3(V1 / V2 / ?身) | 1(face / transition) |
| Ray tracer ??kind 摮葡 dispatch | 憭? | 0 |
| RF tracer ??kind 摮葡 dispatch | 憭?(switch / amp / cable ? handler) | 0(per-kind RfPhysicsOp 蝯曹?隞) |
| 銴??辣?閬??拍?隞?Ⅳ | ?芾? handler | 0(?芰皝抒) |
| Per-instance ??摮?蝵?| 3 ??properties/kindParams/objectBindings) | 3 ??**雿鞎?disjoint** |
| AOM RF setpoint 靘? | 雿輻??憛?dynamicSources(?趕鞈?rf_chain_nodes legacy ??) | RF tracer 敺?chain ?芸?蝞?雿輻??券蝺?憓?override(禮14.4) |
| Optical / RF ?辣?質情銝?湔?| ??face/transition,RF 韏?graph link + ?寞? endpoint storage | ??憟?face/transition ?膩,?芣 tracer 銝?(ray vs BFS) |

---

## 13. 銝?甇?

1. ?祆?隞?review,?嗆?蝚?11 蝭??open questions(撠文 Q2?3)
2. ??敺脣 **Phase 1**:Kind Registry skeleton + 1 ??PhysicsOp(撱箄降 `abcd_thin_lens`)+ 撠? vitest
3. ?其???lens Asset3D + 銝??SceneObject 撽? ray ?? face A ??face B,ABCD 憟甇?Ⅱ
4. ??敺?撅? Phase 2(DB schema)

---

## 14. AOM RF dynamic contract

AOM ????ray tracer ??optical ?辣,銋 RF tracer ??sink?蝭摰儔?拙?tracer ??AOM ??鈭斗隞??

### 14.1 AOM Asset3D 銝? face ?蔭

AOM ??3 ??face ??2 optical + 1 RF sink:

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

`rf_in` face 瘝??箇??`transitions[]`(摰 RF sink,銝 optical ??optical ??)?rf_in.normalBodyLocal` **撠望** `rfPropagationDirectionBodyLocal`(??雿? deprecated):敺?禮8.4 ??`kindParams.rfPropagationDirectionBodyLocal` ????face 瘜?,銝衣 禮3.1 蝝?撘瑕? A? ?遘??

### 14.2 AOM Asset3D ?芸??虜??vendor/model)

銝摮?live RF setpoint??

- `centerFreqMhz`:nominal fallback,**銝** live source of truth
- `acousticVelocityMps`?refractiveIndex`?crystalLengthMm`
- `acousticBeamWidthMm`?figureOfMeritM2`?rfPowerMaxW`
- `requiresRfDrive`(boolean:?臬撘瑕 RF 閮??蝜?;true ? RF ??0th order only)

### 14.3 Live RF setpoint ??皞?`rf_in` ??禮7.5 RF tracer)

銝?隞啗陷雿輻???神 `SceneObject.dynamicSources.aomFreqMhz`?ive ?潛 RF tracer 敺?銝???

```
[rf_source] ??[rf_cable] ??[rf_amplifier] ??[rf_switch active throw] ??[rf_cable] ??[aom.rf_in]
              (禮8.9)        (禮8.8)            (禮8.10)                                  (sink)
```

RF tracer(禮7.5)韏啣? BFS 敺?`signalAtPort[(aom.id, "rf_in")] = RfSignalState { frequencyMhz, vpp, cumulativeGainDb, saturated, ... }`??

Solver ?典銵?AOM ray transition 銋???銝??hydration step:

```
ctx.dynamic.aomFreqMhz    = signalAtPort[(aom.id, "rf_in")].frequencyMhz
ctx.dynamic.aomRfVpp      = signalAtPort[(aom.id, "rf_in")].vpp
ctx.dynamic.rfDrivePowerW = signalAtPort[(aom.id, "rf_in")].vpp簡 / (8 ? 50)
```

憒? `signalAtPort[(aom.id, "rf_in")]` 銝???瘝 RF chain?PG unbound?ower gate ??銝虜 amp?P4T+ LOW state ??active throw):
- `requiresRfDrive = true` ??diffraction efficiency = 0,beam ?刻粥 0th order
- `requiresRfDrive = false` ??fallback ??`Asset3D.defaultParams.centerFreqMhz`(nominal ??銝餉?蝯阡蝺?design ??

**RF amplifier gain 銝?鋆賡?AOM**:gain 撌脩?????`RfSignalState.vpp` 銝?amp ?典?葉銋? `10^(gainDb/20)`)?OM ?芰? vpp,銝?甇瑕??

### 14.4 AOM ??SceneObject.dynamicSources ??靽?

`SceneObject.dynamicSources.aomFreqMhz` / `aomRfVpp` 隞?曹蝙?刻?*??閬神**(?Ｙ? design / 銝?交璇?chain ??:

| ?? | `signalAtPort[(aom, "rf_in")]` 靘? |
|------|-------------------------------------|
| RF chain ?????AD9959 ??amp ??switch ??cable ??AOM) | RF tracer 蝞 |
| 雿輻????撖?dynamicSources | dynamicSources ??**??** RF tracer(?Ⅱ override) |
| ?賣???雿?`requiresRfDrive = false` | `defaultParams.centerFreqMhz` 撣嗅?vpp = 0 |
| ?賣???銝?`requiresRfDrive = true` | undefined ??efficiency = 0 |

?芸?????hydration step ??enforce:`dynamicSources` > RF tracer > defaultParams??

### 14.5 Bragg ?砍?(銝?)

```text
theta_B = asin(lambda * f_rf / (2 * v_acoustic))     # external-angle convention
theta_deflect(order) = order * 2 * theta_B
```

`refractiveIndex` ?冽 ABCD q propagation(`q_out = q_in + L/n`);**銝?*?冽 external deflection 閫漲?蝞rf_in.normalBodyLocal` ??蝜??帖???deflection 撟喲?抒??桐???)??
