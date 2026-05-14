/**
 * Instantaneous gate / RF readout pinned to the Object panel.
 *
 * Deferred after alembic 0045/0046: TimingPrograms are now top-level
 * (not per-object) and only carry gate intervals (no amplitude / freq /
 * phase). The per-object readout will reactivate once the binding
 * resolver (``objects.properties.gateBindings[].timingProgramId``) lands;
 * the new readout will be a simple HIGH/LOW gate indicator plus values
 * sourced from ``objects.properties.rfSources[].signal``.
 */
export function ScrubTimeRfReadout(_props: { sceneObjectId: string }) {
  return null;
}
