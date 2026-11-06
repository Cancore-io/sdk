import { defineConfig } from 'tsup';
import { cleanExceptBins, daemonBinConfig } from '../../scripts/tsup-http1-installer';

const BINS = { bin: 'src/bin.ts' };

/** The library (`.`) and the binary. ESM only; dependencies stay external. */
export default defineConfig([{
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  sourcemap: true,
  clean: cleanExceptBins(BINS),
  treeshake: true,
}, daemonBinConfig(BINS)]);
