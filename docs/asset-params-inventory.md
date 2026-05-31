# Asset 物理參數 & SceneObject 可調係數 — 完整清單

> 產生日期：2026-05-31
> 權威來源：[`backend/data/kinds.json`](../backend/data/kinds.json) 的 `physics_plugins[].physics.default_params`（28 種 element kind）。
> 本檔為純參考文件，數值請以 `kinds.json` 為準。

---

## 1. 資料模型：三層參數歸屬

| 層級 | 欄位 | 內容 |
|------|------|------|
| **Asset3D / Kind** | `default_params` (JSONB) | 物理預設值（出廠/型號級）。`backend/app/models/hardware.py:79,204` |
| **Component** | — | 不存物理參數 |
| **SceneObject** | `param_overrides` + `dynamic_sources` (JSONB) | per-instance 覆寫。`backend/app/models/scene.py:58-59` |

每個 kind 的 `default_params` 在 `kinds.json` 內再以兩個 key 列表標註用途：

- **`intrinsic_param_keys`** — 硬體固定（折射率、楔角、晶體長度…），不應被 dynamic 驅動。
- **`state_param_keys`** — 執行期可調狀態（RF 頻率、繞射階數、偏振軸…），對應 `dynamicSources`。

合併順序（`backend/app/optical/ray_tracer_v3.py`）：

```
effective = asset.defaultParams ⊕ paramOverrides[bindingId] ⊕ transition.params
dynamic   = sceneObject.dynamicSources
```

---

## 2. 全部 ASSET 物理參數（28 kinds）

### 2.1 光學 — Emitters / 增益

#### `laser_source` — Laser Source
| param | 預設 | 說明 |
|---|---|---|
| `centerWavelengthNm` | 780.241 | 中心波長 (nm) |
| `spectrum.centerThz` | 384.2306 | 中心頻率 (THz) |
| `spectrum.components[]` | `[{kind:"main", lineshape:"lorentzian", offsetMhz:0, fwhmMhz:0.1, amplitude:1}]` | 線型分量 |
| `spatialModeX` | `{waistUm:250, waistZOffsetMm:0, mSquared:1.05}` | X 軸高斯模 |
| `spatialModeY` | `{waistUm:80, waistZOffsetMm:1.2, mSquared:1.3}` | Y 軸（非對稱） |
| `transverseMode.kind` | `"TEM00"` | 橫模 |
| `polarization` | `{exRe:1, exIm:0, eyRe:0, eyIm:0}` | Jones 向量 |
| `nominalPowerMw` | 50 | 標稱功率 (mW) |

#### `tapered_amplifier` — Tapered Amplifier (TA)
| param | 預設 | 說明 |
|---|---|---|
| `smallSignalGainDb` | 30 | 小訊號增益 (dB) |
| `saturationPowerMw` | 500 | 飽和功率 (mW) |
| `minInputPowerMw` / `maxInputPowerMw` | 10 / 30 | 輸入功率窗 (mW) |
| `inputAcceptanceRadiusMm` | 25 | 輸入接收半徑 (mm) |
| `ase` | `{powerMw:5, bandwidthNm:1, centerOffsetNm:0}` | 自發輻射 (ASE) |
| `inputSpatialModeX` / `inputSpatialModeY` | `{waistUm:600, waistZOffsetMm:0, mSquared:1.5}` | 輸入模 |
| `inputPolarization` | `{exRe:0, exIm:0, eyRe:1, eyIm:0}` | 輸入偏振 |
| `outputSpatialModeX` | `{waistUm:500, waistZOffsetMm:0, mSquared:1.5}` | 輸出快軸 |
| `outputSpatialModeY` | `{waistUm:50, waistZOffsetMm:0, mSquared:8}` | 輸出慢軸（強非對稱） |
| `outputTransverseMode.kind` | `"TEM00"` | |
| `centerWavelengthNm` | 780 | (nm) |

