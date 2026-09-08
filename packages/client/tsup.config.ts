import { defineConfig } from 'tsup';

/**
 * Three entries, ESM only, types emitted, no runtime dependencies at all: the
 * transport is `fetch`, injected. Like the connector, a runtime old enough to
 * need CommonJS has no fetch to offer this package.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/swap.ts', 'src/bridge.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
