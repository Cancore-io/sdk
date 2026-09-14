import { defineConfig } from 'tsup';

/** Data only: three entries, ESM, types. Nothing to bundle but constants. */
export default defineConfig({
  entry: ['src/index.ts', 'src/abi.ts', 'src/networks.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
