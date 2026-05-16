/**
 * Per-kind anchor inspector sections — split out of
 * `ComponentEditor.tsx` (god-file). Each section renders the
 * status / hint / number-input block for one kind's anchor in the
 * PHY Editor right pane.
 *
 * These are pure presentational components: they take `draft` /
 * `updateDraft` props from the parent editor and don't touch the
 * Zustand store themselves. The aperture editor has moved to the
 * Object panel (V2 schema, see ComponentEditor.tsx for the
 * full explanation).
 *
 * Sections covered here (the simple ones — no internal state):
 *   - EditableAnchorFields  (xyz position + optional direction)
 *   - MirrorFaceSection
 *   - LensFaceSection       (plano-convex / biconvex)
 *   - LaserSourceFaceSection
 *   - WaveplateFaceSection
 *   - BeamSplitterFaceSection (pbs / bs)
 *
 * Complex sections (TaperedAmplifier, FiberPatchCable, Aom) still
 * live in ComponentEditor.tsx — they pull in helpers from
 * elsewhere in that file (computeBraggTiltAxisFromRfDirectionBodyLocal,
 * useState hooks, etc.) and are a separate extraction pass.
 */
import type { Anchor } from "../../types/digitalTwin";

/** Simple anchor draft state: the editor mutates this in-memory; only
 *  the Save button promotes it to the store + backend.
 *
 *  Re-declared here (not imported) because the type is internal to
 *  the editor and the section components don't need the wider
 *  ComponentEditor surface to render. */
export type AnchorDraft = Anchor & { __key: string };

// =============================================================================
// ConnectorTypeField — physical coax connector picker (RF / TTL anchors only)
// =============================================================================

const CONNECTOR_OPTIONS: ReadonlyArray<{
  value: NonNullable<Anchor["connectorType"]>;
  label: string;
}> = [
  { value: "sma_male", label: "SMA Male" },
  { value: "sma_female", label: "SMA Female" },
  { value: "bnc_male", label: "BNC Male" },
  { value: "bnc_female", label: "BNC Female" },
];

export function ConnectorTypeField({
  draft,
  updateDraft,
}: {
  draft: AnchorDraft;
  updateDraft: (key: string, patch: Partial<AnchorDraft>) => void;
}) {
  return (
    <div className="component-editor-coord" style={{ marginTop: 8 }}>
      <span>Connector (RF / TTL)</span>
      <select
        value={draft.connectorType ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          updateDraft(draft.__key, {
            connectorType: v === ""
              ? undefined
              : (v as NonNullable<Anchor["connectorType"]>),
          });
        }}
      >
        <option value="">— unset —</option>
        {CONNECTOR_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}

// =============================================================================
// EditableAnchorFields — reused inside every section below
// =============================================================================

export function EditableAnchorFields({
  draft,
  updateDraft,
  showDirection,
  showConnectorType = false,
  apertureMode: _apertureMode = "scalar",
}: {
  draft: AnchorDraft;
  updateDraft: (key: string, patch: Partial<AnchorDraft>) => void;
  showDirection: boolean;
  /** When true, render a SMA/BNC × M/F picker below the direction grid.
   *  Used by the RF / Components face sections (AOM rf_in, fiber RF
   *  endpoint editor) so they line up with the generic anchor editor's
   *  inline picker. Optical sections leave this false. */
  showConnectorType?: boolean;
  apertureMode?: "scalar" | "rectangle";
}) {
  return (
    <>
      <div className="component-editor-coord-grid" style={{ marginTop: 8 }}>
        {(["x", "y", "z"] as const).map((axis) => (
          <label key={axis} className="component-editor-coord">
            <span>{axis.toUpperCase()} (mm)</span>
            <input
              type="number"
              step={0.5}
              value={draft.positionMmBodyLocal[axis].toFixed(3)}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v)) return;
                updateDraft(draft.__key, {
                  positionMmBodyLocal: {
                    ...draft.positionMmBodyLocal,
                    [axis]: v,
                  },
                });
              }}
            />
          </label>
        ))}
      </div>
      {showDirection && (
        <div className="component-editor-coord-grid" style={{ marginTop: 6 }}>
          {(["x", "y", "z"] as const).map((axis) => (
            <label key={axis} className="component-editor-coord">
              <span>n{axis.toUpperCase()}</span>
              <input
                type="number"
                step={0.1}
                value={(draft.directionBodyLocal?.[axis] ?? 0).toFixed(3)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isFinite(v)) return;
                  const cur =
                    draft.directionBodyLocal ?? { x: 0, y: 0, z: 0 };
                  updateDraft(draft.__key, {
                    directionBodyLocal: { ...cur, [axis]: v },
                  });
                }}
              />
            </label>
          ))}
        </div>
      )}
      {showConnectorType && <ConnectorTypeField draft={draft} updateDraft={updateDraft} />}
      {/* Aperture inputs intentionally removed (V2). Edit per-object on
          the Object panel — the value lives in
          objects.properties.anchorBindings[].payload.aperture. */}
    </>
  );
}

