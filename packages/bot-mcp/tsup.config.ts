import { defineConfig } from 'tsup';

/** The library (`.`) and the binary. ESM only; dependencies stay external. */
export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  sourcemap: true,
  clean: true,
  treeshake: true,
});
