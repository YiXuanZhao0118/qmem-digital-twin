/** Shared light-theme palette for the Three.js viewports.
 *
 * The CSS chrome reads its colours from `:root` design tokens in styles.css,
 * but Three.js scenes need literal hex values — so the few colours that make
 * the 3D viewports "light" live here, in one place, to keep the four scenes
 * (main viewer, optical-link viewer, Asset3D preview, Component-binding
 * preview) consistent and easy to re-tune.
 */

/** Scene background + fog for every display mode — matches the app shell bg
 *  (#eef1ef). The X-ray mode keeps this light backdrop too: it fades the
 *  bodies rather than swapping the room out for a dark void. */
export const VIEWER_BG_LIGHT = "#eef1ef";

/** Reference-grid minor lines — muted grey, slightly darker than the bg so
 *  they're visible without dominating the wavelength-coloured beams. */
export const VIEWER_GRID_LINE = "#cdd2cd";

/** Reference-grid centre / axis lines — a touch darker than the minor lines. */
export const VIEWER_GRID_CENTER = "#b9beb9";

/** PHY-Editor template grid — black lines for the Geometry Builder + Asset3D
 *  previews, where a crisp reference grid is wanted on the light backdrop.
 *  Kept separate from VIEWER_GRID_* (muted grey) so the optical-link viewer's
 *  grid stays subordinate to its wavelength-coloured beams. */
export const VIEWER_GRID_BLACK = "#000000";

/** Hemisphere-light "ground" term for the embedded model previews — light so
 *  the under-fill doesn't tint the model dark on the new light background. */
export const VIEWER_GROUND_FILL = "#c8ccc8";