### 2.2 光學 — 被動反射 / 聚焦

| kind | params（預設） |
|---|---|
| **`mirror`** | `reflectivity` 0.99；`wavelengthRangeNm` [400,1100] |
| **`dichroic_mirror`** | `cutoffWavelengthNm` 700；`passBand` "long"；`transmission` 0.95；`reflectivity` 0.95；`wavelengthRangeNm` [400,1100] |
| **`lens_biconvex`** | `focalMm` 100；`transmission` 0.99；`wavelengthRangeNm` [400,1100] |
| **`lens_plano_convex`** | `focalMm` 100；`transmission` 0.99；`wavelengthRangeNm` [400,1100] |
| **`lens_cylindrical`** | `focalMm` 100；`cylindricalAxis` "x"；`transmission` 0.99；`wavelengthRangeNm` [400,1100] |
| **`beam_dump`** | `absorption` 0.999；`wavelengthRangeNm` [400,1100] |

### 2.3 光學 — 偏振元件

**`waveplate`**（全部 intrinsic）
default_params：`retardanceLambda` 0.5、`transmission` 0.99、`wavelengthRangeNm` [400,1100]
intrinsic_param_keys：`retardanceLambda, retardanceDeg, transmission, designWavelengthNm, wavelengthRangeNm, lengthMm, thicknessMm, refractiveIndex, clearApertureMm, plateAlphaXRad, plateAlphaYRad, material, plateType`

**`polarizer`**
`transmissionAxisDegBeamLocal` 0、`extinctionRatioDb` 30、`transmission` 0.95、`wavelengthRangeNm` [400,1100]

**`glan_polarizer`** — Glan-Laser
state：**`transmissionAxisDegBeamLocal` 0**
intrinsic：`extinctionRatioDb` 55、`transmission` 0.92、`wedgeAngleDeg` 38.5、`airGapMm` 0.05、`lengthMm` 7.5、`refractiveIndex` 1.48、`airGapAstigmatismMm` 0.05、`augmentedOffsetXMm` 0、`coatingNormalBodyLocal` [0, 0.7826, 0.6225]、`wavelengthRangeNm` [400,1100]

**`beam_splitter`**（含 PBS）
`splitRatioTransmitted` 0.5、`polarizing` false、`transmissionAxisDegBeamLocal` 0、`extinctionRatioDb` 30、`transmission` 0.99、`coatingNormalBodyLocal` [0.7071, 0.7071, 0]、`wavelengthRangeNm` [400,1100]

### 2.4 光學 — 調變 / 非線性

**`aom`** — AOM
state：**`diffractionOrder` 1**
intrinsic：`baseEfficiency` 0.85、`deflectionPerMhzUrad` 200、`acousticVelocityMPerS` 4200、`modulationBandwidthMhz` 20、`refractiveIndex` 2.26、`figureOfMeritM2` 3.4e-14、`crystalLengthMm` 25、`acousticBeamWidthMm` 1.5、`rfPowerMaxW` 2、`acousticAxisBodyLocal` [-1,0,0]、`rfPropagationDirectionBodyLocal` [-1,0,0]、`braggAngularAcceptanceMrad` 2、`wavelengthRangeNm` [400,1700]

**`eom`** — EOM
`vPiV` 5、`modulationKind` "phase"、`modulationBandwidthMhz` 100、`insertionLossDb` 3、`wavelengthRangeNm` [400,1700]

**`nonlinear_crystal`**
`process` "SHG"、`chi2PmPerV` 4.5、`lengthMm` 10、`walkOffUrad` 0、`wavelengthRangeNm` [400,1700]

**`saturable_absorber`**
`saturationIntensityWPerCm2` 1e6、`modulationDepth` 0.5、`nonSaturableLoss` 0.05、`recoveryTimePs` 1、`wavelengthRangeNm` [400,1700]

### 2.5 光學 — 光纖