// =============================================================================
// MirrorFaceSection
// =============================================================================

export function MirrorFaceSection({
  draft,
  hasOutline,
  updateDraft,
}: {
  draft: AnchorDraft | null;
  hasOutline: boolean;
  updateDraft: (key: string, patch: Partial<AnchorDraft>) => void;
}) {
  if (!draft) {
    return (
      <div className="component-editor-section">
        <div className="component-editor-section-title">Reflective face</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          No anchor available - load a component with an Asset3D first.
        </div>
      </div>
    );
  }

  const hasFace =
    hasOutline ||
    (draft.directionBodyLocal !== undefined &&
      (draft.directionBodyLocal.x !== 0 ||
        draft.directionBodyLocal.y !== 0 ||
        draft.directionBodyLocal.z !== 0));

  return (
    <div className="component-editor-section">
      <div className="component-editor-section-title">Reflective face</div>
      <div className="mirror-face-status">
        {hasFace ? (
          <>
            <span style={{ color: "#facc15" }}>Face picked</span>
            <span style={{ opacity: 0.65, marginLeft: 6 }}>
              center ({draft.positionMmBodyLocal.x.toFixed(2)},{" "}
              {draft.positionMmBodyLocal.y.toFixed(2)},{" "}
              {draft.positionMmBodyLocal.z.toFixed(2)}) mm
            </span>
            {draft.directionBodyLocal && (
              <div style={{ opacity: 0.65, marginTop: 4, fontSize: 11 }}>
                normal = ({draft.directionBodyLocal.x.toFixed(2)},{" "}
                {draft.directionBodyLocal.y.toFixed(2)},{" "}
                {draft.directionBodyLocal.z.toFixed(2)})
              </div>
            )}
          </>
        ) : (
          <span style={{ color: "#f87171" }}>No face picked yet</span>
        )}
      </div>
      <p className="mirror-face-hint">
        Use the on-viewport tools (top-center over the 3D wireframe) to
        pick the reflective face and flip which side reflects, or type
        exact values below.
      </p>
      <EditableAnchorFields
        draft={draft}
        updateDraft={updateDraft}
        showDirection={true}
      />
    </div>
  );
}

// =============================================================================
// LensFaceSection
// =============================================================================

export function LensFaceSection({
  draft,
  hasOutline,
  lensMode,
  updateDraft,
}: {
  draft: AnchorDraft | null;
  hasOutline: boolean;
  lensMode: "plano" | "bi";
  updateDraft: (key: string, patch: Partial<AnchorDraft>) => void;
}) {
  if (!draft) {
    return (
      <div className="component-editor-section">
        <div className="component-editor-section-title">Optical axis</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          No anchor available - load a component with an Asset3D first.
        </div>
      </div>
    );
  }

  const hasFace =
    hasOutline ||
    (draft.directionBodyLocal !== undefined &&
      (draft.directionBodyLocal.x !== 0 ||
        draft.directionBodyLocal.y !== 0 ||
        draft.directionBodyLocal.z !== 0));

  return (
    <div className="component-editor-section">
      <div className="component-editor-section-title">
        Optical axis - <code style={{ fontSize: 11 }}>{lensMode === "plano" ? "Plano-Convex" : "Bi-Convex"}</code>
      </div>
      <div className="mirror-face-status">
        {hasFace ? (
          <>
            <span style={{ color: "#facc15" }}>Anchor placed</span>
            <span style={{ opacity: 0.65, marginLeft: 6 }}>
              center ({draft.positionMmBodyLocal.x.toFixed(2)},{" "}
              {draft.positionMmBodyLocal.y.toFixed(2)},{" "}
              {draft.positionMmBodyLocal.z.toFixed(2)}) mm
            </span>
            {draft.directionBodyLocal && (
              <div style={{ opacity: 0.65, marginTop: 4, fontSize: 11 }}>
                axis = ({draft.directionBodyLocal.x.toFixed(2)},{" "}
                {draft.directionBodyLocal.y.toFixed(2)},{" "}
                {draft.directionBodyLocal.z.toFixed(2)})
              </div>
            )}
          </>
        ) : (
          <span style={{ color: "#f87171" }}>No anchor placed yet</span>
        )}
      </div>
      <p className="mirror-face-hint">
        {lensMode === "plano"
          ? "Plano-Convex: pick the FLAT face on the wireframe. Arrow auto-points toward the convex side. Use +/- buttons to flip, or type values below."
          : "Bi-Convex: snap anchor to body centre, then click X / Y / Z to set the optical axis (or type values below). The arrow renders bidirectional."}
      </p>
      <EditableAnchorFields
        draft={draft}
        updateDraft={updateDraft}
        showDirection={true}
      />
    </div>
  );
}

