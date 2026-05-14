/**
 * Per-ElementKind contract registry. Each entry tells the Component
 * Editor (and, eventually, alignAlgorithm dispatch) what to expect
 * from a 3D model of that kind:
 *
 *   - which anchor IDs are required for the kind to work
 *   - which anchor IDs are optional / supplementary
 *   - which align variant the kind uses
 *   - human-readable summary of the align condition (shown in the
 *     editor's right panel as a read-only "this is what the align
 *     button will try to do" reference)
 *
 * This is the seed of Phase 7 / 8 / 9: when alignSpec moves to a DB
 * table and alignAlgorithm becomes a registered pure function, this
 * file becomes the registration entry-point. For now it's the single
 * place that captures "what does each kind need from its 3D model".
 *
 * Phase 7.1 only: AOM physics already lives in `aom/physics.ts` and is
 * imported by AomAdjustControls + rayTrace.ts directly; this registry
 * is the contract layer above the physics.
 */

import type { ElementKind } from "../types/digitalTwin";

/** Whitelist of legal anchor IDs (mirrors backend AssetAnchorId Literal
 *  in app/schemas.py). Free strings get rejected by the inspector
 *  dropdown. */
export type AnchorId =
  | "intercept_face"
  | "intercept_in"
  | "intercept_out"
  | "in"
  | "seed"
  | "out"
  | "optical_anchor"
  | "center"
  // AOM-specific direction anchor (Phase 8 refactor 2026-05-10).
  // `id="rf_direction"` carries the body-local RF / acoustic propagation
  // direction; position is body origin; apertureMm unused.
  | "rf_direction"
  // RF ports for hybrid / RF-emitting kinds. `rf_out` marks an output
  // SMA / coax port (e.g. each AD9959 channel, AOM driver feed-through);
  // `rf_in` marks the RF input port (e.g. AOM RF connector). Position +
  // outward direction matter for visualising the cable hookup; aperture
  // is currently unused. (Added 2026-05-13 with the physics_elements
  // rename so the PHY Editor's anchor inspector can place these ports.)
  | "rf_in"
  | "rf_out"
  // TTL / digital-control input port (added 2026-05-14 with the
  // rf_switch kind). A logic-level input that selects switch state —
  // physically realised on the Mini-Circuits ZYSWA-2-50DR as a 4th
  // SMA-F jack on the case (labelled "TTL" next to RFIN/RF1/RF2), so
  // structurally it's just another coax port. Position = jack centre,
  // direction = outward face normal, so a mating control-line cable's
  // End-A anchor aligns to it like any RF port. Distinct id (not
  // `rf_in`) because solver / cable-routing semantics differ — TTL is
  // a digital control signal, not an RF analogue path, and downstream
  // RF-chain math should not see it as a signal source.
  | "ttl_in"
  // Horn-antenna aperture face — radiation lobe origin + main-beam
  // direction (cos^n parametric pattern).
  | "aperture"
  // Optical-isolator internal PBS cube anchors (diagonal cement
  // interface — position = cube centre, direction = coating normal,
  // apertureMm = half the active interface size). Used by the
  // `isolator` kind below.
  | "front_pbs"
  | "back_pbs"
  | "+x" | "-x" | "+y" | "-y" | "+z" | "-z";

/** Anchor IDs the Editor inspector exposes in its dropdown. We
 *  intentionally narrow this to the optical-relevant subset; the ±axis
 *  anchors are computed by face-bbox math and shouldn't be edited by
 *  hand. */
export const EDITABLE_ANCHOR_IDS: AnchorId[] = [
  "intercept_in",
  "intercept_out",
  "intercept_face",
  "in",
  "seed",
  "out",
  "optical_anchor",
  "center",
  "rf_in",
  "rf_out",
  "ttl_in",
  "aperture",
];

export type KindAlignVariant =
  | "translate_anchor_to_beam"
  | "translate_and_bragg_rotate"
  | "translate_anti_parallel"
  | "none";

