import { defineConfig } from 'tsup';

/**
 * Two entries: the library (`.`) and the binary. ESM only, like the rest of the
 * SDK — this runs on Node 20+, which needs no CommonJS.
 *
 * The MCP SDK and zod stay external (tsup's default for `dependencies`):
 * bundling a protocol implementation would pin consumers to our copy of it.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
