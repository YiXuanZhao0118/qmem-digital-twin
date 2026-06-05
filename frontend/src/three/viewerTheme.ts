/** Shared light-theme palette for the Three.js viewports.
 *
 * The CSS chrome reads its colours from `:root` design tokens in styles.css,
 * but Three.js scenes need literal hex values — so the few colours that make
 * the 3D viewports "light" live here, in one place, to keep the four scenes
 * (main viewer, optical-link viewer, Asset3D preview, Component-binding
 * preview) consistent and easy to re-tune.
 *
 * The ONE exception is the `wireframe` display mode, which intentionally keeps
 * a dark backdrop so the slate wireframe lines read clearly — that value lives
 * here too (VIEWER_BG_WIRE) so the light/dark split is documented in one spot.
 */

/** Non-wireframe scene background + fog — matches the app shell bg (#eef1ef). */
export const VIEWER_BG_LIGHT = "#eef1ef";

/** Wireframe display mode keeps its dark backdrop (unchanged). */
export const VIEWER_BG_WIRE = "#0b1120";

/** Reference-grid minor lines — muted grey, slightly darker than the bg so
 *  they're visible without dominating the wavelength-coloured beams. */
export const VIEWER_GRID_LINE = "#cdd2cd";

/** Reference-grid centre / axis lines — a touch darker than the minor lines. */
export const VIEWER_GRID_CENTER = "#b9beb9";

/** Hemisphere-light "ground" term for the embedded model previews — light so
 *  the under-fill doesn't tint the model dark on the new light background. */
export const VIEWER_GROUND_FILL = "#c8ccc8";
