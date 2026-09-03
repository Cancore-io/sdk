import { defineConfig } from 'tsup';

/**
 * One entry, ESM only, types emitted.
 *
 * ESM only because the package's whole transport is `fetch`, `EventSource` and
 * `postMessage` — a runtime old enough to need CommonJS does not have them, so a
 * CJS build would be a build nobody can use pretending otherwise.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
