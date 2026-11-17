import { defineConfig } from 'tsup';

/** The library (bump rule + compat, no node imports) and the `cancore-release` binary. ESM only, like the rest of the SDK. */
export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  sourcemap: true,
  clean: true,
  treeshake: true,
});
