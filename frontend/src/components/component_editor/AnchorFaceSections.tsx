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
 *   - GlanLaserFaceSection  (slanted cut interface — same anchor pattern
 *                            as PBS, the air-gap cut is a TIR reflector)
 *   - IsolatorInternalsSection (read-only summary of the 2× Glan slabs +
 *                            Faraday central plane inside an isolator;
 *                            each Glan row links out to its own
 *                            GlanLaserCalcitePrism editor)
 *
 * Complex sections (TaperedAmplifier, FiberPatchCable, Aom) still
 * live in ComponentEditor.tsx — they pull in helpers from
 * elsewhere in that file (computeBraggTiltAxisFromRfDirectionBodyLocal,
 * useState hooks, etc.) and are a separate extraction pass.
 */
import type {
  Anchor,
  ComponentBinding,
  ComponentItem,
} from "../../types/digitalTwin";

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
// ApertureShapeFields — Circle / Ellipse / Rectangle shape + size inputs.
// Shared by EditableAnchorFields and the generic anchor inspector in
// ComponentEditor.tsx so the three-shape behaviour stays consistent.
// =============================================================================

function inferShape(d: AnchorDraft): "circle" | "ellipse" | "rectangle" {
  if (d.apertureShape) return d.apertureShape;
  if (d.apertureWidthMm != null && d.apertureHeightMm != null) return "rectangle";
  return "circle";
}

export function ApertureShapeFields({
  draft,
  updateDraft,
}: {
  draft: AnchorDraft;
  updateDraft: (key: string, patch: Partial<AnchorDraft>) => void;
}) {
  const shape = inferShape(draft);
  const widthLabel = shape === "ellipse" ? "Semi-major axis (mm)" : "Width (mm)";
  const heightLabel = shape === "ellipse" ? "Semi-minor axis (mm)" : "Height (mm)";
  return (
    <div className="component-editor-aperture">
      <label className="component-editor-coord">
        <span>Aperture shape</span>
        <select
          value={shape}
          onChange={(e) => {
            const next = e.target.value as "circle" | "ellipse" | "rectangle";
            const fallbackHalf = draft.apertureMm ?? 12.5;
            const patch: Partial<AnchorDraft> = { apertureShape: next };
            if (next !== "circle" && (draft.apertureWidthMm == null || draft.apertureHeightMm == null)) {
              patch.apertureWidthMm = draft.apertureWidthMm ?? fallbackHalf * 2;
              patch.apertureHeightMm = draft.apertureHeightMm ?? fallbackHalf * 2;
            }
            updateDraft(draft.__key, patch);
          }}
        >
          <option value="circle">Circle (lens, mirror, waveplate)</option>
          <option value="ellipse">Ellipse</option>
          <option value="rectangle">Rectangle (PBS / BS cube)</option>
        </select>
      </label>
      {shape === "circle" ? (
        <label className="component-editor-coord">
          <span>Radius (mm)</span>
          <input
            type="number"
            step={0.1}
            min={0}
            value={draft.apertureMm ?? 12.5}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (!Number.isFinite(v)) return;
              updateDraft(draft.__key, { apertureMm: v });
            }}
          />
        </label>
      ) : (
        <>
          <label className="component-editor-coord">
            <span>{widthLabel}</span>
            <input
              type="number"
              step={0.1}
              min={0}
              value={draft.apertureWidthMm ?? (draft.apertureMm ?? 12.5) * 2}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v)) return;
                updateDraft(draft.__key, { apertureWidthMm: v });
              }}
            />
          </label>
          <label className="component-editor-coord">
            <span>{heightLabel}</span>
            <input
              type="number"
              step={0.1}
              min={0}
              value={draft.apertureHeightMm ?? (draft.apertureMm ?? 12.5) * 2}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v)) return;
                updateDraft(draft.__key, { apertureHeightMm: v });
              }}
            />
          </label>
        </>
      )}
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
  showAperture = true,
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
  /** When false, skip the aperture editor. Used by kinds whose beam
   *  geometry is described by Gaussian modematching (laser_source,
   *  tapered_amplifier, fiber) rather than a hard clear aperture. */
  showAperture?: boolean;
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
      {!showConnectorType && showAperture && (
        <ApertureShapeFields draft={draft} updateDraft={updateDraft} />
      )}
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
        showAperture={false}
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
      <div className="component-editor-section-title" style={{ marginTop: 10 }}>
        Fast-axis angle (deg, body-local)
      </div>
      <p className="mirror-face-hint" style={{ marginTop: 0 }}>
        Asset-level base angle for the crystal cut, in body-local beam
        coordinates. Per-instance rotation around the beam axis (Object
        panel) is layered on top; effective Jones-frame angle = this +
        instance rotation.
      </p>
      <label className="component-editor-coord">
        <span>deg</span>
        <input
          type="number"
          step={1}
          value={draft.fastAxisDegBodyLocal ?? 0}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isFinite(v)) return;
            updateDraft(draft.__key, { fastAxisDegBodyLocal: v });
          }}
        />
      </label>
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


