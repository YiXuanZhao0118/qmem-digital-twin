# Optical Schema V2 — Target Architecture

> **Status (2026-05-10):** §3 (V2 finalized) is the source of truth. §1 and §2 are kept as design history; both are superseded by §3.

This file holds the **target / planning** schema for QMsimulation's optical data model. It documents the next iteration of how `assets_3d.anchors[]`, `objects.properties.anchorBindings[]`, `objects.properties.opticalSources[]`, `optical_elements.kind_params`, `optical_links`, and solver outputs should be organised.

For the **current** code state (existing tables, kinds, physics formulas), see [../../Learning.md](../../Learning.md). For the project snapshot, see [vibe coding.md](vibe%20coding.md).

---

## Table of contents

1. [Architecture Note (historical, 2026-05-10)](#1-architecture-note-historical)
2. [Optical data planning v2 (historical)](#2-optical-data-planning-v2-historical)
3. [V2 finalized optical schema draft (authoritative)](#3-v2-finalized-optical-schema-draft-authoritative)
4. [Future refinements](#4-future-refinements)

---

## 1. Architecture Note (historical)

> Superseded by §3. Kept for the early design rationale around the asset / anchor boundary.

> Planning note, 2026-05-10. This documents the target architecture for the next refactor. No code behavior should be assumed from this note until the implementation lands.

`assets_3d` describes the reusable CAD / 3D asset itself:

- `name`: searchable asset name, for example `thorlabs_pbs252_asset`.
- `asset_type`: file / viewer type, for example `glb`, `stl`, `step`, `edrawing_html`.
- `file_path`: asset path under `ASSET_ROOT`, for example `uploads/pbs252.glb`.
- `unit`: source model unit, currently `mm` or `m`.
- `scale_factor`: render/import scale applied to the source model.
- `anchors[]`: physics interaction points on the asset, in body-local coordinates.

Target `components` shape:

```json
{
  "id": "component_uuid",
  "name": "AA Optoelectronic MT80-A1.5-IR",
  "componentType": "aom",
  "brand": "AA Optoelectronic",
  "model": "MT80-A1.5-IR",
  "asset3dId": "asset_uuid",
  "documentation": {
    "datasheetUrl": "https://...",
    "productUrl": "https://...",
    "sourceUrl": "https://...",
    "description": "AOM catalog entry"
  },
  "notes": "User notes",
  "createdAt": "...",
  "updatedAt": "...",
  "archivedAt": null
}
```

Component rules:

- `components` is catalog / documentation only.
- Remove target `properties`; old `components.properties` is legacy compatibility only.
- Remove target `physics_capabilities`; PhysicsCapability is derived from asset anchors, object data, optical elements, and connections.
- `componentType` is catalog classification only. It is not a physics capability.
- `documentation` is human-facing metadata; solver, renderer, and physics code should not read it as authoritative physics input.

Target `anchors[]` shape:

```json
{
  "id": "aom_mt80_optical_input",
  "name": "Optical input",
  "type": "optical",
  "positionMmBodyLocal": { "x": -12.5, "y": 0, "z": 8 },
  "directionBodyLocal": { "x": 1, "y": 0, "z": 0 }
}
```

Anchor rules:

- All persistent ids should be UUIDv7 strings. This applies to DB rows and JSONB child records such as asset anchors, anchor bindings, optical sources, ports, links, revisions, and simulation runs.
- `id` is a stable opaque reference. Do not derive it from names or roles like `intercept_in` / `intercept_out`; use `name` for searchable human labels.
- `name` is human-facing, mutable, and may be duplicated. `id` is machine-facing, immutable, and should not encode object name, vendor name, role, or physical meaning.
- `type` is exactly one `PhysicsCapability`: `optical`, `rf`, `em`, `thermal`, `fluid`, `quantum`, or `stress`.
- Only physics interaction points are allowed in `anchors[]`; pure mounting holes, screw holes, body centers, and generic CAD alignment points are out of scope.
- `positionMmBodyLocal` and `directionBodyLocal` are CAD geometry facts.
- `aperture` is not stored on the asset anchor. It belongs to the scene object instance as part of an anchor-bound optical surface / port surface / detector area.
- IDs should be stable opaque references. Do not derive ids from object names, anchor names, or roles such as `binding_aom_001_optical_input_aperture`; use `name`, `kind`, `anchorId`, and tags for human search.

Target ID rules:

| Record | Recommended id | Scope | Notes |
|--------|----------------|-------|-------|
| DB rows | UUIDv7 | global | Generated on create. |
| `assets_3d.anchors[]` | UUIDv7 | global | `name` carries labels such as "AOM optical input". |
| `objects.properties.anchorBindings[]` | UUIDv7 | global | Do not include object name, anchor name, or binding kind in id. |
| `objects.properties.opticalSources[]` | UUIDv7 | global | Source is trace target for `beam_segments.sourceId`. |
| inline OpticalPort records | UUIDv7 | object-local reference, globally unique string | Stored inline for now; no separate table in the recommended target. |
| `optical_links` | UUIDv7 | global | Connects ports, not bindings directly. |
| `revisions` / `simulation_runs` | UUIDv7 | global | Revision = input snapshot; SimulationRun = solver artifact. |

Example id style:

```json
{
  "id": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9a11",
  "name": "AOM optical input",
  "kind": "opticalPortSurface"
}
```

Target layer boundary:

| Layer | Purpose | Example |
|------|---------|---------|
| `assets_3d.anchors[]` | reusable physics interaction geometry | opaque `id`, `name: "AOM MT80 optical input"`, `type: "optical"`, position + direction |
| `components` | catalog / documentation only | component type, brand, model, datasheet, linked asset |
| `objects.properties.anchorBindings[]` | per-instance geometry-only start / contact points and surfaces | binding `id` + `anchorId` + `kind` + `frame` + geometric `payload` |
| `objects.properties.opticalSources[]` | per-instance emitted beam definitions | source id + `bindingId`, wavelength, power, spectrum, polarization, spatial envelope |
| `optical_elements.kind_params{}` | per-instance optical transfer / interaction physics | AOM RF direction/order, PBS polarization behavior, TA gain parameters |
| `beam_segments` | solver propagation output, traceable to an object source | `sourceId`, `previousSegmentId`, `stateAtStart`, `stateAtEnd` |
| `device_states.state{}` | runtime state | enabled, temperature, lock state |

Example: one AOM asset may define both an optical input anchor (`type: "optical"`) and an RF input anchor (`type: "rf"`). The anchor tells the system where the interaction point is and which physics domain owns it. The actual aperture, RF drive power, diffraction order, and measured optical behavior live on the scene object / optical element, because each physical instance can differ.

Target anchor binding rules:

- `objects.properties.anchorBindings[]` is the object-instance layer that connects reusable asset anchors to physical instance geometry.
- `anchorBindings[]` only defines where a beam starts, enters, exits, hits, or is detected. It does not define beam propagation parameters.
- Each binding has an opaque `id`; readable labels belong in `name`.
- `anchorId` references `assets_3d.anchors[].id`.
- `kind` declares what the binding physically represents, for example `opticalSurface`, `opticalPortSurface`, `detectorArea`, `interactionVolume`, `modeField`, or `calibrationPoint`.
- `payload` is geometry / calibration geometry only, such as aperture shape, surface category, active detector area, or interaction-volume extents. It must not contain wavelength, power, spectrum, polarization, q-parameters, linewidth, reflectivity, gain, RF power, diffraction order, or other propagation / transfer physics.
- `normalBodyLocal` belongs in `anchorBindings[].payload`, not in `assets_3d.anchors[]`.
- `aperture` is not a standalone binding kind. When an aperture exists, it is stored inside the relevant `opticalSurface`, `opticalPortSurface`, or `detectorArea` payload.
- Aperture dimensions always use half-length physical definitions:
  - `circle.rMm` = radius.
  - `ellipse.xMm` / `ellipse.yMm` = semi-axis lengths.
  - `rectangle.xMm` / `rectangle.yMm` = half-width / half-height.
- Aperture clipping in the binding frame:
  - circle: `x^2 + y^2 <= rMm^2`.
  - ellipse: `(x / xMm)^2 + (y / yMm)^2 <= 1`.
  - rectangle: `abs(x) <= xMm && abs(y) <= yMm`.

Target anchor binding shape:

```json
{
  "id": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9b01",
  "name": "Mirror reflective surface",
  "anchorId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9b02",
  "kind": "opticalSurface",
  "frame": "anchorLocalXY",
  "payload": {
    "surfaceType": "reflective",
    "aperture": {
      "shape": "circle",
      "rMm": 12.7
    }
  }
}
```

Target `frame` rules:

- `frame` defines how numbers inside `payload` are interpreted. It does not replace the asset anchor position / direction.
- `anchorLocalXY` is the default for surface-like payloads. Origin = anchor position, local +Z / normal = anchor direction, and X/Y span the tangent plane. Aperture tests use these X/Y coordinates.
- The X/Y tangent axes are not guessed by a global formula. They are defined by the optical kind / component contract. If an anisotropic aperture needs explicit orientation, the geometry-only binding payload may carry `xAxisBodyLocal`; `yAxisBodyLocal` is derived from `zAxis = anchor.directionBodyLocal` and `xAxisBodyLocal`.
- `bodyLocal` is for 3D payloads tied to object body axes, for example an interaction volume or crystal axis reference.
- `lab` should be reserved for measured/calibrated output or solver output. Reusable setup geometry should avoid lab-frame payloads.
- Renderer uses `frame` to draw aperture overlays; solver uses it to clip beams, compute coupling, and transform surface coordinates into lab coordinates.

Recommended `anchorLocalXY` basis by kind:

| Kind | Local Z / normal | Local X/Y rule |
|------|------------------|----------------|
| `laser_source` | output anchor direction | X/Y from source head output convention; no aperture is required. |
| `mirror` | reflective surface normal | X/Y from mirror face tangent axes in the component/kind contract. |
| `lens` | optical axis | X/Y from lens clear-aperture plane; circular lens can ignore roll, cylindrical lens must define cylinder axis. |
| `pbs` / `beam_splitter` | interface normal or port direction | X/Y from cube/interface convention; transmitted/reflected branches use port-specific bindings. |
| `aom` | optical port direction | X = aperture horizontal / acoustic interaction width, Y = crystal height or kind-defined vertical axis. |
| `detector` / `camera` | detector normal | X/Y from sensor pixel axes. |

If a kind cannot define stable X/Y from its CAD/body convention, it must require an explicit `xAxisBodyLocal` in the binding geometry payload.

Target `kindParams` policy:

- `elementKind`, required `anchorBindings[]`, required ports, units, frame conventions, and branch names should be strict.
- `kindParams{}` should remain model-flexible while the optical kinds are still being planned.
- Prefer a loose shape like `{ "model": "...", "params": {} }` or kind-specific top-level groups over over-normalizing too early.
- Do not force every kind into one solver model, for example do not assume all coupling must be `gaussian_overlap`.
- Later, each `elementKind` can tighten its allowed `kindParams` schema after the required physical model is clear.

Target OpticalPort rules:

- `OpticalPort` should be an independent optical graph endpoint, but it should not duplicate geometry or beam parameters.
- Each port references a binding through `bindingId`; the binding points to an asset anchor and carries geometry-only payload such as direction, surface, aperture, or detector geometry when that kind needs it.
- Port ids are UUIDv7 strings. Human labels such as `input`, `output`, `reflected`, or `+1 order` belong in `name` / `role` / `branchKind`, not in `id`.
- Recommended storage: keep ports inline on the owning `optical_elements` record for now. Do not create an `optical_ports` table unless ports later need independent CRUD, permissions, or cross-object lifecycle.
- Geometry resolves through `bindingId`. Beam parameters stay in `opticalSources[].beam` or solver state.

```json
{
  "id": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9a11",
  "role": "output",
  "branchKind": "main",
  "name": "Main output",
  "bindingId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9a12"
}
```

Target `optical_links` rules:

- `optical_links` connects ports, not just objects.
- Source of truth for endpoint geometry is `object -> optical port -> bindingId -> anchorId -> asset anchor + object pose`.
- Recommended target schema does not store `from_binding_id` / `to_binding_id`; those are derived from the referenced ports. If they are ever materialized, treat them as cache only and validate against the ports.
- `free_space_mm` should usually be derived from object poses and endpoint bindings. Store it only as a cache, manual override, or simulation snapshot field when needed.
- `OpticalPort` and `optical_links` are different concepts: a port is an endpoint on one object; a link is an edge connecting two object ports.

```json
{
  "id": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9a21",
  "fromObjectId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9a31",
  "fromPortId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9a32",
  "toObjectId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9a41",
  "toPortId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9a42",
  "status": "valid",
  "properties": {
    "medium": "air",
    "manualDistanceOverrideMm": null
  }
}
```

Target per-kind schema rules:

Each optical kind is defined by three layers:

| Layer | Stores | Does not store |
|-------|--------|----------------|
| `anchorBindings[]` | geometry-only start/contact/surface/detector/volume payloads | wavelength, power, polarization, RF power, reflectivity, gain |
| `objects.properties.opticalSources[].beam` | emitted beam source parameters | mirror/lens/AOM transfer physics |
| `optical_elements.kind_params` | transfer / interaction physics | reusable CAD geometry or source beam identity |

Strict per-kind optical planning:

In this table, "object propagation" means object-instance data, primarily `optical_elements.kind_params`; for emitted light it also includes `objects.properties.opticalSources[].beam`. None of these propagation / transfer fields belong in `assets_3d.anchors[]` or `components`.

| Kind | `anchorBindings[]` geometry definition | Object-defined propagation / transfer |
|------|----------------------------------------|---------------------------------------|
| `laser_source` | defines output position and output direction through `emissionReference`; no required aperture | source beam is defined by `objects.properties.opticalSources[].beam` |
| `mirror` | defines reflective surface center and reflective surface normal | reflected / transmitted branches, reflectivity, transmission; coating phase only in an advanced coating model |
| `lens_biconvex` | default: defines lens body center and optical axis; physical side faces are optional for thick-lens or surface-aware models | local focus / focal length behavior, transmission, aberration model later |
| `lens_plano_convex` | defines plane surface center; normal points from the plane center toward the convex side | local focus / focal length behavior, orientation-dependent focusing, transmission |
| `waveplate` | defines body center and an in-plane axis vector; this vector is the waveplate short axis | HWP / QWP / arbitrary retardance, retardance phase, wavelength behavior |
| `polarizer` | defines body center and polarization axis vector | polarizer transmission axis, extinction ratio, loss |
| `beam_splitter` | defines internal reflective / splitting surface and surface normal | reflected / transmitted branches, split ratio, phase convention |
| `pbs` | defines internal reflective / splitting surface and surface normal | reflected / transmitted branches plus polarization-dependent splitting / extinction |
| `detector` / `camera` / `spectrometer` / `wavemeter` | defines receiving position and receiving surface normal pointing toward incoming beam | sink behavior: has `from` input and no optical `to` output; responsivity/readout/spectral measurement |
| `fiber` / `fiber_coupler` | defines two connector endpoints A/B, receiving/emitting surface positions, outward surface normals, and per-end polarization reference directions | bidirectional propagation from A to B and from B to A, coupling, loss, PM/SM/MM behavior |
| `aom` | defines two optical side endpoints A/B, optical face positions, outward face normals, and RF direction | AOM theory computes diffraction order angles and powers from object params |
| `eom` | defines two optical side endpoints A/B, outward face normals, optical polarization reference direction, and optional RF direction | EOM theory computes modulation sideband/order powers from object params |
| `nonlinear_crystal` | defines two optical side endpoints A/B, outward face normals, optical polarization / crystal-axis reference direction | nonlinear interaction / phase matching / generated branches from object params |
| `isolator` | defines two optical side endpoints A/B, outward face normals, and optical polarization reference direction | forward transmission and reverse isolation from object params |

Per-kind anchor convention details:

- Lens kind is split into `lens_biconvex` and `lens_plano_convex`; do not rely on a generic `lens` binding contract when surface geometry matters.
- For biconvex lenses, body center is the symmetric reference. A simple/thin-lens model does not require separate side-face bindings; add side-face bindings only when a thick-lens, collision, rendering, or surface-aware model needs them.
- Future thick-lens models must add side-face bindings and curvature fields such as surface radius / radius of curvature, thickness, refractive index, and sign convention.
- For plano-convex lenses, the plane center is the reference; the plane normal points toward the convex side, so orientation is unambiguous.
- Waveplate and polarizer both require an in-plane optical axis vector. For waveplate it is the short-axis reference; for polarizer it is the transmission / polarization axis reference.
- Detector-like devices are terminal optical sinks in the beam graph: links enter them, but they do not emit an optical output unless a special reflective/readout model is explicitly added.
- AOM uses outward optical face normals for A/B and a separate RF direction. Diffraction branch geometry is not pre-baked into anchors; it is computed from object propagation params.
- EOM / nonlinear crystal / isolator use the same A/B outward-face convention as AOM for optical endpoints. RF direction exists only for kinds that physically need it.

Target data that should not be independent yet:

| Candidate | Recommendation | Reason |
|-----------|----------------|--------|
| `optical_ports` table | Do not create yet; keep inline on `optical_elements` | Ports belong to one object and do not need independent lifecycle yet. |
| `apertures[]` | Do not create; keep inside `anchorBindings[].payload.aperture` | Aperture is one-to-one with surface / port surface / detector area. |
| `from_binding_id` / `to_binding_id` on links | Do not store as source of truth | Derivable from `fromPortId` / `toPortId`. |
| laser `kind_params` beam fields | Do not use | Source beam belongs in `objects.properties.opticalSources[].beam`. |
| `beam_paths` as authoritative DB state | Avoid | It should be derived render/cache data from `beam_segments`. |

Target revisions / snapshots:

- `Revision` stores scene input state. It answers: "what did the scene look like?"
- `SimulationRun` stores solver output. It answers: "what did this solver run compute?"
- Do not mix `beam_segments` into the canonical scene revision. Treat them as simulation artifacts linked to a revision.

Recommended `revisions` shape:

```json
{
  "id": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0ca01",
  "name": "Before AOM alignment",
  "createdAt": "2026-05-10T12:00:00Z",
  "sceneInput": {
    "objects": [],
    "opticalElements": [],
    "opticalLinks": [],
    "assemblyRelations": []
  },
  "assetRefs": [],
  "componentRefs": []
}
```

Recommended `simulation_runs` shape:

```json
{
  "id": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0ca11",
  "revisionId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0ca01",
  "solverVersion": "optical-solver-v1",
  "status": "completed",
  "warnings": [],
  "outputs": {
    "beamSegments": [],
    "beamPathCache": []
  }
}
```

Object-scoped optical source records:

- Do not use an asset anchor id as the primary key for object beam parameters.
- `assets_3d.anchors[].id` is a model / geometry reference only.
- `objects.properties.opticalSources[]` stores instance beam sources. Each item has its own object-scoped `id` and a `bindingId` reference to the output/start binding.
- The source `id` should be a stable opaque object-scoped id. Do not derive it from object name or anchor name. The `bindingId` only says which object-local start geometry this source emits from.
- All beam propagation parameters live in the source `beam` object: wavelength, power, spectrum/linewidth, polarization, spatial envelope / q-parameters, and transverse-mode metadata.

Target BeamSource / BeamState rules:

- `objects.properties.opticalSources[].beam` is the editable source definition.
- `objects.properties.opticalSources[].enabled` means whether this laser source is on. If `enabled: false`, the solver does not create an initial beam from this source.
- `BeamState` is the solver's propagated state. It is initialized from the source, then updated by propagation and optical interactions.
- Laser spectrum source of truth is `spectrum.centerWavelengthNm`. Do not store both `centerThz` and `centerWavelengthNm` as editable fields; frequency is derived from wavelength.
- `powerMw` is total optical power for the source / state.
- Basic `laser_source` spectrum does not use `carrier`, `components[]`, `offsetMhz`, or `powerFraction`.
- Multi-component spectra, combs, AOM-shifted branches, and EOM sidebands are advanced solver/element outputs or future source models, not the default laser source schema.
- `spectrum.linewidth.kind: "delta"` is ideal zero linewidth and has no width parameter. Real lasers should use `lorentzian`, `gaussian`, `voigt`, or `measured`.
- `lorentzian` / `gaussian` linewidths require `fwhmHz`. `voigt` requires `gaussianFwhmHz` and `lorentzianFwhmHz`.
- Jones polarization is normalized: `|Ex|^2 + |Ey|^2 = 1`. Total power stays in `powerMw`.
- `spatialEnvelope` should describe both the source transverse profile and the propagation model. It should not be limited to ideal Gaussian beams.
- `transverseMode` describes modal family/order and is not a replacement for `spatialEnvelope`.

`elliptical_gaussian` + `m2_gaussian` rule:

- For Gaussian-like beams, the editable source of truth should be `spectrum.centerWavelengthNm`, `waistRadiusUm`, `waistZOffsetMm`, and `mSquared` for each transverse axis.
- `divergenceMrad` and `rayleighRangeMm` should normally be derived, not edited independently.
- The far-field half-angle divergence for each axis is:

```text
theta_x_rad = M2_x * lambda_m / (pi * w0_x_m)
theta_y_rad = M2_y * lambda_m / (pi * w0_y_m)
```

- The M2-corrected Rayleigh range for each axis is:

```text
zR_x_m = pi * w0_x_m^2 / (M2_x * lambda_m)
zR_y_m = pi * w0_y_m^2 / (M2_y * lambda_m)
```

- Equivalently, when `theta` is already physically consistent:

```text
zR_x_m = w0_x_m / theta_x_rad
zR_y_m = w0_y_m / theta_y_rad
```

- Beam radius evolution from each waist is:

```text
w_x(z)_m = w0_x_m * sqrt(1 + ((z_m - waistZOffsetX_m) / zR_x_m)^2)
w_y(z)_m = w0_y_m * sqrt(1 + ((z_m - waistZOffsetY_m) / zR_y_m)^2)
```

- If a user provides both waist and divergence as editable measured values, validate them against `spectrum.centerWavelengthNm` and M2. X/Y should imply the same wavelength for a single-frequency source; otherwise the source is inconsistent or needs an explicit measured/astigmatic model.

`transverseMode` and `mSquared` consistency:

- `transverseMode` defines the ideal modal family/order.
- `mSquared` defines the actual propagation quality used by the envelope model.
- For `HG(m,n)` modes, the ideal theoretical values are:

```text
M2_x_theory = 2m + 1
M2_y_theory = 2n + 1
```

- For a pure theoretical mode, use:

```text
mSquaredX = M2_x_theory
mSquaredY = M2_y_theory
```

- For a measured/nonideal beam, require:

```text
mSquaredX >= M2_x_theory
mSquaredY >= M2_y_theory
```

- For `HG00` / `TEM00`, ideal M2 is 1 on both axes. If `mSquared > 1`, it represents wavefront distortion or nonideal beam quality.
- For higher-order modes, do not allow `mSquared` below the modal theory value. Example: `HG10` requires `mSquaredX >= 3` and `mSquaredY >= 1`.

Target optical source shape:

```json
{
  "id": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0cb01",
  "bindingId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0cb02",
  "enabled": true,
  "beam": {
    "powerMw": 20,
    "spectrum": {
      "centerWavelengthNm": 780.241,
      "wavelengthReference": "vacuum",
      "linewidth": {
        "kind": "lorentzian",
        "fwhmHz": 100000
      }
    },
    "polarization": {
      "basis": "beamLocalXY",
      "normalization": "unit_jones",
      "jones": { "exRe": 1, "exIm": 0, "eyRe": 0, "eyIm": 0 }
    },
    "spatialEnvelope": {
      "transverseProfile": {
        "kind": "elliptical_gaussian",
        "x": { "waistRadiusUm": 500 },
        "y": { "waistRadiusUm": 200 },
        "hardAperture": null
      },
      "propagation": {
        "model": "m2_gaussian",
        "x": { "waistZOffsetMm": 0, "mSquared": 1.2 },
        "y": { "waistZOffsetMm": 0, "mSquared": 1.5 },
        "derived": {
          "divergenceXMrad": "computed from centerWavelengthNm, waistRadiusUm, mSquared",
          "divergenceYMrad": "computed from centerWavelengthNm, waistRadiusUm, mSquared",
          "rayleighRangeXMm": "computed from centerWavelengthNm, waistRadiusUm, mSquared",
          "rayleighRangeYMm": "computed from centerWavelengthNm, waistRadiusUm, mSquared"
        }
      }
    },
    "transverseMode": {
      "family": "HG",
      "m": 0,
      "n": 0,
      "label": "TEM00"
    }
  }
}
```

This keeps one CAD output anchor reusable across many scene objects while letting every physical laser instance carry its own start binding, on/off state, wavelength, power, spectrum, polarization, and beam envelope.

Target laser source per-kind schema:

| Layer | Laser source data |
|-------|-------------------|
| `anchorBindings[]` | one output/start `emissionReference` binding with position/direction; aperture is not required |
| inline OpticalPort | one `role: "output"`, `branchKind: "main"` port referencing the output binding |
| `objects.properties.opticalSources[]` | one or more emitted beams, each referencing a start `bindingId` and carrying the editable `beam` definition |
| `optical_elements.kind_params` | no beam propagation fields; only device-level non-beam metadata if needed later |

Target laser source object skeleton:

```json
{
  "objects.properties": {
    "anchorBindings": [
      {
        "id": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0cb02",
        "name": "Laser output",
        "anchorId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0cb03",
        "kind": "emissionReference",
        "frame": "anchorLocalXY",
        "payload": {
          "normalBodyLocal": [1, 0, 0]
        }
      }
    ],
    "opticalSources": [
      {
        "id": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0cb01",
        "bindingId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0cb02",
        "enabled": true,
        "beam": "<BeamSource>"
      }
    ]
  },
  "opticalElement": {
    "elementKind": "laser_source",
    "outputPorts": [
      {
        "id": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0cb04",
        "role": "output",
        "branchKind": "main",
        "name": "Main output",
        "bindingId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0cb02"
      }
    ],
    "kindParams": {}
  }
}
```

BeamState initialization from a laser source:

```text
source.bindingId
  -> anchorBindings[].payload gives output direction / frame
  -> anchorBindings[].anchorId gives asset anchor position + direction
  -> object pose transforms anchor geometry to lab frame
  -> source.beam initializes spectrum, power, polarization, spatialEnvelope, transverseMode
  -> solver creates BeamState_0 with sourceId and start geometry
```

Target beam propagation / beam segment rules:

- `beam_segments` is solver output only. Users do not manually define beam parameters here.
- Every segment state must be traceable to one `objects.properties.opticalSources[].id`.
- The first beam state is initialized from the source record's `beam` definition and the geometry resolved from `source.bindingId -> anchorBindings[] -> assets_3d.anchors[]`.
- Free-space propagation updates spatial envelope / q-parameters across the distance resolved from `optical_links` endpoints. `free_space_mm` is optional cache / override data, not the only geometry source.
- Optical interactions update the beam through `optical_elements.kind_params`, for example mirror reflectivity or PBS branch polarization.
- `stateAtStart` and `stateAtEnd` are snapshots produced by the solver. They should not be treated as source of truth.
- `previousSegmentId` links a segment to the segment that produced it, so the full propagation chain is auditable.
- `interactionObjectId`, `interactionKind`, and `branch` record the element / branch that generated the segment, for example `mirror/reflected`, `pbs/transmitted`, or `aom/+1`.

Target `beam_segments` shape:

```json
{
  "id": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0cc01",
  "simulationRunId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0ca11",
  "sourceId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0cb01",
  "previousSegmentId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0cc00",
  "opticalLinkId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9a21",
  "interactionObjectId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9a41",
  "interactionKind": "mirror",
  "branch": "reflected",
  "beamIndex": 0,
  "stateAtStart": {
    "powerMw": 19.4,
    "spectrum": {
      "centerWavelengthNm": 780.241,
      "wavelengthReference": "vacuum",
      "linewidth": { "kind": "lorentzian", "fwhmHz": 100000 }
    },
    "spatialX": { "qReal": 300, "qImag": 1006.2, "wAtZUm": 510 },
    "spatialY": { "qReal": 300, "qImag": 1006.2, "wAtZUm": 510 },
    "polarizationJones": {
      "normalization": "unit_jones",
      "exRe": 1,
      "exIm": 0,
      "eyRe": 0,
      "eyIm": 0
    }
  },
  "stateAtEnd": {
    "powerMw": 19.4,
    "spatialX": { "qReal": 450, "qImag": 1006.2, "wAtZUm": 525 },
    "spatialY": { "qReal": 450, "qImag": 1006.2, "wAtZUm": 525 }
  }
}
```

Example laser-to-mirror chain:

```text
objects.properties.opticalSources[id = "018f2c8e-8d4b-7c20-a5d3-1e4b7b0cb01"].beam
  -> initialize BeamState_0
  -> use anchorBindings[source.bindingId] for object-local start geometry
  -> resolve binding.anchorId to assets_3d.anchors[] for model position / direction
  -> use optical_link laser.port_out -> mirror.port_in
  -> resolve port bindingId -> anchorId -> endpoint pose
  -> segment_001.stateAtEnd
  -> apply mirror kindParams.reflectivity = 0.97
  -> segment_002.stateAtStart.powerMw = 20 * 0.97 = 19.4
```

---

---

## 2. Optical data planning v2 (historical)

> Superseded by §3. Kept for design history covering the v2 iteration.

This section is the current planning target before code changes. The most important rule:

```text
anchor / anchorBinding decides WHERE a physical feature is.
kind decides WHAT that feature means and WHAT parameters are required.
object / optical_element stores the actual instance parameters.
```

### Core responsibility split

| Layer | Responsibility | Stores | Must not store |
|------|----------------|--------|----------------|
| `assets_3d` | reusable CAD/model asset | model file path, unit, scale, reusable anchors | object-specific optical parameters |
| `assets_3d.anchors[]` | reusable model feature locations | `id`, `name`, `type`, `positionMmBodyLocal` | aperture, wavelength, power, reflectivity, RF power, gain |
| `components` | catalog/documentation only | `id`, `name`, `component_type`, brand/model, docs, `asset_3d_id` | `properties`, `capabilities`, propagation parameters |
| `objects` | one physical scene instance | pose, visibility/lock, `properties` | reusable CAD geometry |
| `objects.properties.anchorBindings[]` | bind object instance features to asset anchors | binding id, anchor id, geometry payload | beam propagation physics |
| `objects.properties.opticalSources[]` | editable emitted beams | wavelength, power, spectrum, polarization, spatial envelope | mirror/AOM/PBS transfer physics |
| `optical_elements.kind_params` | per-object transfer/interaction physics | reflectivity, focal length, AOM/EOM params, coupling, gain | CAD anchor position |
| inline `OpticalPort[]` | graph endpoints on one optical object | port id, role, side/face, binding id | beam state snapshots |
| `optical_links` | edges between ports | from/to object+port ids, status, medium/override | endpoint geometry duplicated from bindings |
| `beam_segments` | solver output | propagated beam states, branches, source trace | user-edited source beam definitions |

### ID rule

- All persistent ids should be opaque UUIDv7 strings.
- Do not derive ids from `name`, anchor name, component name, or binding role.
- Human-readable lookup belongs in `name`, `role`, `side`, `face`, `branchKind`, or tags.
- This avoids fragile ids like `binding_aom_001_optical_input_aperture`.

Example:

```json
{
  "id": "018f8b7a-9421-74a0-bc1e-62df2c2a9c11",
  "name": "AOM side A optical surface",
  "kind": "opticalPortSurface"
}
```

### `assets_3d.anchors[]`

Current target shape:

```json
{
  "id": "018f8b7a-9421-74a0-bc1e-62df2c2a9a01",
  "name": "Model output reference",
  "type": "optical",
  "positionMmBodyLocal": [12.5, 0, 0]
}
```

Rules:

- `type` is the physics domain/capability domain of the anchor, for example `optical`, `rf`, `mechanical`, `electrical`, or `thermal`.
- `type` is not `component_type` like `RF` or `Optical` as a component category.
- If a feature has no valid physics domain, it should not be used as an optical/RF anchor. In this planning model, strict definitions should prevent ambiguous "assembly-only but PhysicsCapability type" anchors.
- Direction, normal, aperture, polarization reference, and interaction parameters are not stored in `assets_3d.anchors[]`; they are defined by object bindings and kind contracts.

### `anchorBindings[]`

`anchorBindings[]` is object-instance geometry. It answers: "this physical feature is located at this asset anchor, and this is how the kind interprets the local geometry."

Recommended shape:

```json
{
  "id": "018f8b7a-9421-74a0-bc1e-62df2c2a9b01",
  "name": "Mirror reflective surface",
  "anchorId": "018f8b7a-9421-74a0-bc1e-62df2c2a9a01",
  "kind": "opticalSurface",
  "frame": "anchorLocalXY",
  "payload": {
    "normalBodyLocal": [1, 0, 0],
    "aperture": {
      "shape": "circle",
      "rMm": 12.7
    }
  }
}
```

Binding kinds currently planned:

| Binding kind | Meaning | Typical payload |
|--------------|---------|-----------------|
| `emissionReference` | laser/source emission start reference | `normalBodyLocal`; no aperture required |
| `opticalPortSurface` | input/output optical face | normal, aperture, optional polarization reference |
| `opticalSurface` | reflective/refractive/splitting surface | surface normal, aperture, surface role |
| `detectorArea` | terminal receiving area | normal toward incoming beam, aperture/sensor size |
| `interactionVolume` | finite interaction region | center reference, local axes, length/width/height |
| `modeField` | mode/coupling geometry reference | mode field radius/diameter reference, local axis |
| `polarizationReference` | local polarization axis reference | axis vector in body/local frame |
| `rfDirection` | RF/acoustic/electrical propagation direction | direction vector |
| `crystalAxis` | nonlinear/crystal reference axis | axis vector |
| `calibrationPoint` | measured/reference point | point-only or calibration metadata |

Important:

- `anchorBindings[]` only defines position, local axes, surfaces, apertures, mode-field geometry, and reference directions.
- It must not store wavelength, source power, linewidth, Jones vector, reflectivity, transmission, gain, RF drive power, diffraction efficiency, or solver result.
- Aperture is not an independent table or independent binding kind. When present, it is stored inside `opticalSurface`, `opticalPortSurface`, or `detectorArea`.

`emissionReference` rule:

- `emissionReference` means an object can actively create or switch on a beam from this geometry reference.
- It is not limited to `laser_source`.
- `laser_source` uses it for the initial laser beam.
- `aom` and `eom` may also use `emissionReference` if a future model needs explicit switchable/generated output references.
- Ordinary passive transformations such as mirror reflection still use solver branches, not static `emissionReference` bindings.

### Aperture convention

Allowed aperture shapes:

| Shape | Fields | Meaning |
|-------|--------|---------|
| `circle` | `rMm` | radius |
| `ellipse` | `xMm`, `yMm` | semi-axis lengths |
| `rectangle` | `xMm`, `yMm` | half-width and half-height |

All aperture dimensions use physical half-length definitions.

Clipping in `anchorLocalXY`:

```text
circle:    x^2 + y^2 <= rMm^2
ellipse:  (x / xMm)^2 + (y / yMm)^2 <= 1
rectangle: abs(x) <= xMm && abs(y) <= yMm
```

### Frame rule

`frame` says how `payload` numbers are interpreted.

| Frame | Use |
|-------|-----|
| `anchorLocalXY` | default for surfaces, apertures, detector areas, port faces |
| `bodyLocal` | object/body-axis geometry such as crystal axes or RF direction |
| `lab` | measured/snapshot/solver output only, not reusable setup definition |

`anchorLocalXY`:

- origin = resolved asset anchor position on this object.
- local +Z = binding normal/direction defined by the kind contract.
- local X/Y = tangent plane axes.
- anisotropic aperture or polarization-sensitive parts must define an explicit local axis if CAD roll is not enough.

### Object properties skeleton

```json
{
  "objects": {
    "id": "018f8b7a-9421-74a0-bc1e-62df2c2a9001",
    "componentId": "018f8b7a-9421-74a0-bc1e-62df2c2a9002",
    "xMm": 0,
    "yMm": 0,
    "zMm": 0,
    "rxDeg": 0,
    "ryDeg": 0,
    "rzDeg": 0,
    "properties": {
      "anchorBindings": [],
      "opticalSources": []
    }
  },
  "opticalElement": {
    "objectId": "018f8b7a-9421-74a0-bc1e-62df2c2a9001",
    "elementKind": "laser_source",
    "ports": [],
    "kindParams": {}
  }
}
```

### OpticalPort vs optical_links

They are not the same thing.

| Data | Meaning | Example |
|------|---------|---------|
| `OpticalPort` | endpoint on one optical object | mirror reflected output port |
| `optical_links` | graph edge connecting two ports | laser output port -> mirror incident port |

Ports are stored inline on `optical_elements` for now. Do not create an independent `optical_ports` table unless ports later need separate CRUD/lifecycle/permissions.

Example port:

```json
{
  "id": "018f8b7a-9421-74a0-bc1e-62df2c2a9c01",
  "name": "Reflected output",
  "role": "output",
  "side": null,
  "face": null,
  "branchKind": "reflected",
  "bindingId": "018f8b7a-9421-74a0-bc1e-62df2c2a9b01"
}
```

Current `OpticalPort` field values:

| Field | Current values | Meaning |
|-------|----------------|---------|
| `role` | `input`, `output`, `bidirectional` | Direction of graph connectivity, not necessarily one-way physics. |
| `branchKind` | `main`, `incident`, `reflected`, `transmitted`, `signal`, `seed`, `amplified`, `forward`, `generated`, `order`, `sideband` | Human/search label for what the port or solver branch represents. |
| `side` | `side_A`, `side_B`, `input_side`, `output_side`, `plane_side`, `convex_side`, `concave_surface` | Physical side/surface label for two-sided or curved-surface components. |
| `face` | `face_1`, `face_2`, `face_3`, `face_4`, `face_5`, `face_6` | Physical face label for cube/block/prism-like components. |

Notes:

- `side` and `face` are optional. Use them only when they clarify physical geometry.
- `face_1` to `face_6` covers cube/block components. PBS and beam splitter normally use a selected subset.
- `branchKind: "order"` and `"sideband"` are labels; exact order number or sideband index belongs in solver branch data, for example `order_+1` or `sideband_-1`.

Example link:

```json
{
  "id": "018f8b7a-9421-74a0-bc1e-62df2c2a9d01",
  "fromObjectId": "018f8b7a-9421-74a0-bc1e-62df2c2a9001",
  "fromPortId": "018f8b7a-9421-74a0-bc1e-62df2c2a9c01",
  "toObjectId": "018f8b7a-9421-74a0-bc1e-62df2c2a9003",
  "toPortId": "018f8b7a-9421-74a0-bc1e-62df2c2a9c02",
  "status": "valid",
  "properties": {
    "medium": "air",
    "manualDistanceOverrideMm": null
  }
}
```

### Current optical kind ports

This is the current target list before strict per-kind schema definition.

| Kind | Ports |
|------|-------|
| `laser_source` | `output(main)` |
| `mirror` | `input(incident)`, `output(reflected)` |
| `lens_biconvex` | `bidirectional(side_A)`, `bidirectional(side_B)` |
| `lens_plano_convex` | `bidirectional(side_A)`, `bidirectional(side_B)` |
| `waveplate` | `bidirectional(side_A)`, `bidirectional(side_B)` |
| `polarizer` | `bidirectional(side_A)`, `bidirectional(side_B)` |
| `beam_splitter` | face-selectable `input(incident)`, `output(reflected)`, `output(transmitted)` |
| `pbs` | face-selectable `input(incident)`, `output(reflected)`, `output(transmitted)` |
| `detector` | `input(signal)` |
| `camera` | `input(signal)` |
| `spectrometer` | `input(signal)` |
| `wavemeter` | `input(signal)` |
| `fiber` | `bidirectional(side_A)`, `bidirectional(side_B)` |
| `fiber_coupler` | `bidirectional(side_A)`, `bidirectional(side_B)` |
| `aom` | `bidirectional(side_A)`, `bidirectional(side_B)` |
| `eom` | `bidirectional(side_A)`, `bidirectional(side_B)` |
| `tapered_amplifier` | `input(seed)`, `output(amplified)`, optional monitor ports later |
| `nonlinear_crystal` | `bidirectional(side_A)`, `bidirectional(side_B)`, generated branches by solver |
| `isolator` | `input(forward)`, `output(forward)`, reverse behavior handled by kind params |

PBS / beam splitter face selection:

- A cube has four possible external faces that can be selected as incident input.
- Do not predefine four separate logical input ports as the physics contract.
- Store physical face bindings, then let the selected incident port determine which branch is `reflected` and which is `transmitted`.
- The solver resolves branch direction from selected incident face + internal surface normal + object pose.

Example:

```json
{
  "elementKind": "pbs",
  "ports": [
    { "id": "018f...", "role": "input", "face": "face_1", "branchKind": "incident", "bindingId": "018f..." },
    { "id": "018f...", "role": "output", "face": "face_2", "branchKind": "reflected", "bindingId": "018f..." },
    { "id": "018f...", "role": "output", "face": "face_3", "branchKind": "transmitted", "bindingId": "018f..." }
  ],
  "kindParams": {
    "selectedIncidentFace": "face_1",
    "polarizationSplitConvention": "H_transmit_V_reflect"
  }
}
```

### Solver branches

Solver branches are output labels from the interaction model. They are not pre-baked physical anchors for every possible outgoing ray.

| Kind | Branches |
|------|----------|
| `mirror` | `reflected`, optional `transmitted` |
| `beam_splitter` | `reflected`, `transmitted` |
| `pbs` | `reflected`, `transmitted`, polarization-dependent |
| `aom` | configurable diffraction orders, for example `order_-2`, `order_-1`, `order_0`, `order_+1`, `order_+2` |
| `eom` | `carrier`, `sideband_+1`, `sideband_-1`, higher sidebands if enabled |
| `nonlinear_crystal` | generated fields / converted branches, schema still to define |
| `tapered_amplifier` | amplified output, optional ASE/spontaneous/noise branches later |

AOM multi-order rule:

- One incoming beam can produce many outgoing beam states.
- The AOM does not need one static anchor per diffraction order.
- The solver creates one `beam_segment` per enabled order that has nonzero power and a valid outgoing direction.
- Those generated segments can hit downstream optics independently.
- `optical_links` may be explicit for intended branches or derived by ray/geometry intersection later.

Example AOM branch output:

```json
{
  "interactionKind": "aom",
  "branches": [
    { "branch": "order_-2", "enabled": true, "relativePower": 0.02 },
    { "branch": "order_-1", "enabled": true, "relativePower": 0.08 },
    { "branch": "order_0", "enabled": true, "relativePower": 0.70 },
    { "branch": "order_+1", "enabled": true, "relativePower": 0.18 },
    { "branch": "order_+2", "enabled": true, "relativePower": 0.02 }
  ]
}
```

### Per-kind anchorBinding requirements

| Kind | Required bindings | Object/kind params |
|------|-------------------|--------------------|
| `laser_source` | output position + output direction through `emissionReference`; no required aperture | `objects.properties.opticalSources[].enabled` and `.beam` |
| `mirror` | reflective surface center + surface normal | reflectivity, transmission; coating phase only if an advanced coating model is added |
| `lens_biconvex` | default: body center + optical axis; side-face bindings are optional for thick-lens/surface-aware models | focal length/local focus, transmission, aberration model later |
| `lens_plano_convex` | plane center, normal from plane center toward convex side | focal length/local focus, orientation-dependent focus |
| `waveplate` | body center + short-axis reference vector | HWP/QWP/custom retardance, wavelength behavior |
| `polarizer` | body center + transmission/polarization axis vector | extinction ratio, loss |
| `beam_splitter` | internal splitting surface + normal + selectable face bindings | split ratio, phase convention |
| `pbs` | internal splitting surface + normal + selectable face bindings | polarization split, extinction, phase |
| `detector` / `camera` | receiving area + normal facing incoming beam | responsivity, pixel/sensor/readout params |
| `spectrometer` / `wavemeter` | receiving area + normal facing incoming beam | measurement model, resolution |
| `fiber` / `fiber_coupler` | side A/B port surfaces, outward normals, polarization reference, mode-field/profile reference | accepted guided modes, coupling, loss, PM/SM/MM behavior |
| `aom` | side A/B optical surfaces, outward normals, RF direction; optional `emissionReference` for switchable/generated output models | Bragg/Raman-Nath model, RF frequency/power, enabled orders |
| `eom` | side A/B optical surfaces, outward normals, polarization reference, optional RF direction; optional `emissionReference` for switchable/generated sideband models | modulation index, sideband powers |
| `tapered_amplifier` | seed input surface, amplified output surface, `polarizationReference`, forward/backward mode references | gain, saturation, seed power limits, forward/backward modes, ASE/noise |
| `nonlinear_crystal` | side A/B optical surfaces, outward normals, polarization/crystal-axis reference | phase matching, nonlinear coefficients, generated fields |
| `isolator` | input/output surfaces, outward normals, polarization reference | forward transmission, reverse isolation |

Waveplate retardance note:

- `retardanceRad` means the phase delay between the waveplate fast/slow axes.
- HWP corresponds to `pi` radians; QWP corresponds to `pi/2` radians.
- For early planning, prefer `retardanceKind: "HWP"` or `"QWP"` plus `designWavelengthNm`.
- Only use `retardanceRad` when the kind is `custom` or when a detailed wavelength-dependent model is needed.

### Lens model templates

Current implementation target can start with `thin_lens`.

Thin lens template:

```json
{
  "elementKind": "lens_biconvex",
  "anchorBindings": [
    {
      "id": "018f8b7a-9421-74a0-bc1e-62df2c2ae101",
      "name": "Lens center",
      "anchorId": "018f8b7a-9421-74a0-bc1e-62df2c2ae102",
      "kind": "opticalSurface",
      "frame": "anchorLocalXY",
      "payload": {
        "normalBodyLocal": [1, 0, 0],
        "aperture": { "shape": "circle", "rMm": 12.7 }
      }
    }
  ],
  "ports": [
    {
      "id": "018f8b7a-9421-74a0-bc1e-62df2c2ae201",
      "role": "bidirectional",
      "side": "side_A",
      "bindingId": "018f8b7a-9421-74a0-bc1e-62df2c2ae101"
    },
    {
      "id": "018f8b7a-9421-74a0-bc1e-62df2c2ae202",
      "role": "bidirectional",
      "side": "side_B",
      "bindingId": "018f8b7a-9421-74a0-bc1e-62df2c2ae101"
    }
  ],
  "kindParams": {
    "model": "thin_lens",
    "focalLengthMm": 50,
    "transmission": 0.99
  }
}
```

Future thick lens template:

```json
{
  "elementKind": "lens_biconvex",
  "anchorBindings": [
    {
      "id": "018f8b7a-9421-74a0-bc1e-62df2c2af101",
      "name": "Side A surface",
      "anchorId": "018f8b7a-9421-74a0-bc1e-62df2c2af102",
      "kind": "opticalSurface",
      "frame": "anchorLocalXY",
      "payload": {
        "normalBodyLocal": [-1, 0, 0],
        "aperture": { "shape": "circle", "rMm": 12.7 }
      }
    },
    {
      "id": "018f8b7a-9421-74a0-bc1e-62df2c2af103",
      "name": "Side B surface",
      "anchorId": "018f8b7a-9421-74a0-bc1e-62df2c2af104",
      "kind": "opticalSurface",
      "frame": "anchorLocalXY",
      "payload": {
        "normalBodyLocal": [1, 0, 0],
        "aperture": { "shape": "circle", "rMm": 12.7 }
      }
    }
  ],
  "ports": [
    {
      "id": "018f8b7a-9421-74a0-bc1e-62df2c2af201",
      "role": "bidirectional",
      "side": "side_A",
      "bindingId": "018f8b7a-9421-74a0-bc1e-62df2c2af101"
    },
    {
      "id": "018f8b7a-9421-74a0-bc1e-62df2c2af202",
      "role": "bidirectional",
      "side": "side_B",
      "bindingId": "018f8b7a-9421-74a0-bc1e-62df2c2af103"
    }
  ],
  "kindParams": {
    "model": "thick_lens_template",
    "material": {
      "refractiveIndex": 1.5168,
      "referenceWavelengthNm": 587.6
    },
    "geometry": {
      "centerThicknessMm": 5,
      "surfaceA": {
        "radiusOfCurvatureMm": 51.5,
        "signConvention": "positive_center_after_surface"
      },
      "surfaceB": {
        "radiusOfCurvatureMm": -51.5,
        "signConvention": "positive_center_after_surface"
      }
    },
    "transmission": 0.99
  }
}
```

Use `thin_lens` first. Keep `thick_lens_template` as a planning template until surface sign convention and material dispersion are fully defined.

### AOM / EOM branch templates

AOM kind params template:

```json
{
  "elementKind": "aom",
  "kindParams": {
    "model": "bragg",
    "rf": {
      "frequencyMhz": 80,
      "powerW": 1.0,
      "phaseRad": 0
    },
    "medium": {
      "refractiveIndex": 2.26,
      "acousticVelocityMps": 4200
    },
    "orders": {
      "enabled": [-2, -1, 0, 1, 2],
      "frequencyShiftConvention": "output_frequency = input_frequency + order * rf_frequency",
      "angleConvention": "positive_order_rotates_toward_rf_direction"
    }
  }
}
```

AOM solver branch example:

```json
{
  "interactionKind": "aom",
  "branch": "order_+1",
  "order": 1,
  "frequencyShiftMhz": 80,
  "relativePower": 0.75,
  "phaseConvention": "inherits_input_phase_plus_rf_phase_if_model_enabled"
}
```

EOM kind params template:

```json
{
  "elementKind": "eom",
  "kindParams": {
    "model": "phase_modulator",
    "rf": {
      "frequencyMhz": 100,
      "phaseRad": 0
    },
    "modulation": {
      "modulationIndex": 0.5,
      "sidebandsEnabled": [-2, -1, 0, 1, 2],
      "frequencyShiftConvention": "sideband_frequency = carrier_frequency + n * rf_frequency",
      "phaseConvention": "sideband_phase = carrier_phase + n * rf_phase"
    }
  }
}
```

EOM solver branch example:

```json
{
  "interactionKind": "eom",
  "branch": "sideband_+1",
  "sidebandIndex": 1,
  "frequencyShiftMhz": 100,
  "relativePower": "computed_from_bessel_Jn",
  "phaseConvention": "sideband_phase = carrier_phase + n * rf_phase"
}
```

### Mode / profile matching

Mode/profile matching is object-specific, so it belongs in object-level data, not in `assets_3d.anchors[]`.

Recommended split:

| Data | Where |
|------|-------|
| physical coupling location and local mode/profile axis | `anchorBindings[]` with `kind: "modeField"` or a port payload reference |
| mode/profile geometry if it is a physical reference | `anchorBindings[].payload.profileReference` |
| accepted/input/output profile definitions | `optical_elements.kind_params.acceptedModes`, `.forwardMode`, `.backwardMode`, or kind-specific profile fields |
| solver choice for comparing incoming beam to the accepted profile | `optical_elements.kind_params.couplingModel` |
| measured/object-specific alignment/coupling values | `objects.properties.calibration` or `kind_params.measured` |
| propagated beam profile/q-parameters used for matching | `BeamState` during solver run |

Important:

- Do not hard-code mode matching as `gaussian_overlap` for every element.
- Fiber, fiber couplers, and tapered amplifiers define what profile/mode they accept or emit.
- The solver compares the incoming `BeamState.spatialEnvelope` with that accepted profile and then computes coupling/gain/loss using the selected model.

Example fiber accepted-mode params:

```json
{
  "elementKind": "fiber",
  "kindParams": {
    "fiberType": "PM",
    "acceptedModes": {
      "sideA": {
        "profileKind": "guided_mode",
        "modeFieldRadiusUm": 2.8,
        "na": 0.12,
        "targetPolarization": "slow_axis"
      },
      "sideB": {
        "profileKind": "guided_mode",
        "modeFieldRadiusUm": 2.8,
        "na": 0.12,
        "targetPolarization": "slow_axis"
      }
    },
    "couplingModel": {
      "model": "free",
      "params": {}
    },
    "lossDb": 0.3
  }
}
```

Example tapered amplifier profile/gain params:

```json
{
  "elementKind": "tapered_amplifier",
  "kindParams": {
    "enabled": true,
    "model": "measured_gain_with_ase",
    "designWavelengthNm": 852,
    "drive": {
      "currentMa": 2400,
      "currentMaxMa": 5000
    },
    "seedLimits": {
      "minPowerMw": 10,
      "maxPowerMw": 30,
      "acceptanceRadiusMm": 25
    },
    "gainModel": {
      "smallSignalGainDb": 25,
      "saturationPowerMw": 500,
      "samples": [
        {
          "inputPowerMw": 20,
          "driveCurrentMa": 2400,
          "forwardPowerMw": 2500,
          "backwardPowerMw": 50
        }
      ]
    },
    "aseModel": {
      "powerMw": 0.5,
      "bandwidthNm": 5,
      "centerOffsetNm": 0,
      "samples": [
        {
          "driveCurrentMa": 2400,
          "forwardPowerMw": 80,
          "backwardPowerMw": 200
        }
      ]
    },
    "forwardMode": {
      "spatialEnvelope": {
        "transverseProfile": {
          "kind": "elliptical_gaussian",
          "x": { "waistRadiusUm": 600 },
          "y": { "waistRadiusUm": 600 }
        },
        "propagation": {
          "model": "m2_gaussian",
          "x": { "waistZOffsetMm": 0, "mSquared": 1.5 },
          "y": { "waistZOffsetMm": 0, "mSquared": 1.5 }
        }
      },
      "polarization": {
        "basis": "beamLocalXY",
        "normalization": "unit_jones",
        "jones": { "exRe": 0, "exIm": 0, "eyRe": 1, "eyIm": 0 }
      },
      "transverseMode": {
        "family": "HG",
        "m": 0,
        "n": 0,
        "label": "TEM00"
      }
    },
    "backwardMode": {
      "spatialEnvelope": {
        "transverseProfile": {
          "kind": "elliptical_gaussian",
          "x": { "waistRadiusUm": 600 },
          "y": { "waistRadiusUm": 600 }
        },
        "propagation": {
          "model": "m2_gaussian",
          "x": { "waistZOffsetMm": 0, "mSquared": 1.5 },
          "y": { "waistZOffsetMm": 0, "mSquared": 1.5 }
        }
      },
      "polarization": {
        "basis": "beamLocalXY",
        "normalization": "unit_jones",
        "jones": { "exRe": 1, "exIm": 0, "eyRe": 0, "eyIm": 0 }
      },
      "transverseMode": {
        "family": "HG",
        "m": 0,
        "n": 0,
        "label": "TEM00"
      }
    }
  }
}
```

TA mode rules:

- `forwardMode` is both the seed-matching mode and the amplified forward output mode.
- `backwardMode` describes backward emission / backward ASE mode.
- `forwardMode` and `backwardMode` may have different `spatialEnvelope`, `polarization`, and `transverseMode`.
- Both modes must obey the same `transverseMode` / `mSquared` consistency rule as laser sources.
- `designWavelengthNm` is a TA gain/design reference, not the amplified beam's source wavelength. The amplified beam primarily inherits wavelength/spectrum from the incoming seed.

### Beam source and beam state

Laser propagation parameters are stored on the object source, not on the CAD anchor.

```json
{
  "id": "018f8b7a-9421-74a0-bc1e-62df2c2a9e01",
  "bindingId": "018f8b7a-9421-74a0-bc1e-62df2c2a9b01",
  "enabled": true,
  "beam": {
    "powerMw": 20,
    "spectrum": {
      "centerWavelengthNm": 780.241,
      "wavelengthReference": "vacuum",
      "linewidth": {
        "kind": "lorentzian",
        "fwhmHz": 100000
      }
    },
    "polarization": {
      "basis": "beamLocalXY",
      "normalization": "unit_jones",
      "jones": { "exRe": 1, "exIm": 0, "eyRe": 0, "eyIm": 0 }
    },
    "spatialEnvelope": {
      "transverseProfile": {
        "kind": "elliptical_gaussian",
        "x": { "waistRadiusUm": 500 },
        "y": { "waistRadiusUm": 200 },
        "hardAperture": null
      },
      "propagation": {
        "model": "m2_gaussian",
        "x": { "waistZOffsetMm": 0, "mSquared": 1.2 },
        "y": { "waistZOffsetMm": 0, "mSquared": 1.5 },
        "derived": {
          "divergenceXMrad": "computed from centerWavelengthNm, waistRadiusUm, mSquared",
          "divergenceYMrad": "computed from centerWavelengthNm, waistRadiusUm, mSquared",
          "rayleighRangeXMm": "computed from centerWavelengthNm, waistRadiusUm, mSquared",
          "rayleighRangeYMm": "computed from centerWavelengthNm, waistRadiusUm, mSquared"
        }
      }
    },
    "transverseMode": {
      "family": "HG",
      "m": 0,
      "n": 0,
      "label": "TEM00"
    }
  }
}
```

Beam rules:

- `enabled` means whether this object source is on. If `enabled: false`, the solver skips this source.
- Use `spectrum.centerWavelengthNm` as the editable source of truth. Do not also store editable `centerThz`.
- `centerThz` is derived from wavelength when needed.
- `spectrum.linewidth.kind: "delta"` means ideal zero linewidth and has no width parameter.
- Real finite linewidths use `lorentzian`, `gaussian`, `voigt`, or `measured`.
- Do not use ambiguous `amplitude` for source power. Use `powerMw`.
- Jones vector must be normalized: `|Ex|^2 + |Ey|^2 = 1`. Total optical power stays in `powerMw`.
- `spatialEnvelope.transverseProfile` defines the source cross-section energy distribution, for example `elliptical_gaussian`, `top_hat`, `multimode`, or `measured`.
- `spatialEnvelope.propagation` defines how that envelope evolves with distance.
- For Gaussian-like sources, prefer editable `spectrum.centerWavelengthNm`, `waistRadiusUm`, `waistZOffsetMm`, and `mSquared`; derive `divergenceMrad` and `rayleighRangeMm` when possible instead of editing all of them independently.
- Non-Gaussian sources may use a `measured` or model-specific propagation schema.
- `transverseMode` defines modal family/order, for example `TEM00` or higher-order HG/LG. It does not replace `spatialEnvelope`.
- Laser source must obey the `transverseMode` / `mSquared` consistency rule: for `HG(m,n)`, require `mSquaredX >= 2m + 1` and `mSquaredY >= 2n + 1`. For `HG00` / `TEM00`, `mSquared > 1` means nonideal beam quality or wavefront distortion.

### Source truth vs solver output

`source truth` means editable input data. It is the canonical state users maintain:

```text
objects
optical_elements.kind_params
optical_links
objects.properties.anchorBindings
objects.properties.opticalSources[].beam
```

`solver output` means calculated result data from one `simulation_run`:

```text
simulation_runs
beam_segments.stateAtStart
beam_segments.stateAtEnd
beam_paths cache, if stored
```

Rules:

- Source truth is edited by the user/UI and used as solver input.
- Solver output is produced by running the solver and should not be manually edited as canonical source data.
- Derived values such as `centerThz`, `divergenceMrad`, and `rayleighRangeMm` can be recomputed from source truth.
- Snapshot values in `beam_segments` record what one specific run computed at that time.
- If source truth changes, new runs produce new snapshots. Old snapshots stay attached to their original `simulation_run`.

### Beam segments are solver output

`beam_segments` are not manually edited source definitions.

```json
{
  "id": "018f8b7a-9421-74a0-bc1e-62df2c2a9f01",
  "simulationRunId": "018f8b7a-9421-74a0-bc1e-62df2c2a9f02",
  "sourceId": "018f8b7a-9421-74a0-bc1e-62df2c2a9e01",
  "previousSegmentId": null,
  "opticalLinkId": "018f8b7a-9421-74a0-bc1e-62df2c2a9d01",
  "interactionObjectId": null,
  "interactionKind": null,
  "branch": "source",
  "beamIndex": 0,
  "stateAtStart": "<BeamState>",
  "stateAtEnd": "<BeamState>"
}
```

Propagation chain:

```text
objects.properties.opticalSources[].beam
  -> initialize BeamState
  -> resolve source.bindingId
  -> anchorBindings[] gives object-local start geometry
  -> assets_3d.anchors[] gives reusable model position
  -> object pose transforms geometry to lab
  -> optical_links connect source port to next object port
  -> solver propagates free space
  -> optical_elements.kind_params applies interaction
  -> solver emits new beam_segments per branch/order
```

### Simulation runs

`simulation_runs` is the record for one solver execution.

It is not an optical element and not an optical link. It answers:

```text
Which scene input did I run?
Which solver/settings did I use?
When did it start/finish?
Which beam_segments belong to this calculation?
```

Current fixed concept:

```text
input:
  objects
  optical_elements
  optical_links
  objects.properties.anchorBindings
  objects.properties.opticalSources

run:
  simulation_runs

output:
  beam_segments
```

Minimal `simulation_runs` shape:

```json
{
  "id": "018f8b7a-9421-74a0-bc1e-62df2c2aa101",
  "revisionId": "018f8b7a-9421-74a0-bc1e-62df2c2aa001",
  "solverVersion": "optical-solver-v1",
  "status": "completed",
  "startedAt": "2026-05-10T12:00:00Z",
  "finishedAt": "2026-05-10T12:00:01Z",
  "warnings": [],
  "settings": {
    "maxBranches": 100,
    "minPowerMw": 0.001
  }
}
```

`beam_segments` reference the run:

```json
{
  "id": "018f8b7a-9421-74a0-bc1e-62df2c2a9f01",
  "simulationRunId": "018f8b7a-9421-74a0-bc1e-62df2c2aa101",
  "sourceId": "018f8b7a-9421-74a0-bc1e-62df2c2a9e01",
  "branch": "reflected",
  "stateAtStart": { "powerMw": 20 },
  "stateAtEnd": { "powerMw": 19.4 }
}
```

Reason:

- The same scene can be solved many times with different settings or changed object parameters.
- Without `simulation_runs`, all `beam_segments` from different calculations would be mixed together.
- `simulation_runs` is the batch/version label for solver output.
- `beam_segments` are the physical beam states inside that run.

### Scene revision and rollback

This architecture is not only for optical solver convenience. It is also the version-control foundation for the full digital twin scene.

There are two separate histories:

```text
revision:
  saved source truth / scene input
  answers: what did the scene look like?

simulation_run:
  solver result for one revision or scene hash
  answers: what did the solver compute for that scene?
```

Recommended relationship:

```text
revision_001
  -> simulation_run_001
  -> beam_segments for revision_001

revision_002
  -> simulation_run_002
  -> beam_segments for revision_002
```

What a revision can restore:

- object placement: `xMm`, `yMm`, `zMm`, `rxDeg`, `ryDeg`, `rzDeg`.
- object existence / removal state, for example active vs archived.
- object instance geometry: `objects.properties.anchorBindings`.
- source definitions: `objects.properties.opticalSources`.
- optical physics input: `optical_elements.elementKind`, `ports`, `kindParams`.
- graph wiring: `optical_links`.
- optional mechanical constraints if used: `assembly_relations`.

Example object movement:

```text
mirror.xMm = 100
  -> save revision_001
  -> run solver: simulation_run_001

mirror.xMm = 120
  -> current scene hash changes
  -> simulation_run_001 becomes stale for the current scene
  -> save revision_002
  -> run solver: simulation_run_002
```

Example object removal:

```text
AOM is removed or archived
  -> source truth changes
  -> related optical_links become invalid or removed
  -> latest solver output becomes stale
  -> old revision and old simulation_run still preserve the previous AOM scene
```

Rollback rule:

```text
restore revision_001
  -> source truth returns to revision_001 scene input
  -> current scene hash becomes the hash of revision_001
  -> any simulation_run with that same scene hash can be reused as valid output
  -> otherwise solver state is stale until a new run is created
```

Recommended scene solver state:

```json
{
  "sceneSolverState": {
    "status": "stale",
    "currentSceneHash": "hash_current_scene_input",
    "lastRunId": "018f8b7a-9421-74a0-bc1e-62df2c2aa101",
    "lastRunSceneHash": "hash_scene_when_run_was_created",
    "staleReasons": [
      "objects.pose_changed",
      "optical_links_changed"
    ],
    "dirtySince": "2026-05-10T12:10:00Z"
  }
}
```

`sceneSolverState.status` values:

| Status | Meaning |
|--------|---------|
| `no_run` | Scene has never produced solver output. |
| `clean` | Current source truth matches the latest valid run's scene hash. |
| `stale` | Current source truth changed after the latest run. |
| `running` | Solver is currently computing a new run. |
| `failed` | Latest solver attempt failed. |

Changes that should invalidate solver output:

| Source truth change | Invalidate solver output? | Reason |
|---------------------|---------------------------|--------|
| object pose changed | yes | Beam geometry changes. |
| object added / removed / archived | yes | Optical graph and intersections can change. |
| `anchorBindings` changed | yes | Interaction/reference geometry changes. |
| `opticalSources` changed | yes | Initial beams change. |
| `optical_elements.elementKind` changed | yes | Physics model changes. |
| `optical_elements.kindParams` changed | yes | Interaction physics changes. |
| `optical_elements.ports` changed | yes | Graph endpoints change. |
| `optical_links` changed | yes | Beam graph changes. |
| optics-affecting `device_states` changed | yes | Runtime optical behavior changes. |
| object name changed | no | Human label only. |
| display color changed | no | Renderer style only. |
| UI visibility / panel state changed | no | UI state only. |
| notes / documentation changed | no | Human documentation only. |

Final rule:

```text
source truth stores: what the scene is now.
revision stores: what the scene was at a saved point.
derived stores nothing canonical; it is recomputed from current source truth.
simulation_run stores: a solver execution against one revision/scene hash.
beam_segments store: the physical beam snapshots produced by that run.
rollback restores source truth; solver output is reused only when scene hash matches.
```

### Revisions and simulation snapshots

Keep input scene state separate from solver output.

| Data | Meaning |
|------|---------|
| `revision` | saved input scene: objects, optical elements, links, assembly relations |
| `simulation_run` | one solver execution against one revision; a run/batch record, not optical physics itself |
| `beam_segments` | output artifacts belonging to one simulation run |
| `beam_paths` | optional render cache derived from `beam_segments` |
| `assembly_relations` | optional mechanical/geometric constraints, not part of optical propagation |

Recommended current simplification:

```text
canonical input:
  objects
  assets_3d
  components
  optical_elements
  optical_links
  objects.properties.anchorBindings
  objects.properties.opticalSources

canonical output:
  simulation_runs
  beam_segments

optional/cache:
  assembly_relations
  beam_paths
```

Recommended `revision` shape:

```json
{
  "id": "018f8b7a-9421-74a0-bc1e-62df2c2aa001",
  "name": "Before AOM alignment",
  "createdAt": "2026-05-10T12:00:00Z",
  "sceneInput": {
    "objects": [],
    "opticalElements": [],
    "opticalLinks": [],
    "assemblyRelations": []
  },
  "assetRefs": [],
  "componentRefs": []
}
```

Recommended `simulation_run` shape:

```json
{
  "id": "018f8b7a-9421-74a0-bc1e-62df2c2aa101",
  "revisionId": "018f8b7a-9421-74a0-bc1e-62df2c2aa001",
  "solverVersion": "optical-solver-v1",
  "status": "completed",
  "warnings": [],
  "outputs": {
    "beamSegments": [],
    "beamPathCache": []
  }
}
```

### Laser source + mirror example

Laser object:

```json
{
  "objectId": "018f8b7a-9421-74a0-bc1e-62df2c2ab001",
  "properties": {
    "anchorBindings": [
      {
        "id": "018f8b7a-9421-74a0-bc1e-62df2c2ab101",
        "name": "Laser output",
        "anchorId": "018f8b7a-9421-74a0-bc1e-62df2c2ab102",
        "kind": "emissionReference",
        "frame": "anchorLocalXY",
        "payload": {
          "normalBodyLocal": [1, 0, 0]
        }
      }
    ],
    "opticalSources": [
      {
        "id": "018f8b7a-9421-74a0-bc1e-62df2c2ab201",
        "bindingId": "018f8b7a-9421-74a0-bc1e-62df2c2ab101",
        "enabled": true,
        "beam": "<BeamSource>"
      }
    ]
  },
  "opticalElement": {
    "elementKind": "laser_source",
    "ports": [
      {
        "id": "018f8b7a-9421-74a0-bc1e-62df2c2ab301",
        "name": "Main output",
        "role": "output",
        "branchKind": "main",
        "bindingId": "018f8b7a-9421-74a0-bc1e-62df2c2ab101"
      }
    ],
    "kindParams": {}
  }
}
```

Mirror object:

```json
{
  "objectId": "018f8b7a-9421-74a0-bc1e-62df2c2ac001",
  "properties": {
    "anchorBindings": [
      {
        "id": "018f8b7a-9421-74a0-bc1e-62df2c2ac101",
        "name": "Reflective surface",
        "anchorId": "018f8b7a-9421-74a0-bc1e-62df2c2ac102",
        "kind": "opticalSurface",
        "frame": "anchorLocalXY",
        "payload": {
          "normalBodyLocal": [-1, 0, 0],
          "aperture": { "shape": "circle", "rMm": 12.7 }
        }
      }
    ]
  },
  "opticalElement": {
    "elementKind": "mirror",
    "ports": [
      {
        "id": "018f8b7a-9421-74a0-bc1e-62df2c2ac201",
        "name": "Incident input",
        "role": "input",
        "branchKind": "incident",
        "bindingId": "018f8b7a-9421-74a0-bc1e-62df2c2ac101"
      },
      {
        "id": "018f8b7a-9421-74a0-bc1e-62df2c2ac202",
        "name": "Reflected output",
        "role": "output",
        "branchKind": "reflected",
        "bindingId": "018f8b7a-9421-74a0-bc1e-62df2c2ac101"
      }
    ],
    "kindParams": {
      "reflectivity": 0.97,
      "transmission": 0.03
    }
  }
}
```

Link:

```json
{
  "id": "018f8b7a-9421-74a0-bc1e-62df2c2ad001",
  "fromObjectId": "018f8b7a-9421-74a0-bc1e-62df2c2ab001",
  "fromPortId": "018f8b7a-9421-74a0-bc1e-62df2c2ab301",
  "toObjectId": "018f8b7a-9421-74a0-bc1e-62df2c2ac001",
  "toPortId": "018f8b7a-9421-74a0-bc1e-62df2c2ac201",
  "status": "valid",
  "properties": {
    "medium": "air"
  }
}
```

Solver result:

```text
Laser BeamSource power = 20 mW
segment_001 propagates laser -> mirror
mirror kindParams.reflectivity = 0.97
segment_002 branch = reflected
segment_002 power = 20 * 0.97 = 19.4 mW
```

---

## 3. V2 finalized optical schema draft (authoritative)

This section is the current recommended target schema. Numeric models may be refined later, but data ownership and field placement are considered decided.

This section is the current recommended target schema. It is still allowed to refine numeric models later, but data ownership and field placement are considered decided.

### Common conventions
Ids:

- All persisted ids are UUIDv7-like opaque strings.
- Do not derive ids from object names, component names, anchor names, port names, or branch names.
- Human search labels belong in `name`, `role`, `side`, `face`, `branchKind`, and tags.

Units:

| Quantity | Unit |
|----------|------|
| length / position | mm |
| wavelength | nm |
| beam waist radius | um |
| power | mW |
| RF frequency | MHz |
| optical frequency offset | MHz |
| angle | rad inside physics formulas; UI may display deg |
| polarization | normalized Jones vector |

Vector convention:

- `normalBodyLocal` always lives in `anchorBindings[].payload`.
- `normalBodyLocal` must be a unit vector.
- `axisBodyLocal`, `xAxisBodyLocal`, `rfDirectionBodyLocal`, and similar direction vectors must be unit vectors.
- `assets_3d.anchors[]` stores reusable model position only: `id`, `name`, `type`, `positionMmBodyLocal`.

### OpticalPort schema
```json
{
  "id": "uuid",
  "name": "Reflected output",
  "role": "output",
  "branchKind": "reflected",
  "side": null,
  "face": null,
  "bindingId": "uuid_binding"
}
```

Allowed values:

| Field | Values |
|-------|--------|
| `role` | `input`, `output`, `bidirectional` |
| `branchKind` | `main`, `incident`, `reflected`, `transmitted`, `signal`, `seed`, `amplified`, `forward`, `generated`, `order`, `sideband` |
| `side` | `side_A`, `side_B`, `input_side`, `output_side`, `plane_side`, `convex_side`, `concave_surface` |
| `face` | `face_1`, `face_2`, `face_3`, `face_4`, `face_5`, `face_6` |

Rules:

- Port is a graph endpoint.
- Port does not store beam physics.
- Port geometry resolves through `bindingId -> anchorBindings[] -> assets_3d.anchors[] -> object pose`.
- `side` is for two-sided or curved components.
- `face` is for cube/block/prism-like components.

### BeamState snapshot schema
`BeamState` is solver output. It is stored in `beam_segments.stateAtStart` and `beam_segments.stateAtEnd`.

```json
{
  "powerMw": 19.4,
  "spectrum": {
    "centerWavelengthNm": 780.241,
    "wavelengthReference": "vacuum",
    "frequencyOffsetMhz": 0,
    "linewidth": {
      "kind": "lorentzian",
      "fwhmHz": 100000
    }
  },
  "polarization": {
    "basis": "beamLocalXY",
    "normalization": "unit_jones",
    "jones": { "exRe": 1, "exIm": 0, "eyRe": 0, "eyIm": 0 }
  },
  "spatialEnvelope": {
    "transverseProfile": {
      "kind": "elliptical_gaussian",
      "x": { "waistRadiusUm": 500 },
      "y": { "waistRadiusUm": 200 },
      "hardAperture": null
    },
    "propagation": {
      "model": "m2_gaussian",
      "x": {
        "waistZOffsetMm": 0,
        "mSquared": 1.2,
        "rayleighRangeMm": 838,
        "divergenceMrad": 0.596,
        "wAtZUm": 525
      },
      "y": {
        "waistZOffsetMm": 0,
        "mSquared": 1.5,
        "rayleighRangeMm": 107,
        "divergenceMrad": 1.86,
        "wAtZUm": 260
      }
    }
  },
  "transverseMode": {
    "family": "HG",
    "m": 0,
    "n": 0,
    "label": "TEM00"
  },
  "phase": {
    "globalPhaseRad": 0,
    "gouyPhaseXRad": 0,
    "gouyPhaseYRad": 0
  },
  "geometry": {
    "originLabMm": [0, 0, 0],
    "directionLabUnit": [1, 0, 0],
    "pathLengthMm": 300
  }
}
```

Rules:

- `BeamSource` stores source truth.
- `BeamState` stores one solver snapshot.
- `frequencyOffsetMhz` is allowed in `BeamState`, because AOM/EOM branches can shift optical frequency.
- `wAtZUm`, `rayleighRangeMm`, `divergenceMrad`, and phase fields in `BeamState` are snapshots for one run.
- In source truth, derived values should not be canonical.

### BeamSegment schema
```json
{
  "id": "uuid_segment",
  "simulationRunId": "uuid_run",
  "sourceId": "uuid_source",
  "previousSegmentId": "uuid_previous_or_null",
  "opticalLinkId": "uuid_link_or_null",
  "interactionObjectId": "uuid_object_or_null",
  "interactionKind": "mirror",
  "branch": "reflected",
  "beamIndex": 0,
  "stateAtStart": "<BeamState>",
  "stateAtEnd": "<BeamState>",
  "metadata": {
    "warnings": []
  }
}
```

Rules:

- One generated branch/order/sideband gets one segment.
- `branch` examples: `source`, `reflected`, `transmitted`, `order_+1`, `sideband_-1`, `amplified`, `absorbed`.
- `previousSegmentId` makes the propagation chain auditable.

### Laser source schema
`laser_source` source truth lives in `objects.properties.opticalSources[]`.

```json
{
  "id": "uuid_source",
  "bindingId": "uuid_emission_reference",
  "enabled": true,
  "beam": {
    "powerMw": 20,
    "spectrum": {
      "centerWavelengthNm": 780.241,
      "wavelengthReference": "vacuum",
      "linewidth": {
        "kind": "lorentzian",
        "fwhmHz": 100000
      }
    },
    "polarization": {
      "basis": "beamLocalXY",
      "normalization": "unit_jones",
      "jones": { "exRe": 1, "exIm": 0, "eyRe": 0, "eyIm": 0 }
    },
    "spatialEnvelope": {
      "transverseProfile": {
        "kind": "elliptical_gaussian",
        "x": { "waistRadiusUm": 500 },
        "y": { "waistRadiusUm": 200 },
        "hardAperture": null
      },
      "propagation": {
        "model": "m2_gaussian",
        "x": { "waistZOffsetMm": 0, "mSquared": 1.2 },
        "y": { "waistZOffsetMm": 0, "mSquared": 1.5 }
      }
    },
    "transverseMode": {
      "family": "HG",
      "m": 0,
      "n": 0,
      "label": "TEM00"
    }
  }
}
```

Rules:

- Basic laser source does not use `carrier`, `components[]`, `offsetMhz`, or `powerFraction`.
- `spectrum.centerWavelengthNm` is source truth.
- `centerThz` is derived.
- `divergenceMrad` and `rayleighRangeMm` are derived from `centerWavelengthNm`, `waistRadiusUm`, and `mSquared`.
- `transverseMode` and `mSquared` must be consistent:
  - `HG(m,n)`: `mSquaredX >= 2m + 1`, `mSquaredY >= 2n + 1`.
  - `TEM00/HG00` with `mSquared > 1` means nonideal beam quality or wavefront distortion.

### Mirror schema
```json
{
  "elementKind": "mirror",
  "ports": [
    { "id": "uuid", "role": "input", "branchKind": "incident", "bindingId": "uuid_surface" },
    { "id": "uuid", "role": "output", "branchKind": "reflected", "bindingId": "uuid_surface" }
  ],
  "kindParams": {
    "surfaceModel": "flat",
    "reflectivity": 0.97,
    "transmission": 0.03,
    "coatingModel": {
      "kind": "scalar",
      "wavelengthReferenceNm": 780.241
    }
  }
}
```

Rules:

- Minimal mirror uses scalar `reflectivity` and `transmission`.
- `phaseShiftRad` is not a basic field.
- Advanced polarization/wavelength-dependent coating can be added under `coatingModel`.
- Aperture belongs in `anchorBindings[].payload.aperture` if needed.

### Lens schema
Current target: `thin_lens`.

```json
{
  "elementKind": "lens_biconvex",
  "ports": [
    { "id": "uuid", "role": "bidirectional", "side": "side_A", "bindingId": "uuid_center" },
    { "id": "uuid", "role": "bidirectional", "side": "side_B", "bindingId": "uuid_center" }
  ],
  "kindParams": {
    "model": "thin_lens",
    "focalLengthMm": 50,
    "focalLengthSignConvention": "positive_converging",
    "transmission": 0.99
  }
}
```

Future template: `thick_lens_template`.

```json
{
  "model": "thick_lens_template",
  "material": {
    "model": "constant_index",
    "refractiveIndex": 1.5168,
    "referenceWavelengthNm": 587.6
  },
  "geometry": {
    "centerThicknessMm": 5,
    "surfaceA": {
      "side": "side_A",
      "radiusOfCurvatureMm": 51.5,
      "signConvention": "positive_center_after_surface"
    },
    "surfaceB": {
      "side": "side_B",
      "radiusOfCurvatureMm": -51.5,
      "signConvention": "positive_center_after_surface"
    }
  },
  "transmission": 0.99
}
```

Rules:

- Use `thin_lens` first.
- Thick lens requires side-face bindings, surface radius, thickness, material model, and sign convention.
- `lens_plano_convex` uses `plane_side`, `convex_side`, and optionally `concave_surface` if a later model needs it.

### Waveplate schema
```json
{
  "elementKind": "waveplate",
  "ports": [
    { "id": "uuid", "role": "bidirectional", "side": "side_A", "bindingId": "uuid_plate" },
    { "id": "uuid", "role": "bidirectional", "side": "side_B", "bindingId": "uuid_plate" }
  ],
  "kindParams": {
    "retardanceKind": "HWP",
    "designWavelengthNm": 780.241,
    "axisReference": "short_axis",
    "transmission": 0.99
  }
}
```

Rules:

- Axis geometry is defined by binding payload or `polarizationReference`.
- `retardanceKind`: `HWP`, `QWP`, `custom`.
- `retardanceRad` is only required for `custom`.
- HWP = `pi`, QWP = `pi/2`.

### Polarizer schema
```json
{
  "elementKind": "polarizer",
  "ports": [
    { "id": "uuid", "role": "bidirectional", "side": "side_A", "bindingId": "uuid_pol" },
    { "id": "uuid", "role": "bidirectional", "side": "side_B", "bindingId": "uuid_pol" }
  ],
  "kindParams": {
    "axisReference": "transmission_axis",
    "transmissionParallel": 0.98,
    "transmissionPerpendicular": 0.00001,
    "extinctionRatio": 100000
  }
}
```

Rules:

- Axis geometry is not stored in `kindParams`; it is referenced by binding/polarization reference.
- `extinctionRatio = transmissionParallel / transmissionPerpendicular`.

### Beam splitter / PBS face mapping
Face labels are local to the cube/block body:

| Face | Meaning |
|------|---------|
| `face_1` | local +X face |
| `face_2` | local -X face |
| `face_3` | local +Y face |
| `face_4` | local -Y face |
| `face_5` | local +Z face |
| `face_6` | local -Z face |

Beam splitter:

```json
{
  "elementKind": "beam_splitter",
  "ports": [
    { "id": "uuid", "role": "input", "face": "face_1", "branchKind": "incident", "bindingId": "uuid_face_1" },
    { "id": "uuid", "role": "output", "face": "face_2", "branchKind": "transmitted", "bindingId": "uuid_face_2" },
    { "id": "uuid", "role": "output", "face": "face_3", "branchKind": "reflected", "bindingId": "uuid_face_3" }
  ],
  "kindParams": {
    "selectedIncidentFace": "face_1",
    "splitRatioReflected": 0.5,
    "splitRatioTransmitted": 0.5,
    "phaseConvention": "scalar_no_phase"
  }
}
```

PBS:

```json
{
  "elementKind": "pbs",
  "ports": [
    { "id": "uuid", "role": "input", "face": "face_1", "branchKind": "incident", "bindingId": "uuid_face_1" },
    { "id": "uuid", "role": "output", "face": "face_2", "branchKind": "transmitted", "bindingId": "uuid_face_2" },
    { "id": "uuid", "role": "output", "face": "face_3", "branchKind": "reflected", "bindingId": "uuid_face_3" }
  ],
  "kindParams": {
    "selectedIncidentFace": "face_1",
    "polarizationSplitConvention": "H_transmit_V_reflect",
    "extinctionRatio": 1000,
    "axisReference": "pbs_H_axis"
  }
}
```

Rules:

- `face_1..face_6` are physical labels.
- `selectedIncidentFace` decides which face is currently used as input.
- Solver derives reflected/transmitted directions from selected face, internal splitting surface normal, and object pose.
- PBS axis geometry comes from binding/polarization reference, not from `kindParams` vector fields.

### AOM schema
```json
{
  "elementKind": "aom",
  "ports": [
    { "id": "uuid", "role": "bidirectional", "side": "side_A", "bindingId": "uuid_side_A" },
    { "id": "uuid", "role": "bidirectional", "side": "side_B", "bindingId": "uuid_side_B" }
  ],
  "kindParams": {
    "model": "bragg",
    "rf": {
      "frequencyMhz": 80,
      "powerW": 1.0,
      "phaseRad": 0
    },
    "medium": {
      "refractiveIndex": 2.26,
      "acousticVelocityMps": 4200
    },
    "orders": {
      "enabled": [-2, -1, 0, 1, 2],
      "efficiencyModel": "measured_or_bessel",
      "frequencyShiftConvention": "output_frequency = input_frequency + order * rf_frequency",
      "angleConvention": "positive_order_rotates_toward_rf_direction"
    }
  }
}
```

Branch output:

```json
{
  "interactionKind": "aom",
  "branch": "order_+1",
  "order": 1,
  "frequencyShiftMhz": 80,
  "relativePower": 0.75,
  "phaseConvention": "inherits_input_phase_plus_rf_phase_if_enabled"
}
```

Rules:

- AOM orders are solver branches, not static ports.
- If a future switchable/generated output needs geometry, AOM may use `emissionReference`.
- RF direction is an anchor binding, not a raw asset anchor field.

### EOM schema
```json
{
  "elementKind": "eom",
  "ports": [
    { "id": "uuid", "role": "bidirectional", "side": "side_A", "bindingId": "uuid_side_A" },
    { "id": "uuid", "role": "bidirectional", "side": "side_B", "bindingId": "uuid_side_B" }
  ],
  "kindParams": {
    "model": "phase_modulator",
    "rf": {
      "frequencyMhz": 100,
      "phaseRad": 0
    },
    "modulation": {
      "modulationIndex": 0.5,
      "sidebandsEnabled": [-2, -1, 0, 1, 2],
      "powerModel": "bessel_Jn_squared",
      "frequencyShiftConvention": "sideband_frequency = carrier_frequency + n * rf_frequency",
      "phaseConvention": "sideband_phase = carrier_phase + n * rf_phase"
    }
  }
}
```

Branch output:

```json
{
  "interactionKind": "eom",
  "branch": "sideband_+1",
  "sidebandIndex": 1,
  "frequencyShiftMhz": 100,
  "relativePower": "computed_from_bessel_Jn",
  "phaseConvention": "sideband_phase = carrier_phase + n * rf_phase"
}
```

Rules:

- EOM sidebands are solver branches.
- EOM may use `emissionReference` for future switchable/generated sideband output geometry.
- Polarization dependence can be added under `kindParams.polarizationModel`.

### Tapered amplifier schema
```json
{
  "elementKind": "tapered_amplifier",
  "ports": [
    { "id": "uuid", "role": "input", "branchKind": "seed", "bindingId": "uuid_seed" },
    { "id": "uuid", "role": "output", "branchKind": "amplified", "bindingId": "uuid_output" }
  ],
  "kindParams": {
    "enabled": true,
    "model": "measured_gain_with_ase",
    "designWavelengthNm": 852,
    "drive": {
      "currentMa": 2400,
      "currentMaxMa": 5000
    },
    "seedLimits": {
      "minPowerMw": 10,
      "maxPowerMw": 30,
      "acceptanceRadiusMm": 25
    },
    "gainModel": {
      "smallSignalGainDb": 25,
      "saturationPowerMw": 500,
      "samples": []
    },
    "aseModel": {
      "powerMw": 0.5,
      "bandwidthNm": 5,
      "centerOffsetNm": 0,
      "samples": []
    },
    "forwardMode": "<ModeDefinition>",
    "backwardMode": "<ModeDefinition>"
  }
}
```

`ModeDefinition`:

```json
{
  "spatialEnvelope": "<SpatialEnvelope>",
  "polarization": "<Polarization>",
  "transverseMode": "<TransverseMode>"
}
```

Rules:

- `forwardMode` is both seed matching mode and amplified forward output mode.
- `backwardMode` is backward emission / backward ASE mode.
- Forward and backward modes may have different spatial envelope, polarization, and transverse mode.
- TA output wavelength/spectrum inherits primarily from incoming seed.
- `designWavelengthNm` is gain/design reference, not a new laser source wavelength.
- Seed power outside `seedLimits` should produce solver warning; hard error is reserved for impossible schema or missing required data.

### Fiber / fiber coupler schema
```json
{
  "elementKind": "fiber",
  "ports": [
    { "id": "uuid", "role": "bidirectional", "side": "side_A", "bindingId": "uuid_side_A" },
    { "id": "uuid", "role": "bidirectional", "side": "side_B", "bindingId": "uuid_side_B" }
  ],
  "kindParams": {
    "fiberType": "PM",
    "modeField": {
      "radiusConvention": "radius",
      "modeFieldRadiusUm": 2.8,
      "na": 0.12
    },
    "polarizationAxes": {
      "axisReference": "slow_axis"
    },
    "loss": {
      "insertionLossDb": 0.3,
      "returnLossDb": 40
    },
    "connector": {
      "polish": "APC",
      "reflectionModel": "none"
    },
    "couplingModel": {
      "model": "free",
      "params": {}
    }
  }
}
```

Rules:

- `fiberType`: `SM`, `PM`, `MM`.
- Store radius or diameter explicitly with convention. Default target is radius.
- PM fiber must have polarization reference binding.
- Fiber is bidirectional unless a device-specific model says otherwise.

### Detector / camera / spectrometer / wavemeter schema
Detector:

```json
{
  "elementKind": "detector",
  "ports": [
    { "id": "uuid", "role": "input", "branchKind": "signal", "bindingId": "uuid_detector_area" }
  ],
  "kindParams": {
    "responsivityAperW": 0.5,
    "saturationPowerMw": 10,
    "noiseModel": "none",
    "measurement": {
      "outputs": ["powerMw"]
    }
  }
}
```

Camera:

```json
{
  "elementKind": "camera",
  "kindParams": {
    "sensor": {
      "pixelSizeUm": 5.3,
      "resolutionX": 1920,
      "resolutionY": 1080
    },
    "saturation": {
      "wellDepthElectrons": 30000
    },
    "measurement": {
      "outputs": ["image", "centroid", "beam_radius"]
    }
  }
}
```

Spectrometer:

```json
{
  "elementKind": "spectrometer",
  "kindParams": {
    "wavelengthRangeNm": [700, 900],
    "resolutionNm": 0.05,
    "measurement": {
      "outputs": ["spectrum"]
    }
  }
}
```

Wavemeter:

```json
{
  "elementKind": "wavemeter",
  "kindParams": {
    "accuracyMhz": 10,
    "measurement": {
      "outputs": ["centerWavelengthNm", "centerFrequencyThz"]
    }
  }
}
```

Measurement result rule:

- Measurement schemas are source truth.
- Measurement outputs are solver/run results and belong in a future `measurement_results` table or in `simulation_runs.outputs.measurements`.
- They should not be stored back into detector/camera/spectrometer/wavemeter `kindParams`.

### Beam paths cache
```json
{
  "simulationRunId": "uuid_run",
  "beamSegmentId": "uuid_segment",
  "pointsLabMm": [
    [0, 0, 0],
    [300, 0, 0]
  ],
  "color": "#ff3b30",
  "visible": true
}
```

Rules:

- `beam_paths` is render cache, not canonical physics.
- It can be stored in DB or generated in frontend runtime.
- Source of truth is `beam_segments`.
- Cache invalidates when the owning `simulation_run` is not current for the scene hash.

### Revisions
Recommended revision strategy:

- Store full scene snapshots first.
- Diff-based revision can be added later for storage optimization.
- `sceneHash` is computed from canonical source truth only.
- Do not include UI state, display color, names, notes, documentation, or cached solver output in `sceneHash`.
- Restoring a revision replaces current source truth with the revision's scene input.
- A previous simulation run can be reused only when its `sceneHash` matches the restored revision.

### Assembly relations
```json
{
  "id": "uuid_relation",
  "objectAId": "uuid_a",
  "objectBId": "uuid_b",
  "relationType": "fixed_offset",
  "selectorA": {},
  "selectorB": {},
  "offsetMm": [0, 0, 30],
  "angleDeg": [0, 0, 0],
  "toleranceMm": 0.1,
  "solved": true
}
```

Rules:

- `assembly_relations` is mechanical/geometric, not optical propagation.
- It is optional for now.
- If enabled and it changes object pose, it affects `sceneHash` through the resulting object pose.
- Relation data itself may also be included in `sceneHash` if the solver can use constraints before pose solving.

---

## 4. Future refinements

These are future model refinements, not unresolved ownership questions:

1. Wavelength-dependent mirror / PBS / coating models.
2. Thick-lens material dispersion and exact curvature sign convention.
3. Detailed AOM efficiency model for Bragg vs Raman-Nath regimes.
4. Detailed EOM polarization-dependent modulation model.
5. TA gain / ASE interpolation and measurement fitting strategy.
6. Fiber coupling solver model and mode-overlap implementation.
7. Measurement result storage table if detectors become first-class simulated instruments.

### Open work tracked from current implementation

| Gap | Status | Planned phase |
|-----|--------|---------------|
| Time-domain RF solver | Not implemented (CW / slow modulation only) | Phase 1d+ |
| Onshape CAD sync | API client placeholder exists; no active route | Phase 2 |
| Multi-frequency mixing (SFG/DFG) | Kind defined; no solver | Phase 1 |
| Nonlinear crystal phase matching | Kind defined; no solver | Phase 1 |
| Spatial mode mismatch / Gaussian overlap integral | Parameters tracked; not used for coupling prediction | Phase 1 |
| Time-domain quantum evolution (Lindblad) | Not started | Phase 2 |
| Thermal ODE solver | Not started | Phase 2 |
| Timing timeline UI | Not started | Phase 3 |
| Legacy field name removal | Backwards-compatibility shims still present | After DB migration validation |
| ESLint / code linter | Not configured | Backlog |