| kind | params |
|---|---|
| **`fiber_coupler`** | `couplingEfficiency` 0.7；`modeFieldDiameterUm` 5；`fiberType` "single_mode"；`wavelengthRangeNm` [400,1100] |
| **`fiber`** | `fiberType` "polarization_maintaining"；`endA`/`endB`（`apertureDiameterMm` 0.125, `numericalAperture` 0.13, `modeFieldDiameterUm` 5.3, `coreDiameterUm` 4.4, `claddingDiameterUm` 125, `connectorType` "FC", `polish` "PC", `polishAngleDeg` 0, `fresnelResidual` 1, `glassIndexAtDesignLambda` 1.4506, `slowAxisDegInBodyFrame` 0）；`cutoffWavelengthNm` 730；`wavelengthRangeNm` [770,790]；`designWavelengthNm` 780；`maxInputPowerMw` 500；`attenuationCurve` [{wavelengthNm:780, dbPerKm:5}]；`bendLoss`（`vNumber` 2, `coreRadiusUm` 2.2, `nCore` 1.4506, `nClad` 1.45, `criticalRadiusMm` 25）；`minBendRadiusMm` 25；`birefringenceDeltaN` 5e-4；`pmdCoefficientPsPerSqrtKm` 0.05；`polarizationExtinctionRatioDb` 25；`bandwidthMhzKm` null；`randomJonesSeed` null |

### 2.6 光學 — 感測器

| kind | params |
|---|---|
| **`detector`** | `responsivityAPerW` 0.5；`quantumEfficiency` 0.8；`bandwidthMhz` 1000；`saturationPowerMw` 10；`wavelengthRangeNm` [400,1100] |
| **`camera`** | `resolutionPx` [1024,1024]；`pixelSizeUm` 5.5；`quantumEfficiency` 0.5；`wellDepthE` 20000；`wavelengthRangeNm` [400,1100] |
| **`spectrometer`** | `resolutionPm` 10；`wavelengthRangeNm` [400,1100] |
| **`wavemeter`** | `precisionMhz` 1；`wavelengthRangeNm` [400,1100] |

### 2.7 電子 / RF

**`rf_source`** — RF Source (AD9959)
state（可調）：`frequencyMhz` 80、`powerDbm` 0、`phaseDeg` 0、`modulation` "none"、`channels` null
intrinsic：`referenceClockMhz` null、`sysClockMhz` null、`pllMultiplier` 25、`pllBypass` false、`serialInterface` null、`syncRole` "standalone"、`serialPortMode` "4wire"

**`rf_amplifier`**（全 intrinsic）
`gainDb` 29、`frequencyRangeMhz` [5,500]、`outputPowerP1dbDbm` 29、`outputPowerMaxDbm` 30、`inputPowerMaxDbm` 0、`noiseFigureDb` 9、`supplyVoltageV` 24、`supplyCurrentA` 0.6、`inputReturnLossDb` 14、`outputReturnLossDb` 14、`connectorType` "sma"

**`horn_antenna`**
`frequencyGhz` 9.2、`gainDbi` 12、`beamwidth3dbDeg` 30、`polarAxisBodyLocal` [0,0,1]、`cosineExponent` 8

**`programmable_pulse_generator`**
`connectorType` "sma"、`timingProgramId` null、`outputDomain` "ttl"、`highVoltageV` 3.2

**`rf_cable`**
`lengthMm` 152、`impedanceOhm` 50、`maxFrequencyGhz` 3、`connectorType` "sma"、`cableType` "RG-316"、`jacketOuterDiameterMm` 3.2、`jacketColor` "#c4a884"、`workingVoltageVRms` null、`dielectricVoltageVRms` null、`minBendRadiusMm` 15