// =============================================================================
// GlanLaserFaceSection — mirrors BeamSplitterFaceSection (the slanted air-gap
// cut inside a Glan-Laser is physically a TIR reflector, equivalent to PBS's
// diagonal cement plane).
// =============================================================================

export function GlanLaserFaceSection({
  draft,
  hasOutline: _hasOutline,
  wedgeAngleDeg,
  updateDraft,
}: {
  draft: AnchorDraft | null;
  hasOutline: boolean;
  /** Wedge angle from kindParams (default 38° for calcite at 850 nm).
   *  Drives the cut-plane normal hint shown to the user. */
  wedgeAngleDeg?: number;
  updateDraft: (key: string, patch: Partial<AnchorDraft>) => void;
}) {
  if (!draft) {
    return (
      <div className="component-editor-section">
        <div className="component-editor-section-title">Slanted cut interface</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          No anchor available - load a component with an Asset3D first.
        </div>
      </div>
    );
  }

  const dirSet = !!draft.directionBodyLocal;
  const wedge = wedgeAngleDeg ?? 38;
  const wedgeRad = (wedge * Math.PI) / 180;
  const expectedNy = Math.cos(wedgeRad);
  const expectedNz = Math.sin(wedgeRad);

  return (
    <div className="component-editor-section">
      <div className="component-editor-section-title">
        Slanted cut interface - <code style={{ fontSize: 11 }}>GLAN-LASER</code>
      </div>
      <div className="mirror-face-status">
        <div>
          <strong style={{ color: "#a78bfa" }}>Glan-Laser Polariser</strong>
        </div>
        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>
          E-ray (parallel polarisation) transmits straight through; O-ray
          (orthogonal polarisation) hits TIR at the air-gap cut and exits
          the side at ~67-68° from the optical axis (per
          kindParams.transmissionAxisDegBeamLocal). ER from kindParams.
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
              <div style={{ opacity: 0.55, marginTop: 2, fontSize: 10 }}>
                expected for {wedge}° wedge: (0.000, {expectedNy.toFixed(3)},{" "}
                {expectedNz.toFixed(3)})
              </div>
            </>
          ) : (
            <span style={{ color: "#f87171" }}>No coating normal set</span>
          )}
        </div>
      </div>
      <p className="mirror-face-hint">
        The air-gap cut between the two right-angle calcite prisms acts as a
        TIR reflector — same role as a PBS cube's diagonal cement plane.
        Snap the anchor to the body centre and set the direction to the cut
        normal: for a wedge angle θ from the optical axis Z, the normal
        sits at (0, cos θ, sin θ). The interface is RECTANGULAR (aperture ×
        aperture / sin θ) — set width and height independently below.
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


// =============================================================================
// IsolatorInternalsSection — read-only summary of the 3-stage chain
// (front Glan slab + Faraday central plane + back Glan slab) inside an
// isolator Component. Each Glan row is a non-editable view + a link that
// navigates to the GlanLaserCalcitePrism editor.
// =============================================================================

