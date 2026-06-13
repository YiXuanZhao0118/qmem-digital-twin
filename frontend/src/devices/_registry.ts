/**
 * Device registry barrel — collects every `devices/<slug>.ts` into one
 * tuple and derives the lookup tables. Adding an instrument = create the
 * file + add one import line here. Nothing else in the codebase changes
 * (plan §1 "加儀器=加一檔").
 */
import type { Device } from "./_device";
import { ad9959 } from "./ad9959";
import { horn_wr90 } from "./horn_wr90";
import { ppg_sma } from "./ppg_sma";
import { rg316_sma } from "./rg316_sma";
import { zhl_1_2w } from "./zhl_1_2w";
import { zyswa_2_50dr } from "./zyswa_2_50dr";

/** All registered devices. Order is display order in the PHY Editor picker. */
export const DEVICES = [
  ad9959,
  zhl_1_2w,
  zyswa_2_50dr,
  rg316_sma,
  ppg_sma,
  horn_wr90,
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
