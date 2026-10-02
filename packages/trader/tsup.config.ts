import { defineConfig } from 'tsup';

/**
 * One entry per published subpath, named so the output keeps the subpath
 * layout (`dist/filler/index.js`, `dist/filler/testing/index.js`) — a plain
 * entry list would collapse the common `src/filler` prefix away. ESM only,
 * like the rest of the SDK. Dependencies stay external (tsup's default).
 */
export default defineConfig({
  entry: {
    'filler/index': 'src/filler/index.ts',
    'filler/testing/index': 'src/filler/testing/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
