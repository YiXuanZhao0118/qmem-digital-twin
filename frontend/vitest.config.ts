import { configDefaults, defineConfig } from "vitest/config";

/**
 * Vitest config, kept separate from `vite.config.ts` on purpose.
 *
 * Vitest ships a nested copy of vite, so calling its `defineConfig` in
 * `vite.config.ts` makes the react plugin's `Plugin` type stop unifying
 * (tsc TS2769), and vitest 2.x no longer augments vite's `UserConfig`, so a
 * `/// <reference types="vitest" />` in that file does not type-check either.
 * A standalone file avoids both: no plugins here, no type clash.
 *
 * Vitest prefers this file over `vite.config.ts` and does not merge the two.
 * That is fine for this suite — the tests run in the node environment and do
 * not render React, so the react plugin and the react `resolve.dedupe` are
 * not needed. Files that DO need a DOM opt in per-file with
 * `// @vitest-environment happy-dom`.
 */
export default defineConfig({
  test: {
    // Playwright owns `e2e/` (`npm run test:e2e`). Vitest's default include
    // matches `*.spec.ts`, so without this it also collects those specs and
    // they fail at import — `test.describe()` outside a Playwright runner.
    // They contribute 0 tests, so the failure only ever showed up in the
    // FILE count, which is why it went unnoticed for so long.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