// =============================================================================
// LaserSourceFaceSection
// =============================================================================

export function LaserSourceFaceSection({
  draft,
  hasOutline,
  updateDraft,
}: {
  draft: AnchorDraft | null;
  hasOutline: boolean;
  updateDraft: (key: string, patch: Partial<AnchorDraft>) => void;
}) {
  if (!draft) {
    return (
      <div className="component-editor-section">
        <div className="component-editor-section-title">Emission point</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          No anchor available - load a component with an Asset3D first.
        </div>
      </div>
    );
  }

  const hasFace =
    hasOutline ||
    (draft.directionBodyLocal !== undefined &&
      (draft.directionBodyLocal.x !== 0 ||
        draft.directionBodyLocal.y !== 0 ||
        draft.directionBodyLocal.z !== 0));

  return (
    <div className="component-editor-section">
      <div className="component-editor-section-title">Emission point (out)</div>
      <div className="mirror-face-status">
        {hasFace ? (
          <>
            <span style={{ color: "#facc15" }}>Face picked</span>
            <span style={{ opacity: 0.65, marginLeft: 6 }}>
              center ({draft.positionMmBodyLocal.x.toFixed(2)},{" "}
              {draft.positionMmBodyLocal.y.toFixed(2)},{" "}
              {draft.positionMmBodyLocal.z.toFixed(2)}) mm
            </span>
            {draft.directionBodyLocal && (
              <div style={{ opacity: 0.65, marginTop: 4, fontSize: 11 }}>
                direction = ({draft.directionBodyLocal.x.toFixed(2)},{" "}
                {draft.directionBodyLocal.y.toFixed(2)},{" "}
                {draft.directionBodyLocal.z.toFixed(2)})
                {" - light exits along +direction"}
              </div>
            )}
          </>
        ) : (
          <span style={{ color: "#f87171" }}>No face picked yet</span>
        )}
      </div>
      <p className="mirror-face-hint">
        Pick the exit face on the laser body's wireframe (sets emission
        position + direction = OUTWARD face normal). Or type X / Y / Z
        below for both position and direction.
      </p>
      <EditableAnchorFields
        draft={draft}
        updateDraft={updateDraft}
        showDirection={true}
      />
    </div>
  );
}

// =============================================================================
// WaveplateFaceSection
// =============================================================================