export interface KindContract {
  kind: ElementKind;
  displayName: string;
  /** Anchors the kind cannot work without. */
  requiredAnchors: AnchorId[];
  /** Anchors that improve behaviour when present (e.g. asymmetric
   *  intercept_in / intercept_out for elements with directional
   *  geometry). */
  optionalAnchors: AnchorId[];
  /** Anchors whose `directionBodyLocal` must also be set, not just the
   *  position. Mirror's `intercept_face` is the canonical example: the
   *  align algorithm and ray-tracer both need to know which side of the
   *  reflective face the beam should reflect off, which is fully
   *  specified only by the (point, normal) pair. */
  anchorsNeedingDirection: AnchorId[];
  /** Anchors whose `apertureMm` must be set (not null/undefined).
   *  Optional in the contract type — defaults to `[]` when omitted, so
   *  pre-existing kind entries don't need to declare the field.
   *
   *  AOM is the canonical case: both ports need the active aperture so
   *  beam-clipping warnings can fire and the entry-port ambiguity
   *  guard has a length scale to compare against. The PHY Editor's
   *  Save validates this and blocks saves that leave any
   *  required-aperture anchor without a value; runtime align checks
   *  the same. */
  anchorsNeedingAperture?: AnchorId[];
  alignVariant: KindAlignVariant;
  alignToleranceMm: number;
  /** One-line description of what the align button does. Shown in the
   *  Editor's right pane so users editing a 3D model know what their
   *  anchor placement needs to satisfy. */
  alignSummary: string;
}

/** Source-of-truth registry. Update this when a new ElementKind is
 *  added or an existing kind's alignment behaviour is changed. */
