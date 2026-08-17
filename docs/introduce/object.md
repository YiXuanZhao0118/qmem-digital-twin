[← Doc index](README.md)

# SceneObject (Object) — the scene-instance layer

> Layer 4 of the [core data model](data-model.md). How it instantiates a [Component](component.md), and how parameters merge, is in [data-model.md](data-model.md).

**SceneObject (Object)** — an instance placed in the scene. It carries a Lab pose (x/y/z/rx/ry/rz), `visible`, `locked`, and `dynamic_sources` (per-instance runtime values). The name is generated as `KIND+index` (AOM0, MIRROR1; kind = none → NONE0).

- **dynamic_sources** = the runtime values of the whole instance. It stores values for the parameters the Asset marked tunable (`Asset3D.tunable_params`, migration 0113), which is how optics couples to electronics / RF / laser state (laser power and wavelength, rf_source channels, aom RF). The anchor loader folds this dict on top of the asset's default_params before handing it to the trace, but **only tunable keys take effect** — the loader drops leftovers that are a defaultParams key yet not tunable, so non-tunable parameters always track the Asset (see the tunable contract in [data-model.md](data-model.md)).
- The old per-binding `param_overrides` (which could override **any** intrinsic coefficient per instance) was removed in migration 0113 — intrinsic coefficients are now decided purely by the Asset.

> The coordinate conventions and transform chain of the Lab pose are in [anchors.md](anchors.md); the `effective` / `dynamic` parameter-merge formula is in [data-model.md](data-model.md).

The stored pose is **quantized** — 1 nm for `x/y/z mm`, 1e-9° for `rx/ry/rz deg` — so a quaternion round-trip can never persist float residue such as `ryDeg = -8.99e-15`. See "Pose quantization" in [anchors.md](anchors.md).