**`rf_switch`**
`switchType` "SP2T"、`throwCount` 2、`frequencyMinGhz` 0、`frequencyMaxGhz` 5、`insertionLossDb` 1、`isolationDb` 35、`switchingTimeNs` 250、`absorptionType` "absorptive"、`controlLogic` "TTL"、`controlVoltageHighV` 5、`supplyPositiveV` 5、`supplyNegativeV` -5、`supplyCurrentMa` 25、`maxInputPowerDbm` 27、`ttlActiveHighThrow` 2、`ttlState` "LOW"、`manufacturer` "Mini-Circuits"、`model` "ZYSWA-2-50DR"、`datasheetUrl`

> 純機械/被動件（mirror_mount、post、clamp、chassis、optical_table…）位於 `passive_plugins`（24 種），`default_params` 為空，無物理參數。

---

## 3. SceneObject 可調係數

SceneObject 透過**兩個獨立機制**覆寫 asset 預設（`docs/asset-physics-model.md:298-332`）。

### 3.1 `paramOverrides` — per-binding 靜態校準
結構：`{ [bindingId: string]: Partial<KindParams> }`
用途：對某 binding 校準該 kind 的任一物理係數（原則上 `default_params` 內任何 key 皆可覆寫）。
範例：waveplate 實測 `retardanceDeg = 88`（覆寫預設 90）。

### 3.2 `dynamicSources` — per-instance 執行期值
結構：扁平 JSON（整個 instance 共用，不分 binding）。文件列出的 key：

| kind | dynamicSources key |
|---|---|
| `laser_source` | `powerMw`/`laserPowerMw`、`centerWavelengthNm`、`spectrum`、`polarization`、`spatialEnvelope`/`spatialModeX/Y`、`transverseMode` |
| `aom` | `aomFreqMhz`/`rfFrequencyMhz`、`rfDrivePowerW`/`aomRfVpp`/`aomRfPowerDbm` |
| `rf_source` | `channels[]`：`{anchorName(CH0~3), frequencyMhz, amplitudeScale, phase?, sweepParams?}`；fallback `frequencyMhz` + `powerDbm` |

> AOM 的 RF setpoint 慣例由上游 RF chain 餵入（rf tracer hydration）；`dynamicSources.aomFreqMhz` 為手動 override 後備（`asset-physics-model.md` §14.4）。

### 3.3 編輯器 UI（前端控制面板）
- **`LaserSourceControls.tsx`** — power、wavelength、spectrum(δ/gaussian/lorentzian/voigt)、polarization、spatialModeX/Y、transverseMode
- **`TaperedAmplifierAdjustControls.tsx`** — 操作點(波長/驅動電流)、增益/ASE 查表、輸入/輸出/反向 beam mode
- **`AomAdjustControls.tsx`** — Bragg 幾何、RF 設定、`baseEfficiency`、`diffractionOrder(±1/0)`、兩階段對齊
- **`SimpleAdjustControls.tsx`** — 其餘 kind 的通用面板

路徑：`frontend/src/components/physics/`

### 3.4 偏振 / 反射件的 per-instance 幾何（走 V2 anchor bindings，不在 dynamicSources）
`backend/app/v2_bindings.py`：
- `mirror` / `beam_splitter`：`opticalSurface.normalBodyLocal`（鍍膜法線）
- `waveplate`：`polarizationReference` role "fast"、`axisDegBeamLocal`（快軸角）
- `polarizer` / PBS：`polarizationReference` role "transmission"、`axisDegBeamLocal`

---

## 4. 一句總結

Asset 的 `default_params` 是出廠值（28 種 kind，分 `intrinsic`／`state` 兩類）；SceneObject 只能透過 `paramOverrides`（per-binding 靜態校準，可動任一係數）與 `dynamicSources`（執行期值，主要是 laser power/wavelength/spectrum/polarization、AOM freq/RF power、RF source channels）兩個 JSONB 欄位覆寫。其中標記為 **`state_param_keys`** 的，即設計上預期會被執行期調整的係數。
