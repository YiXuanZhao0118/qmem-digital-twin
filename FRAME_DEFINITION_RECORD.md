# Frame Definition Record

Date: 2026-06-01

Status: frame definition is considered complete for the current main branch.

## Current Rules

- Runtime frame math remains stored `SceneObject.rxDeg`, `SceneObject.ryDeg`, and `SceneObject.rzDeg`.
- Runtime consumers must continue to use `sceneObjectToQuaternion()` / `sceneObjectEulerFromQuaternion()` for pose conversion.
- Solver, renderer, anchor transforms, snap/align math, rigid-group persistence, and DB paths must not copy Object Panel display-axis mappings.
- The global axis gizmo is a user-facing display aid: X = `[1, 0, 0]`, Y = `[0, 1, 0]`, Z = `[0, 0, 1]`.
- Object Panel `Lab Sense rotation deg` is display-frame UI only:
  - displayed `RX` = stored `rxDeg`
  - displayed `RY` = `-stored ryDeg`
  - displayed `RZ` = `-stored rzDeg`
- Transform gizmo pivot uses the `SceneObject` pose origin / rotation axis, not rendered mesh bbox center.

## Freeze Recommendation

Do not edit frame definitions again unless a new task explicitly reopens frame architecture.

Future work should treat frame definitions as fixed and debug feature-specific issues against them. RF link problems should be handled later as separate RF link tasks, without changing these frame rules.
