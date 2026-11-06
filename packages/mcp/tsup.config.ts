import { defineConfig } from 'tsup';
import { cleanExceptBins, daemonBinConfig } from '../../scripts/tsup-http1-installer';

const BINS = { bin: 'src/bin.ts' };

/**
 * Two entries: the library (`.`) and the binary. ESM only, like the rest of the
 * SDK — this runs on Node 20+, which needs no CommonJS.
 *
 * The MCP SDK and zod stay external (tsup's default for `dependencies`):
 * bundling a protocol implementation would pin consumers to our copy of it.
 */
export default defineConfig([{
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: cleanExceptBins(BINS),
  treeshake: true,
}, daemonBinConfig(BINS)]);
