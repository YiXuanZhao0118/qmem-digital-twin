[← Doc index](README.md)

# The core data model (the most important abstraction)

> Per-layer detail: [asset.md](asset.md), [component.md](component.md), [object.md](object.md); coordinate annotation in [anchors.md](anchors.md).

Four layers. **Param ownership is the spine rule of the whole system** — and it is enforced at the data layer by migrations 0094/0095/0096:

```
Asset3D    (geometry + anchors[] + defaultParams = physics ground truth + tunableParams flags)
   ▲  bound through the ComponentBinding tree (local transform, tunable axes, role_label)
Component  (vendorPart + binding tree + exposedFaces; ★no kind, no physics stored)
   ▲  instantiated as
SceneObject(Lab pose + dynamicSources)
```

1. **Asset3D** — a reusable 3D model plus its physics defaults. **Physics defaults exist only here.** → detail in [asset.md](asset.md).
2. **Component** — the catalog "template". **It has no kind and no physics parameters of its own.** → detail in [component.md](component.md).
3. **ComponentBinding** — a binding-tree node hanging an asset (or sub-component) under a parent. → detail in [component.md](component.md).
4. **SceneObject (Object)** — an instance placed in the scene. → detail in [object.md](object.md).

---

## Parameter merge order (`anchor_tracer.py`)

`effective = asset.defaultParams ⊕ (dynamicSources ∩ tunableParams)` (the latter wins). In practice `db_scene_loader` folds the SceneObject's `dynamic_sources` column into `dynamic` (plus the server-resolved AOM RF chain), and the tracer does `{**default_params, **dynamic}` (`anchor_tracer.py`). **transitions were removed in migration 0106**; **per-binding `param_overrides` was removed in migration 0113**.

- **Asset3D.tunableParams** (migration 0113) = the asset author's declaration of which top-level defaultParams keys may be tuned per instance. The PHY Editor puts a checkbox after each param; only checked keys appear in the SceneObject's editor.
- **The tunable contract (enforced by the backend)**: after merging `dynamic_sources`, `db_scene_loader` **drops every key that is a defaultParams key but is not in tunableParams** (`db_scene_loader.py`). So non-tunable parameters **always track the Asset** — leftover/legacy per-instance values (the whole beam that the old `write_laser_dynamic_sources` wrote into dynamic_sources, or `properties.opticalSources[0].beam`) can no longer shadow an Asset edit. Keys that are not asset params at all (aomFreqMhz, channels, … the runtime couplings) pass through untouched.
- **dynamicSources** = the runtime values of the whole instance. Only keys flagged in tunableParams take effect; this is how optics couples to electronics / RF / laser state:
  - laser_source: nominalPowerMw, centerWavelengthNm (tunable by default; the remaining beam parameters are decided by the asset). Note: when the emit op reads power, `nominalPowerMw` (the asset's own key) takes priority over the legacy `powerMw` / `laserPowerMw` aliases — which is what makes per-instance power tuning take effect (`emit_laser_source.py`).
  - aom: aomFreqMhz, rfDrivePowerW / aomRfVpp (fed in by the upstream RF chain; dynamicSources is the manual-override fallback).
  - rf_source: `channels[]` CH0–3 and `fullScaleVpp` are both coefficients in the asset's `default_params`, overridden per instance through `dynamic_sources` (tunable defaults to `["channels","fullScaleVpp"]`) — **the same model as optics**. The channel resolution chain is `dynamic_sources` → asset default → the old `kindParams.channels` (legacy fallback); the AD9959 panel's per-channel editing writes `dynamicSources.channels`. **Note that RF takes a separate path**: `rf_resolve.py` (not `db_scene_loader` / `anchor_tracer`) reads `asset.default_params` + `dynamic_sources` itself, with seed Vpp = `amplitudeScale × fullScaleVpp` (see [cable.md](cable.md)).
  - Limitation: dynamic_sources is per-object (not per-binding), so the several sub-assets of a composite share one copy — which is why tunable parameters suit single-asset source components (laser / rf_source).

Physics parameters come in two classes: `intrinsic_param_keys` (fixed by hardware — refractive index, crystal length — changeable only by the Asset) versus `state_param_keys` (runtime-adjustable — RF frequency, diffraction order). A kind's `state_param_keys` seeds the default for an Asset's `tunableParams` (backfilled by migration 0113, and seeded when the Asset editor creates a new row).

## Typed param schema + a generic editor (schema-driven UI)

So that we don't write "one UI per asset", a kind can declare **`physics.paramSchema`** in its plugin (`kinds/paramSchema.ts`: `ParamSpec` = `number` / `enum` / `boolean` / `record` / `list`) — a `number` coefficient renders as an input, an `enum` as a dropdown. **One** generic renderer (`components/physics/SchemaParamEditor.tsx`) draws every field plus its tunable checkbox from that schema, replacing per-asset bespoke editors (the device-registry plan's "❌ per-type editor branches"). The schema **lives on the kind** (behaviour layer, shared, DRY); the asset/device supplies the values; **list lengths are decided by anchors** (`cardinalityFromRole:"rf_out"` → 4 channels for the AD9959, 2 for the DG4202). `paramSchema` is **frontend-only** (like `optionalParams` — it does not go into the kinds.json manifest). First adopter: `rf_source` (2026-06-15; Phase 1 = the PHY editor's `Asset3DEditor` going through `DefaultParamsSchemaFields`, ending rf_source's raw-JSON editing). Per-instance editing in the Object panel and retiring `Ad9959ObjectControls` / the optical `InstanceDynamicSourcesEditor` into it are later phases. Widgets that don't generalise — the AD9959's sweep preview, FM-PM-AM profiles, derived SYS_CLK and so on — keep a bespoke escape hatch.
