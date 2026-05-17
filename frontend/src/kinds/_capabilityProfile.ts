/**
 * Per-ElementKind capability profile.
 *
 * Centralises every "this kind doesn't behave like a normal object"
 * exception that used to live as hard-coded `elementKind === "rf_cable"`
 * / `=== "programmable_pulse_generator"` checks scattered across
 * OutlinerPanel, ComponentPanel, DigitalTwinViewer, and rigidGroup.
 *
 * The default profile (`DEFAULT`) describes the canonical Object
 * lifecycle: shows in Outliner, edits pose / rotation in Object panel,
 * lockable, participates in rigid-group cascade, takes the placement
 * gizmo in the 3D viewer, renders the AlignPanel, has a "Remove object"
 * button. Most ElementKinds (laser, mirror, AOM, lens, beam splitter,
 * polarizer, waveplate, EOM, isolator, saturable absorber, nonlinear
 * crystal, fiber coupler, detector, camera, spectrometer, wavemeter,
 * beam dump, rf_source, rf_amplifier, rf_switch, horn_antenna,
 * tapered_amplifier) inherit the default unchanged.
 *
 * Special profiles override per-field:
 *   - `rf_cable`: pose / rotation / lock / rigid-group / gizmo / align
 *     are meaningless because the body is derived from the two endpoint
 *     anchors; only middle spline nodes are editable. Remove button is
 *     replaced by per-end Unlink&delete in the panel.
 *   - `programmable_pulse_generator`: managed exclusively from the RF
 *     Link panel (right-click ttl_in / trigger_in to create) and Pulse &
 *     Timing panel; hidden from the Outliner so the user can't delete
 *     it out of band.
 *   - `fiber_end` (pending fiber split): default profile — each end of
 *     a fiber is a first-class lockable / rigid-group-able SceneObject.
 *   - `fiber` (pending split, body wrapper): everything off, hidden
 *     from Outliner. Mirrors rf_cable since the body pose is fully
 *     derived from the two fiber_end SceneObjects.
 */
export type ComponentCapabilityProfile = {
  /** Outliner lists this object in the tree. False for catalog-managed
   *  internal kinds (PPG, future hidden fiber body) so the user doesn't
   *  see — or get to delete — them out of band. */
  outlinerVisible: boolean;
  /** Object panel renders the "Object position mm" and "Object rotation
   *  deg" sections (xMm/yMm/zMm + rxDeg/ryDeg/rzDeg numeric inputs). */
  objectPanelShowPose: boolean;
  /** Object panel renders the Lock checkbox AND backend honours the
   *  `locked` flag's pose-mutation block. */
  lockable: boolean;
  /** `expandPoseToRigidGroup` includes this object in the rigid-group
   *  cascade when one of its collection siblings is moved. False for
   *  cable-like derived-pose kinds whose body re-resolves at draw time. */
  rigidGroupParticipant: boolean;
  /** 3D viewer attaches the placement gizmo (G / R translate / rotate)
   *  when this object is selected. False when pose is derived. */
  viewerGizmoAttachable: boolean;
  /** Object panel renders the AlignPanel section (per-component align
   *  controls for kinds with optical anchors / beam ports). */
  showAlignPanel: boolean;
  /** Object panel shows a generic "Remove object" button. False when the
   *  panel provides kind-specific deletion (cable: per-end Unlink&delete;
   *  PPG: deleted via RF Link panel right-click). */
  showRemoveObjectButton: boolean;
  /** Spline-shaped kinds (cable, fiber body): nodes 0 and N-1 are pinned
   *  to the two anchored endpoints. Interior nodes remain freely
   *  draggable in the 3D viewer node-edit mode. */
  endpointSplineNodesLocked: boolean;
};

const DEFAULT: ComponentCapabilityProfile = {
  outlinerVisible: true,
  objectPanelShowPose: true,
  lockable: true,
  rigidGroupParticipant: true,
  viewerGizmoAttachable: true,
  showAlignPanel: true,
  showRemoveObjectButton: true,
  endpointSplineNodesLocked: false,
};

/** Per-kind overrides. Spread on top of DEFAULT — only specify fields
 *  that differ. Add new entries here when a new kind needs special
 *  treatment instead of sprinkling hard-coded elementKind checks. */
const OVERRIDES: Record<string, Partial<ComponentCapabilityProfile>> = {
  rf_cable: {
    // Hidden from Outliner per spec 2026-05-16: cables are RF Link-
    // managed and Collection Templates skip them on save, so surfacing
    // them in the Outliner just lets the user inadvertently include
    // them in a template / delete them out of band. Right-click the
    // connected port in the RF Link panel to remove a cable.
    outlinerVisible: false,
    objectPanelShowPose: false,
    lockable: false,
    rigidGroupParticipant: false,
    viewerGizmoAttachable: false,
    showAlignPanel: false,
    showRemoveObjectButton: false,
    endpointSplineNodesLocked: true,
  },
  programmable_pulse_generator: {
    outlinerVisible: false,
    objectPanelShowPose: false,
    lockable: false,
    rigidGroupParticipant: false,
    viewerGizmoAttachable: false,
    showAlignPanel: false,
    showRemoveObjectButton: false,
  },
  // alembic 0056 (2026-05-17): collapsed the 3-SceneObject fiber split.
  // A fiber is back to a single SceneObject; End A / End B pose live
  // inline on fiber PE.kindParams.endA / endB. Default profile applies
  // (visible in Outliner, lockable, rigid-group participant, gizmo
  // attachable, etc.) — the only override is endpointSplineNodesLocked
  // so the spline endpoints (= where each ferrule sits) are only
  // adjusted via the per-end Align A / Align B buttons, not by free-
  // dragging the endpoint anchor sphere. Interior nodes stay draggable.
  fiber: {
    endpointSplineNodesLocked: true,
  },
  // fiber_end kind retained in the manifest (legacy plugin) but no
  // SceneObject of this kind can exist post-0056 (catalog Component
  // archived). The empty override keeps grep-results contiguous.
  fiber_end: {},
};

export function capabilityProfile(
  elementKind: string | null | undefined,
): ComponentCapabilityProfile {
  if (!elementKind) return DEFAULT;
  const override = OVERRIDES[elementKind];
  return override ? { ...DEFAULT, ...override } : DEFAULT;
}
