[← Doc index](README.md)

# Component / ComponentBinding — catalog template + binding tree

> Layers 2–3 of the [core data model](data-model.md). Instantiated as a [SceneObject](object.md); the binding tree's render path is in [rendering.md](rendering.md).

## Component

**Component** — the catalog "template". It has a `vendorPart`, a **ComponentBinding tree**, and outward-facing `exposedFaces`. It has **no physics kind and no physics parameters of its own** (migrations 0094/0095 cleared the physics keys off components; physics is decided by the kind of the bound asset). `Component.kind_id` still exists but is only a **catalog classification slug** (not physics): it drives the inner group label in the parts library (`typeKey = kindId || "uncategorized"`), and composites default to the sentinel `"none"`. It is editable directly in the free-text `kind_id` field on the **PHY Editor COMPONENT tab** (empty = null). The outer category in the parts library is instead decided directly by `properties.category` (unset = Uncategorized; it is no longer derived from the kind — see [kinds.md](kinds.md)).

## ComponentBinding

**ComponentBinding** — a node of the binding tree. It hangs an asset (or a sub-component) under a parent node with a local transform (`local_x_mm`/`local_y_mm`/`local_z_mm` + `local_rx_deg`/`local_ry_deg`/`local_rz_deg`, three-axis rotation), plus `tunable_axes`, `role` and `sort_order`. This is what makes composite components possible (e.g. an isolator = Faraday rod + front and back Glan prisms + housing). Table `component_bindings`: `parent_binding_id`, `target_kind` (asset/empty/subcomponent), `asset_3d_id`, …

## exposedFaces

Through `exposedFaces` a Component maps outward semantic ports (e.g. `optical_in`) onto `assetBindingId + anchorId`, so a composite exposes only semantic optical ports to the outside (faces are retired → anchors, see [anchors.md](anchors.md)).
