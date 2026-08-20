/** "Is anything actually using this row?" filter for the KINDS list.
 *
 *  Sibling of `lockFilter.ts` — same three-option dropdown shape, same
 *  view-only contract: it never writes a row, it only decides what the list
 *  shows.
 *
 *  Why it exists: the `kinds` table is a catalog of what the twin *can*
 *  model, not of what is on the table right now, so 12 of its 37 rows have
 *  no Asset3D pointing at them (`camera`, `detector`, `spectrometer`, …).
 *  Those rows are NOT dead — every one has a physics plugin and a
 *  registered anchor op, and deleting them would make the kind unpickable
 *  in the Asset3D editor's dropdown (exactly the state alembic 0126 had to
 *  repair for `fiber` / `fiber_coupler` / `glan_polarizer` / `rf_cable`).
 *  So the answer to "the list is long" is a filter, never a delete.
 */
export type UsageFilter = "all" | "used" | "unused";

export const USAGE_FILTER_OPTIONS: ReadonlyArray<{ value: UsageFilter; label: string }> = [
  { value: "all", label: "assets: all" },
  { value: "used", label: "assets: ✓ has assets" },
  { value: "unused", label: "assets: ∅ none yet" },
];

export function matchesUsageFilter(assetCount: number, filter: UsageFilter): boolean {
  if (filter === "all") return true;
  return filter === "used" ? assetCount > 0 : assetCount === 0;
}