export const KIND_REGISTRY: Record<ElementKind, KindContract> = {
  laser_source: {
    kind: "laser_source",
    displayName: "Laser Source",
    requiredAnchors: [],
    optionalAnchors: ["out", "intercept_out"],
    anchorsNeedingDirection: [],
    alignVariant: "none",
    alignToleranceMm: 0,
    alignSummary: "Emitter — beam originates here. Not aligned to anything.",
  },
  tapered_amplifier: {
    kind: "tapered_amplifier",
    displayName: "Tapered Amplifier",
    requiredAnchors: ["intercept_in", "intercept_out"],
    optionalAnchors: ["seed"],
    anchorsNeedingDirection: ["intercept_in", "intercept_out"],
    alignVariant: "translate_anti_parallel",
    alignToleranceMm: 25,
    alignSummary:
      "Dual-anchor kind: intercept_in marks INPUT face (where seed light enters) and intercept_out marks OUTPUT face (where amplified beam exits). Both directions are OUTWARD face normals (point away from chip body). The two faces don't have to be opposite — side-output / shaped TAs route the amplified beam at any angle. The chip's mode profile + polarization preferences live in kindParams (not in the anchor).",
  },
  mirror: {
    kind: "mirror",
    displayName: "Mirror",
    requiredAnchors: ["intercept_face"],
    optionalAnchors: [],
    anchorsNeedingDirection: ["intercept_face"],
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "Reflective face center translates onto incoming beam. User dials in U/V offset + rx/ry/rz to aim reflection. The face needs a normal direction so the ray-tracer knows which side of the plane the beam reflects off.",
  },
  dichroic_mirror: {
    kind: "dichroic_mirror",
    displayName: "Dichroic Mirror",
    requiredAnchors: ["intercept_face"],
    optionalAnchors: [],
    anchorsNeedingDirection: ["intercept_face"],
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "Same as mirror — face center + normal direction, then user aims via U/V + rotation.",
  },
  lens_biconvex: {
    kind: "lens_biconvex",
    displayName: "Biconvex Lens",
    requiredAnchors: ["intercept_in"],
    optionalAnchors: ["intercept_out"],
    anchorsNeedingDirection: ["intercept_in"],
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "intercept_in translates to beam axis. Direction = optical axis (light propagation direction through lens body).",
  },
  lens_plano_convex: {
    kind: "lens_plano_convex",
    displayName: "Plano-Convex Lens",
    requiredAnchors: ["intercept_in"],
    optionalAnchors: ["intercept_out"],
    anchorsNeedingDirection: ["intercept_in"],
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "intercept_in is the plane-side surface center; direction points from plane toward convex side.",
  },
  lens_cylindrical: {
    kind: "lens_cylindrical",
    displayName: "Cylindrical Lens",
    requiredAnchors: ["intercept_in"],
    optionalAnchors: ["intercept_out"],
    anchorsNeedingDirection: ["intercept_in"],
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "intercept_in translates to beam axis. Direction = optical axis (light propagation direction through lens body).",
  },
  waveplate: {
    kind: "waveplate",
    displayName: "Waveplate",
    requiredAnchors: ["intercept_in"],
    optionalAnchors: [],
    anchorsNeedingDirection: ["intercept_in"],
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "Pick the flat face on the wireframe (sets intercept_in position). Pick X/Y/Z as the fast-axis direction (stored in directionBodyLocal). Per-instance fast-axis angle around the beam stays in kindParams.fastAxisDegBeamLocal.",
  },
  polarizer: {
    kind: "polarizer",
    displayName: "Polarizer",
    requiredAnchors: ["intercept_in"],
    optionalAnchors: [],
    anchorsNeedingDirection: [],
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "intercept_in translates to beam axis. Translation only.",
  },
  beam_splitter: {
    kind: "beam_splitter",
    displayName: "Beam Splitter / PBS",
    requiredAnchors: ["intercept_in"],
    optionalAnchors: ["intercept_out"],
    anchorsNeedingDirection: ["intercept_in"],
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "Cube of two right-angle prisms cemented along the diagonal. intercept_in marks that diagonal interface: position = cube centre, direction = coating normal (along ±(X±Y) / ±(X±Z) / ±(Y±Z) for face-aligned cubes), aperture = half the active interface size. PBS vs BS distinguished by Component.properties.beamSplitterType (Phase 2 schema).",
  },
  fiber_coupler: {
    kind: "fiber_coupler",
    displayName: "Fiber Coupler",
    requiredAnchors: ["intercept_in"],
    optionalAnchors: [],
    anchorsNeedingDirection: [],
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "intercept_in (free-space side) translates to beam.",
  },
  fiber: {
    kind: "fiber",
    displayName: "Fiber Patch Cable",
    // 2026-05-09 refactor: fiber finally joins the standard anchor model.
    // intercept_in = optical port at End A (= the spline's first node side),
    // intercept_out = optical port at End B (= last node side). Coordinates
    // are in CONNECTOR body-local mm (NOT the asset body frame other kinds
    // use — fiber doesn't have one), with +Y outward from the cable. The
    // ferrule tip lives at (0, 36.28, 0), the cable enters at (0, 0, 0).
    // The connector world transform is composed from the Bezier handle at
    // each endpoint (see applyFiberConnectorTransform in loadAsset.ts), so
    // dragging a spline node carries the anchor with it automatically.
    //
    // Storage: since fiber has no Asset3D, anchors live on
    // Component.properties.fiberAnchors[] (parallel to Asset.anchors[] but
    // attached to the Component template — works because each fiber has
    // its own 1:1 component template).
    //
    // Aperture: defaults to 2.5 mm (the ceramic ferrule metal-sleeve OD).
    // This is GEOMETRIC clipping — rays outside the aperture are dropped.
    // It is NOT the mode field diameter (~5 µm PM, ~10 µm SM); that lives
    // on kindParams.endA/B.modeFieldDiameterUm and is for Gaussian beam
    // tracking (not yet wired into the geometric ray-tracer).
    //
    // Both ports are REQUIRED + DIRECTION-BEARING (2026-05-12): ray-trace
    // bails out if either anchor is missing (rayTrace.ts), and align
    // needs BOTH position (where the port lands on the beam) AND
    // direction (face normal anti-parallel to beam at the entry end,
    // parallel at the exit end). Direction is auto-derived from the
    // spline tangent via the anchor's `derivedFromFiberEndpoint` flag,
    // not from the stored `directionBodyLocal` — but the contract still
    // marks them as needing direction because the align semantics
    // require it.
    requiredAnchors: ["intercept_in", "intercept_out"],
    optionalAnchors: [],
    anchorsNeedingDirection: ["intercept_in", "intercept_out"],
    anchorsNeedingAperture: ["intercept_in", "intercept_out"],
    alignVariant: "none",
    alignToleranceMm: 25,
    alignSummary:
      "Bidirectional patch cable, rendered procedurally from a Bezier spline (no static GLB/STL asset). " +
      "Geometry inputs live on Component.properties: fiberNodes[] (≥2 nodes — posMm + optional handleInMm/handleOutMm tangents), radiusMm (jacket radius, default 1.0 mm), and fiberAnchors[] (intercept_in / intercept_out — port face positions in CONNECTOR body-local mm, with +Y outward from the cable; ferrule tip default = (0, 36.28, 0)). " +
      "End A is the first spline node, End B is the last; both ends carry an FC connector (PC or APC polish from kindParams) whose ferrule points outward along −handleOut at A / −handleIn at B. The intercept_in anchor rides along End A's connector frame, intercept_out along End B's — moving a spline node automatically carries the optical port with it. " +
      "ComponentPanel ▸ Fiber: Jacket radius slider · Align End A/B to beam · Slow axis (PM only — Layer 4, per-instance kindParams). Spline path editing (drag anchor / drag handle / double-click to insert / right-click to delete) is driven globally by the viewer's node-edit displayMode. " +
      "The two “Align End A/B” buttons call store.alignFiberEndToBeam(componentId, end) which snaps the PORT (intercept_in for A / intercept_out for B — at the ferrule tip, 36.28 mm out from the spline node) onto the closest beam-path segment within alignToleranceMm (≤25 mm), then back-derives the spline node 36.28 mm BEHIND the projected port along the new outward direction (outward = −beam_tangent for A entry, +beam_tangent for B exit). Interior nodes don't move, so the curve flexes only near that end.",
  },
  isolator: {
    kind: "isolator",
    displayName: "Optical Isolator",
    // Optical isolator = PBS + Faraday Rotator + PBS in series. Anchors
    // come in two flavours:
    //   - intercept_in / intercept_out: the device's outer ports — beam
    //     enters via intercept_in, exits via intercept_out.
    //   - front_pbs / back_pbs: each PBS cube's diagonal cement interface,
    //     same semantics as the beam_splitter kind (position = cube centre,
    //     direction = coating normal along ±(X±Y) / ±(X±Z) / ±(Y±Z) for
    //     face-aligned cubes, aperture = half the active interface size).
    //     The two PBS directions implicitly fix the device's transmission
    //     axis at each face; faradayRotationDeg (typ. 45°) lives in
    //     kindParams. Asset authors who don't know the internal layout
    //     can omit the front_pbs / back_pbs anchors — the device still
    //     works as a black-box pass-through in the current solver.
    requiredAnchors: ["intercept_in"],
    optionalAnchors: ["intercept_out", "front_pbs", "back_pbs"],
    anchorsNeedingDirection: ["front_pbs", "back_pbs"],
    anchorsNeedingAperture: ["front_pbs", "back_pbs"],
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "Forward-pass Faraday isolator. intercept_in translates to beam axis (forward direction); intercept_out is the rear device port. " +
      "Internally PBS + Faraday rotator + PBS: front_pbs and back_pbs (both optional) mark each PBS cube's diagonal cement interface using the same semantics as the beam_splitter kind — position = cube centre, direction = coating normal (along ±(X±Y) / ±(X±Z) / ±(Y±Z) for face-aligned cubes), aperture = half the active interface size. " +
      "The Faraday rotator's rotation angle (typically 45°) lives in kindParams.faradayRotationDeg.",
  },
  aom: {
    kind: "aom",
    displayName: "AOM (Acousto-Optic Modulator)",
    // intercept_in / intercept_out = optical ports (aperture matters,
    // direction auto-derived from the body axis).
    // rf_in = physical SMA / coax connector on the AOM driver housing,
    // where the DDS / amp feed enters. Position + outward direction
    // matter for visualising the cable hookup; aperture is unused for
    // RF anchors. The acoustic propagation direction inside the crystal
    // is a SEPARATE concern carried by the `rf_direction` anchor (Phase
    // 8 refactor) or `kindParams.rfPropagationDirectionBodyLocal`.
    requiredAnchors: ["intercept_in", "intercept_out", "rf_in"],
    optionalAnchors: [],
    anchorsNeedingDirection: ["rf_in"],
    anchorsNeedingAperture: ["intercept_in", "intercept_out"],
    alignVariant: "translate_and_bragg_rotate",
    alignToleranceMm: 25,
    alignSummary:
      "Define intercept_in / intercept_out (both with apertureMm). Align picks whichever port the upstream beam reaches first as the entry, translates that anchor onto the beam line, then rotates the body 1-D around lab tilt axis (pivot = midpoint of the two anchors = Bragg interaction point). Forward traversal uses the selected +1/-1 order; reverse traversal swaps +1 and -1 for the same mechanical Bragg tilt. " +
      "rf_in marks the SMA / coax RF drive connector on the AOM driver housing (position = jack centre on the body, direction = outward face normal = the way a mating cable plug slides on). Used purely for cable-routing visualisation in 3D — not consumed by the Bragg solver.",
  },
  eom: {
    kind: "eom",
    displayName: "EOM (Electro-Optic Modulator)",
    requiredAnchors: ["intercept_in"],
    optionalAnchors: ["intercept_out"],
    anchorsNeedingDirection: [],
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "intercept_in translates to beam. Translation only.",
  },
  nonlinear_crystal: {
    kind: "nonlinear_crystal",
    displayName: "Nonlinear Crystal",
    requiredAnchors: ["intercept_in"],
    optionalAnchors: ["intercept_out"],
    anchorsNeedingDirection: [],
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "intercept_in translates to fundamental beam. Phase matching set in kindParams.",
  },
  saturable_absorber: {
    kind: "saturable_absorber",
    displayName: "Saturable Absorber",
    requiredAnchors: ["intercept_in"],
    optionalAnchors: [],
    anchorsNeedingDirection: [],
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "intercept_in translates to beam axis.",
  },
  detector: {
    kind: "detector",
    displayName: "Detector",
    requiredAnchors: ["intercept_in"],
    optionalAnchors: [],
    anchorsNeedingDirection: [],
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "Active area centre (intercept_in) translates to beam. Beam absorbed.",
  },
  camera: {
    kind: "camera",
    displayName: "Camera",
    requiredAnchors: ["intercept_in"],
    optionalAnchors: [],
    anchorsNeedingDirection: [],
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "Sensor centre (intercept_in) translates to beam. Beam absorbed.",
  },
  spectrometer: {
    kind: "spectrometer",
    displayName: "Spectrometer",
    requiredAnchors: ["intercept_in"],
    optionalAnchors: [],
    anchorsNeedingDirection: [],
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "Slit/fiber input (intercept_in) translates to beam.",
  },
  wavemeter: {
    kind: "wavemeter",
    displayName: "Wavemeter",
    requiredAnchors: ["intercept_in"],
    optionalAnchors: [],
    anchorsNeedingDirection: [],
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "Input port (intercept_in) translates to beam.",
  },
  beam_dump: {
    kind: "beam_dump",
    displayName: "Beam Dump",
    requiredAnchors: ["intercept_in"],
    optionalAnchors: [],
    anchorsNeedingDirection: [],
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "Absorbing face (intercept_in) translates to beam. Beam terminates.",
  },
  rf_source: {
    kind: "rf_source",
    displayName: "RF Source",
    requiredAnchors: [],
    optionalAnchors: ["rf_out"],
    anchorsNeedingDirection: [],
    alignVariant: "none",
    alignToleranceMm: 0,
    alignSummary:
      "RF emitter — DDS / synth / arbitrary-waveform generator. Drives downstream RF chain (amp / filter / AOM-EOM driver). Not aligned optically.",
  },
  rf_amplifier: {
    kind: "rf_amplifier",
    displayName: "RF Amplifier",
    // Phase RF.amp (2026-05-14): coaxial RF gain block (Mini-Circuits ZHL
    // series and similar). Unidirectional: rf_in is the SMA input
    // connector, rf_out is the SMA output connector. Both directions are
    // OUTWARD face normals — they point the way a mating cable plug
    // would slide on. Position + outward direction matter for cable
    // routing visualisation; aperture is unused for RF anchors. Gain,
    // frequency range, P_1dB, and noise figure live in kindParams.
    requiredAnchors: ["rf_in", "rf_out"],
    optionalAnchors: [],
    anchorsNeedingDirection: ["rf_in", "rf_out"],
    alignVariant: "none",
    alignToleranceMm: 0,
    alignSummary:
      "Coaxial RF amplifier (e.g. Mini-Circuits ZHL-1-2W+, ZHL-42W+). rf_in marks the input SMA / coax connector; rf_out marks the output SMA / coax connector. Both directions are OUTWARD face normals (pointing away from the body the way a mating plug slides on). Gain, frequency range, P_1dB, NF, and supply spec live in kindParams. Not aligned optically — RF signal flows through cables, not free space.",
  },
  horn_antenna: {
    kind: "horn_antenna",
    displayName: "Horn Antenna",
    requiredAnchors: [],
    optionalAnchors: ["aperture"],
    anchorsNeedingDirection: ["aperture"],
    alignVariant: "none",
    alignToleranceMm: 0,
    alignSummary:
      "Microwave horn / antenna — radiates the chain output along its polar axis (+Z body-local by default). Phase RF.7 renders a parametric cos^n radiation lobe; palace farfield can populate a real pattern later.",
  },
  rf_switch: {
    kind: "rf_switch",
    /* eslint-disable max-len */
    // Phase RF.switch (2026-05-14): coaxial RF switch (SP2T family).
    // The Mini-Circuits ZYSWA-2-50DR datasheet exposes FOUR physical
    // SMA-F connectors on the case — three for the RF path and one
    // for the TTL control:
    //   rf_in   ×1   →  RFIN (common port; the single "pole" of SP2T)
    //   rf_out  ×N   →  RF1, RF2, …  (the N "throws"; multiple anchors
    //                    share id="rf_out" and are distinguished by
    //                    `name`, the same trick AD9959 uses for its 4
    //                    CHx outputs — see digitalTwin.ts:62)
    //   ttl_in  ×1   →  TTL (logic-level control: high → RF1 routed,
    //                    low → RF2 routed for the ZYSWA-2-50DR)
    // The switch is reciprocal at small signal — a 1-in/2-out SP2T is
    // also a 2-in/1-out multiplexer; the digital twin marks all three
    // RF ports `bidirectional` in DEFAULT_PORTS and the active throw
    // is decided at solve time from the TTL state (driven either by
    // an upstream RfSource hooked to ttl_in or by the kind-level
    // TTL_GATE_KINDS picker — both paths converge on
    // DeviceState.state.activeThrow). Needs ±5 V supply (declared
    // via POWER_KINDS) so an Instrument Power toggle attaches.
    /* eslint-enable max-len */
    displayName: "RF Switch",
    requiredAnchors: ["rf_in", "rf_out", "ttl_in"],
    optionalAnchors: [],
    anchorsNeedingDirection: ["rf_in", "rf_out", "ttl_in"],
    alignVariant: "none",
    alignToleranceMm: 25,
    alignSummary:
      "Coaxial RF switch (SP2T by default). Four physical SMA-F connectors on the case: rf_in marks the common port (RFIN); the N throw ports are anchors all keyed `rf_out` and distinguished by `name` (RF1, RF2, …); ttl_in marks the TTL control port (a 4th SMA on the ZYSWA-2-50DR). All four directions are OUTWARD face normals — same convention as rf_cable — so a mating cable's End A / End B anchors line up. The switch is reciprocal at small signal (1-in/2-out SPDT == 2-in/1-out multiplexer); the active throw is decided at solve time from the TTL state on ttl_in, or from the kind-level TTL_GATE_KINDS picker when no cable is hooked up — both write to DeviceState.state.activeThrow. ±5 V supply lives at the kind level (POWER_KINDS) so the Instrument Power toggle attaches automatically. Per-model insertion loss / isolation / max input power live in RfSwitchParams.",
  },
  rf_cable: {
    kind: "rf_cable",
    displayName: "RF Cable",
    // Phase RF.cable (2026-05-13): coaxial RF cable, parallel to the
    // `fiber` kind. Two bidirectional SMA / BNC / N endpoints identified
    // by anchor id: rf_in = End A, rf_out = End B. Spline-based
    // rendering with Bezier control handles is TODO — the current 3D
    // visual reuses `createSmaShortCable` (parametric straight cable
    // scaled by Component.properties.lengthMm).
    requiredAnchors: ["rf_in", "rf_out"],
    optionalAnchors: [],
    anchorsNeedingDirection: ["rf_in", "rf_out"],
    alignVariant: "none",
    alignToleranceMm: 25,
    alignSummary:
      "Bidirectional coaxial RF cable. rf_in (End A) and rf_out (End B) mark the two SMA / BNC / N connector tips; both directions are OUTWARD face normals (pointing away from the cable body, the way a mating plug would slide on). Cable physics (impedance, max frequency, connector type, jacket OD) lives in RfCableParams. Spline editing UX (analogous to fiber's ✏ Edit fiber path) is a follow-up — current visual is parametric straight cable.",
  },
};

/** ElementKinds that have a meaningful align contract — used to filter
 *  the Component Editor's left list down to "components with function". */
export function kindsWithFunction(): ElementKind[] {
  return (Object.keys(KIND_REGISTRY) as ElementKind[]).filter(
    (k) => KIND_REGISTRY[k].alignVariant !== "none",
  );
}

/** ElementKinds the PHY Editor's component list should show — anything
 *  with at least one defined anchor (required or optional) qualifies.
 *  Laser sources have alignVariant="none" but still need an editable
 *  `out` anchor to set the emission origin + direction, so we use this
 *  broader criterion in the editor instead of `kindsWithFunction`. */
export function kindsWithEditableAnchors(): ElementKind[] {
  return (Object.keys(KIND_REGISTRY) as ElementKind[]).filter((k) => {
    const c = KIND_REGISTRY[k];
    return c.requiredAnchors.length > 0 || c.optionalAnchors.length > 0;
  });
}

export function getKindContract(kind: ElementKind | null | undefined): KindContract | null {
  if (!kind) return null;
  return KIND_REGISTRY[kind] ?? null;
}