export function WaveplateFaceSection({
  draft,
  hasOutline,
  updateDraft,
}: {
  draft: AnchorDraft | null;
  hasOutline: boolean;
  updateDraft: (key: string, patch: Partial<AnchorDraft>) => void;
}) {
  if (!draft) {
    return (
      <div className="component-editor-section">
        <div className="component-editor-section-title">Fast axis</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          No anchor available - load a component with an Asset3D first.
        </div>
      </div>
    );
  }

  const hasPos = draft.positionMmBodyLocal.x !== 0 ||
    draft.positionMmBodyLocal.y !== 0 ||
    draft.positionMmBodyLocal.z !== 0 ||
    hasOutline;

  return (
    <div className="component-editor-section">
      <div className="component-editor-section-title">Fast axis (body-local)</div>
      <div className="mirror-face-status">
        {hasPos ? (
          <>
            <span style={{ color: "#facc15" }}>Anchor placed</span>
            <span style={{ opacity: 0.65, marginLeft: 6 }}>
              center ({draft.positionMmBodyLocal.x.toFixed(2)},{" "}
              {draft.positionMmBodyLocal.y.toFixed(2)},{" "}
              {draft.positionMmBodyLocal.z.toFixed(2)}) mm
            </span>
            {draft.directionBodyLocal && (
              <div style={{ opacity: 0.65, marginTop: 4, fontSize: 11 }}>
                fast axis = ({draft.directionBodyLocal.x.toFixed(2)},{" "}
                {draft.directionBodyLocal.y.toFixed(2)},{" "}
                {draft.directionBodyLocal.z.toFixed(2)})
              </div>
            )}
          </>
        ) : (
          <span style={{ color: "#f87171" }}>No anchor placed yet</span>
        )}
      </div>
      <p className="mirror-face-hint">
        Pick the flat face of the waveplate disc on the 3D wireframe
        (sets the position). Then click X / Y / Z to set the fast-axis
        direction in body-local frame, or type values below. The
        per-instance rotation around the beam (Jones-matrix theta) is set
        in the main scene panel.
      </p>
      <EditableAnchorFields
        draft={draft}
        updateDraft={updateDraft}
        showDirection={true}
      />
    </div>
  );
}

// =============================================================================
// BeamSplitterFaceSection (PBS / BS)
// =============================================================================

export function BeamSplitterFaceSection({
  draft,
  hasOutline: _hasOutline,
  bsType,
  splitRatio,
  updateDraft,
}: {
  draft: AnchorDraft | null;
  hasOutline: boolean;
  bsType: "pbs" | "bs";
  splitRatio?: number;
  updateDraft: (key: string, patch: Partial<AnchorDraft>) => void;
}) {
  if (!draft) {
    return (
      <div className="component-editor-section">
        <div className="component-editor-section-title">Diagonal interface</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          No anchor available - load a component with an Asset3D first.
        </div>
      </div>
    );
  }

  const dirSet = !!draft.directionBodyLocal;

  return (
    <div className="component-editor-section">
      <div className="component-editor-section-title">
        Diagonal interface - <code style={{ fontSize: 11 }}>{bsType.toUpperCase()}</code>
      </div>
      <div className="mirror-face-status">
        <div>
          {bsType === "pbs" ? (
            <strong style={{ color: "#a78bfa" }}>Polarizing Beam Splitter</strong>
          ) : (
            <strong style={{ color: "#5eead4" }}>Beam Splitter (non-polarizing)</strong>
          )}
        </div>
        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>
          {bsType === "pbs"
            ? "H polarization transmits, V polarization reflects (per kindParams.transmissionAxisDegBeamLocal). ER from kindParams."
            : `Split ratio T:R = ${(splitRatio ?? 0.5).toFixed(2)} : ${(1 - (splitRatio ?? 0.5)).toFixed(2)} (set per-instance in kindParams.splitRatioTransmitted).`}
        </div>
        <div style={{ marginTop: 6 }}>
          {dirSet ? (
            <>
              <span style={{ color: "#facc15" }}>Interface placed</span>
              <span style={{ opacity: 0.65, marginLeft: 6 }}>
                center ({draft.positionMmBodyLocal.x.toFixed(2)},{" "}
                {draft.positionMmBodyLocal.y.toFixed(2)},{" "}
                {draft.positionMmBodyLocal.z.toFixed(2)}) mm
              </span>
              <div style={{ opacity: 0.65, marginTop: 4, fontSize: 11 }}>
                coating normal = ({draft.directionBodyLocal!.x.toFixed(3)},{" "}
                {draft.directionBodyLocal!.y.toFixed(3)},{" "}
                {draft.directionBodyLocal!.z.toFixed(3)})
              </div>
            </>
          ) : (
            <span style={{ color: "#f87171" }}>No coating normal set</span>
          )}
        </div>
      </div>
      <p className="mirror-face-hint">
        The cement plane between the two right-angle prisms acts as the
        coating. Use the on-viewport tools to snap the anchor to the
        cube centre and click one of the 6 face-aligned diagonal
        directions. The interface is RECTANGULAR (typically L by L * sqrt(2)
        for a cube of side L) - set width and height independently below.
      </p>
      <EditableAnchorFields
        draft={draft}
        updateDraft={updateDraft}
        showDirection={true}
        apertureMode="rectangle"
      />
    </div>
  );
}