/** Minimal shape of the nested isolator kindParams the section needs to
 *  display. All optional — when missing, the section shows "(plugin
 *  default)" for the affected fields. */
export interface IsolatorInternalsKindParams {
  frontGlan?: {
    transmissionAxisDegBeamLocal?: number;
    transmission?: number;
    extinctionRatioDb?: number;
    lengthMm?: number;
    refractiveIndex?: number;
    wedgeAngleDeg?: number;
  };
  backGlan?: {
    transmissionAxisDegBeamLocal?: number;
    transmission?: number;
    extinctionRatioDb?: number;
    lengthMm?: number;
    refractiveIndex?: number;
    wedgeAngleDeg?: number;
  };
  faraday?: {
    faradayRotationDeg?: number;
    lengthMm?: number;
    refractiveIndex?: number;
    augmentedOffsetXMm?: number;
    augmentedOffsetYMm?: number;
  };
}

interface IsolatorInternalsSubcomponent {
  /** Slot label — the migration 0071 convention stores
   *  "front_glan_laser" / "back_glan_laser" in binding.properties.role_label
   *  (not in binding.role, which is hardcoded "internal_part"). Caller
   *  resolves and passes the effective label here so slot matching
   *  works regardless of which field future migrations use. */
  roleLabel: string;
  binding: ComponentBinding;
  subComponent: ComponentItem;
}

