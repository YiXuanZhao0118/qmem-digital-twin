/**
 * Device registry barrel — collects every `devices/<slug>.ts` into one
 * tuple and derives the lookup tables. Adding an instrument = create the
 * file + add one import line here. Nothing else in the codebase changes
 * (plan §1: "adding an instrument = adding one file").
 */
import type { Device } from "./_device";
import { a230tm_b } from "./a230tm_b";
import { aa_mt80_a1_5 } from "./aa_mt80_a1_5";
import { ad9959 } from "./ad9959";
import { bb1_e03 } from "./bb1_e03";
import { bnc_female } from "./bnc_female";
import { bnc_male } from "./bnc_male";
import { dbr_tosa } from "./dbr_tosa";
import { dg4202 } from "./dg4202";
import { glan_io3_850 } from "./glan_io3_850";
import { glan_io5_850 } from "./glan_io5_850";
import { horn_wr90 } from "./horn_wr90";
import { io5_850_back } from "./io5_850_back";
import { io5_850_faraday } from "./io5_850_faraday";
import { io5_850_front } from "./io5_850_front";
import { la1509_b } from "./la1509_b";
import { lj1960l1_b } from "./lj1960l1_b";
import { mm_pc_780 } from "./mm_pc_780";
import { pbs252 } from "./pbs252";
import { pm_apc_780 } from "./pm_apc_780";
import { pm_pc_780 } from "./pm_pc_780";
import { ppg_sma } from "./ppg_sma";
import { rg316_sma } from "./rg316_sma";
import { sm_apc_780 } from "./sm_apc_780";
import { sm_pc_780 } from "./sm_pc_780";
import { sma_female } from "./sma_female";
import { sma_male } from "./sma_male";
import { toptica_boosta_pro } from "./toptica_boosta_pro";
import { tornos_faraday } from "./tornos_faraday";
import { zhl_1_2w } from "./zhl_1_2w";
import { zyswa_2_50dr } from "./zyswa_2_50dr";

/** All registered devices. Order is display order in the PHY Editor picker. */
export const DEVICES = [
  // RF
  ad9959,
  dg4202,
  zhl_1_2w,
  zyswa_2_50dr,
  rg316_sma,
  ppg_sma,
  horn_wr90,
  // RF / coax connectors (one device per gendered catalog asset)
  sma_male,
  sma_female,
  bnc_male,
  bnc_female,
  // Optical — mirrors / lenses
  bb1_e03,
  la1509_b,
  a230tm_b,
  lj1960l1_b,
  // Optical — polarisers / beam splitters (explicit axisY frames)
  glan_io3_850,
  glan_io5_850,
  pbs252,
  // Optical — isolator chain (Faraday rod + housing pieces)
  io5_850_faraday,
  io5_850_front,
  io5_850_back,
  tornos_faraday,
  // Optical — sources / amplifiers / modulators
  dbr_tosa,
  toptica_boosta_pro,
  aa_mt80_a1_5,
  // Optical — fibre connectors
  sm_pc_780,
  sm_apc_780,
  pm_pc_780,
  pm_apc_780,
  mm_pc_780,
] as const satisfies readonly Device[];

const DEVICE_BY_ID: Record<string, Device> = Object.fromEntries(
  DEVICES.map((d) => [d.id, d]),
);

/** Resolve a device by its `id` (the value stored in `Asset3D.device_id`).
 *  Returns null for an unknown id. */
export function deviceById(id: string | null | undefined): Device | null {
  if (!id) return null;
  return DEVICE_BY_ID[id] ?? null;
}

/** Devices that materialise a given behavioral kind — the PHY Editor lists
 *  these when an asset's kind is fixed and the user picks a concrete part. */
export function devicesForBehavioralKind(kind: string): readonly Device[] {
  return DEVICES.filter((d) => d.behavioralKind === kind);
}
