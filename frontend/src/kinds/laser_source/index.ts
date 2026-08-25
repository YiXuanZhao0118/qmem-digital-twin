import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  type RolesMap,
} from "../_plugin";

const C_M_PER_S = 299_792_458;

function nmToThz(nm: number): number {
  return C_M_PER_S / (nm * 1e-9) / 1e12;
}

interface SpectrumComponent {
  kind: string;
  lineshape: string;
  offsetMhz: number;
  fwhmMhz: number;
  amplitude: number;
}

interface Spectrum {
  centerThz: number;
  components: SpectrumComponent[];
}

interface GaussianMode {
  waistUm: number;
  waistZOffsetMm: number;
  mSquared: number;
}

interface JonesVector {
  exRe: number;
  exIm: number;
  eyRe: number;
  eyIm: number;
}

export interface LaserSourceParams extends Record<string, unknown> {
  centerWavelengthNm: number;
  spectrum: Spectrum;
  spatialModeX: GaussianMode;
  spatialModeY: GaussianMode;
  // Legacy decorative label — optional, no longer in the kind default
  // (superseded by transverseModeType below). Readers fall back to TEM00.
  transverseMode?: { kind: string };
  // Transverse-mode control (decoupled from the decorative `transverseMode`
  // label). The emitter folds these into the per-axis beam-width multiplier
  // (LG: √(2p+|l|+1) both axes; HG: x=√(2m+1), y=√(2n+1)). 0/0 = TEM00.
  transverseModeType: "HG" | "LG";
  mode_index_1: number; // HG m (X order) / LG p (radial)
  mode_index_2: number; // HG n (Y order) / LG l (azimuthal topological charge)
  polarization: JonesVector;
  nominalPowerMw: number;
}

const LASER_SOURCE_ROLES: RolesMap = {
  out: { min: 0, domain: "optical", fastAxis: true },
  intercept_out: { min: 0, domain: "optical", fastAxis: true },
  // The fibre BULKHEAD, for a fibre-coupled source: a female receptacle on
  // the chassis (`connectorType: "fc_pc_female"` / `"fc_apc_female"`) that a
  // patch cable's male ferrule mates into. Same role the `detector` kind
  // gained in alembic 0133, and read the same way — the fibre vocabulary is
  // named for where the FIBRE is, not which way light goes, so the socket on
  // an EMITTER is still `fiber_in`. `min: 0`: the free-space build (a bare
  // TOSA facet) has no socket at all.
  //
  // A fibre-coupled source carries this AND an `intercept_out` at the same
  // point: `emit_anchor_source_rays` (backend
  // `anchor_ops/emit_laser_source.py`) spawns its seed ray only from
  // `intercept_out`, so a build with the bulkhead alone would emit nothing.
  // The two being coincident is safe — a ray starting exactly on its own
  // slot's `fiber_in` plane gives t = 0, below `intersect_anchor`'s
  // `t_min = 1e-9`, so the emitter cannot hit its own socket.
  //
  // Direction is the PROPAGATION direction (out of the body, into the mating
  // ferrule), per anchors.md. Aperture is the ferrule bore, not the emitting
  // core: it only decides what counts as a hit, and a core-sized one would be
  // unhittable by anything but a perfectly placed fibre.
  fiber_in: { min: 0, domain: "optical", aperture: true, direction: true },
};

export const laserSourcePlugin = definePhysicsPlugin<LaserSourceParams>({
  id: "laser_source",
  displayName: "Laser Source",
  componentTypes: ["laser_source", "laser"],
  assetCategory: "optical",
  catalogGroup: "Emitters",
  physics: {
    elementKind: "laser_source",
    primaryDomain: "optical",
    defaultPhysics: ["optical", "thermal"],
    roles: LASER_SOURCE_ROLES,
    anchors: anchorContractFromRoles(LASER_SOURCE_ROLES),
    alignVariant: "none",
    alignToleranceMm: 0,
    alignSummary: "Emitter — beam originates here. Not aligned to anything.",
    defaultParams: {
      centerWavelengthNm: 852.347,
      spectrum: {
        centerThz: nmToThz(852.347),
        components: [
          { kind: "main", lineshape: "lorentzian", offsetMhz: 0, fwhmMhz: 0.1, amplitude: 1.0 },
        ],
      },
      spatialModeX: { waistUm: 2.2, waistZOffsetMm: 0.0, mSquared: 1.15 },
      spatialModeY: { waistUm: 0.52, waistZOffsetMm: 0.006, mSquared: 1.08 },
      transverseModeType: "HG",
      mode_index_1: 0,
      mode_index_2: 0,
      polarization: { exRe: 1.0, exIm: 0.0, eyRe: 0.0, eyIm: 0.0 },
      nominalPowerMw: 50.0,
    },
    // Seeds the default per-instance-tunable set for laser assets (power +
    // wavelength are the operating knobs an experiment actually turns). The
    // asset author can widen this in the Asset editor; everything else
    // (spectrum / spatial mode / polarization) stays asset-defined.
    stateParamKeys: ["nominalPowerMw", "centerWavelengthNm"],
  },
});