export function IsolatorInternalsSection({
  isolatorComponent,
  subcomponents,
  kindParams,
  onNavigateToSubcomponent,
}: {
  isolatorComponent: ComponentItem;
  /** Pre-resolved by the parent — typically 2 Glan slabs (front + back).
   *  Caller filters component_bindings for targetKind="subcomponent" and
   *  looks up each subComponentId in the components list. */
  subcomponents: IsolatorInternalsSubcomponent[];
  /** kindParams from the FIRST scene instance of this isolator (the
   *  parent ComponentEditor already infers this for the BS section). */
  kindParams: IsolatorInternalsKindParams;
  /** Called when the user clicks a Glan slab's "Edit →" link. Should
   *  switch the PHY Editor's selected component to the given
   *  sub-Component id (use the existing handlePickComponent flow so the
   *  dirty-check prompt fires). */
  onNavigateToSubcomponent: (componentId: string) => void;
}) {
  const front = kindParams.frontGlan ?? {};
  const back = kindParams.backGlan ?? {};
  const faraday = kindParams.faraday ?? {};

  const fmt = (v: number | undefined, unit = "", digits = 3): string =>
    typeof v === "number" && Number.isFinite(v)
      ? `${v.toFixed(digits)}${unit}`
      : "(plugin default)";

  // Match a binding role to the nested Glan kindParams slot. Catalogue
  // role labels include "front_glan_laser" / "back_glan_laser"; allow
  // shorter "front"/"back" aliases for future migrations.
  const slotFor = (role: string): "front" | "back" | null => {
    const r = role.toLowerCase();
    if (r.includes("front")) return "front";
    if (r.includes("back")) return "back";
    return null;
  };

  return (
    <div className="component-editor-section">
      <div className="component-editor-section-title">
        Isolator internals - <code style={{ fontSize: 11 }}>{isolatorComponent.name}</code>
      </div>
      <p className="mirror-face-hint">
        Read-only view of the 3-stage chain (Glan-Laser → Faraday Rotator
        → Glan-Laser). Glan-slab optics live on the
        <code style={{ margin: "0 3px" }}>GlanLaserCalcitePrism</code>
        sub-Component — click the link on each row to edit there. The
        Faraday central plane is owned by the isolator and edited via
        kindParams in the Object panel of each scene instance.
      </p>

      {/* === Front Glan slab === */}
      {subcomponents
        .filter((s) => slotFor(s.roleLabel) === "front")
        .map((s) => {
          const p = front;
          return (
            <div key={s.binding.id} className="mirror-face-status" style={{ marginTop: 4 }}>
              <div>
                <strong style={{ color: "#a78bfa" }}>
                  Front Glan slab (m_glan_slab)
                </strong>
                <span style={{ opacity: 0.65, fontSize: 11, marginLeft: 8 }}>
                  → {s.subComponent.name}
                </span>
              </div>
              <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4, lineHeight: 1.5 }}>
                axis = {fmt(p.transmissionAxisDegBeamLocal, "°", 1)} ·{" "}
                T = {fmt(p.transmission, "", 2)} ·{" "}
                ER = {fmt(p.extinctionRatioDb, " dB", 0)}<br />
                L = {fmt(p.lengthMm, " mm", 2)} ·{" "}
                n_e = {fmt(p.refractiveIndex, "", 2)} ·{" "}
                wedge = {fmt(p.wedgeAngleDeg, "°", 1)}
              </div>
              <button
                type="button"
                className="editor-viewport-side-btn"
                style={{ marginTop: 6 }}
                onClick={() => onNavigateToSubcomponent(s.subComponent.id)}
                title={`Open ${s.subComponent.name} in this PHY editor to edit its anchor / cut interface.`}
              >
                Edit in {s.subComponent.name} →
              </button>
            </div>
          );
        })}

      {/* === Faraday central plane (owned by the isolator itself) === */}
      <div className="mirror-face-status" style={{ marginTop: 8 }}>
        <div>
          <strong style={{ color: "#fbbf24" }}>
            Faraday central plane (m_faraday_slab)
          </strong>
          <span style={{ opacity: 0.65, fontSize: 11, marginLeft: 8 }}>
            anchor: faraday_centre
          </span>
        </div>
        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4, lineHeight: 1.5 }}>
          θ_F = {fmt(faraday.faradayRotationDeg, "°", 1)} ·{" "}
          L = {fmt(faraday.lengthMm, " mm", 2)} ·{" "}
          n (TGG) = {fmt(faraday.refractiveIndex, "", 2)}<br />
          E_x = {fmt(faraday.augmentedOffsetXMm, " mm", 3)} ·{" "}
          E_y = {fmt(faraday.augmentedOffsetYMm, " mm", 3)}
        </div>
        <div style={{ fontSize: 10, opacity: 0.55, marginTop: 4 }}>
          Edit per-instance via Object panel kindParams.faraday — central
          plane sits at body centre normal to the optical axis.
        </div>
      </div>

      {/* === Back Glan slab === */}
      {subcomponents
        .filter((s) => slotFor(s.roleLabel) === "back")
        .map((s) => {
          const p = back;
          return (
            <div key={s.binding.id} className="mirror-face-status" style={{ marginTop: 8 }}>
              <div>
                <strong style={{ color: "#a78bfa" }}>
                  Back Glan slab (m_glan_slab)
                </strong>
                <span style={{ opacity: 0.65, fontSize: 11, marginLeft: 8 }}>
                  → {s.subComponent.name}
                </span>
              </div>
              <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4, lineHeight: 1.5 }}>
                axis = {fmt(p.transmissionAxisDegBeamLocal, "°", 1)} ·{" "}
                T = {fmt(p.transmission, "", 2)} ·{" "}
                ER = {fmt(p.extinctionRatioDb, " dB", 0)}<br />
                L = {fmt(p.lengthMm, " mm", 2)} ·{" "}
                n_e = {fmt(p.refractiveIndex, "", 2)} ·{" "}
                wedge = {fmt(p.wedgeAngleDeg, "°", 1)}
              </div>
              <button
                type="button"
                className="editor-viewport-side-btn"
                style={{ marginTop: 6 }}
                onClick={() => onNavigateToSubcomponent(s.subComponent.id)}
                title={`Open ${s.subComponent.name} in this PHY editor to edit its anchor / cut interface.`}
              >
                Edit in {s.subComponent.name} →
              </button>
            </div>
          );
        })}

      {subcomponents.length === 0 && (
        <div style={{ fontSize: 12, color: "#f87171", marginTop: 4 }}>
          No sub-Component bindings found. Run migration 0071 to seed the
          IO-3-850-HP / IO-5-850-HP binding tree with Glan sub-Components.
        </div>
      )}
    </div>
  );
}
