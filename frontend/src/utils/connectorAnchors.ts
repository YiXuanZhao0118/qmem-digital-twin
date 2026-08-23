/**
 * Where a cable-end connector's two geometric anchors are, whichever spelling
 * the asset uses.
 *
 * A connector asset (fibre or coax) owns exactly two anchors:
 *
 *   - the **mating face** — the ferrule / pin end at `+tipMm` on +X that goes
 *     into a socket. The cable-level optical port derives from it, and on a
 *     fibre connector it carries the MALE connector type.
 *   - the **cable root** — the spline junction at the origin on −X, inside the
 *     jacket, where the endpoint node pins.
 *
 * Two spellings are live, and both must be accepted:
 *
 *   | | mating face | cable root |
 *   |---|---|---|
 *   | fibre (alembic 0135) | `fiber_out`  | `fiber_root`  |
 *   | coax                 | `connect_in` | `connect_out` |
 *
 * The fibre pair was renamed on 2026-08-23 so the whole fibre vocabulary reads
 * from the FIBRE's point of view rather than three unrelated conventions:
 * `fiber_root` is where the fibre is anchored into the cable, `fiber_out`
 * where it comes out of its own connector, `fiber_in` where it goes into an
 * instrument. Coax deliberately kept `connect_*` — a `fiber_*` id would be a
 * lie on an SMA, and forking the shared code was judged worse than accepting
 * both spellings in one lookup.
 *
 * **Neither is a hit-testable anchor.** `anchor_tracer.PRIMARY_ANCHOR_IDS`
 * contains `fiber_in` and no other fibre id: the connector is passthrough, and
 * the traced coupling happens on the SYNTHESIZED `intercept_in/out` that
 * `db_scene_loader._synth_fiber_slot` derives from the mating face. Making the
 * mating face primary would put two hit-testable anchors at the same point.
 *
 * Read these names as "where the fibre is", NOT "which way the light goes" —
 * both ends of a patch cable use the same connector asset, so one end's
 * `fiber_out` emits and the other's receives. Direction is carried by axisX.
 */

/** Mating-face ids, most-preferred first. */
export const MATING_FACE_ANCHOR_IDS = ["fiber_out", "connect_in"] as const;

/** Cable-root ids, most-preferred first. */
export const CABLE_ROOT_ANCHOR_IDS = ["fiber_root", "connect_out"] as const;

function findByIds<T extends { id?: string }>(
  anchors: readonly T[] | null | undefined,
  ids: readonly string[],
): T | undefined {
  // Ordered by id, not by array position: an asset mid-migration could carry
  // both, and the fibre spelling is the one to honour.
  for (const wanted of ids) {
    const hit = (anchors ?? []).find((a) => a?.id === wanted);
    if (hit) return hit;
  }
  return undefined;
}

/** The ferrule / pin end face that mates into a socket. */
export function findMatingFaceAnchor<T extends { id?: string }>(
  anchors: readonly T[] | null | undefined,
): T | undefined {
  return findByIds(anchors, MATING_FACE_ANCHOR_IDS);
}

/** The spline junction inside the jacket, where the endpoint node pins. */
export function findCableRootAnchor<T extends { id?: string }>(
  anchors: readonly T[] | null | undefined,
): T | undefined {
  return findByIds(anchors, CABLE_ROOT_ANCHOR_IDS);
}
