import { defineConfig } from 'tsup';

/**
 * Five entries, ESM only, types emitted, no runtime dependencies at all: the
 * transport is `fetch` and, for `./realtime`, a Socket.IO socket — both
 * injected. Like the connector, a runtime old enough to need CommonJS has no
 * fetch to offer this package.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/swap.ts', 'src/bridge.ts', 'src/realtime.ts', 'src/auth.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
