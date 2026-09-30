import { defineConfig } from 'tsup';

/**
 * The library and the binary, ESM, like the rest of the SDK. Dependencies stay
 * external (tsup's default): the protocol schemas and hashing come from the
 * installed `@cancore/contracts`, so the mock and the taker under test read the
 * same copy.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  sourcemap: true,
  clean: true,
  treeshake: true,
});
