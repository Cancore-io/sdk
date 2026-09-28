import { defineConfig } from 'tsup';

/**
 * Six entries, ESM only, types emitted. The transport is `fetch` and, for
 * `./realtime`, a Socket.IO socket — both injected. Like the connector, a
 * runtime old enough to need CommonJS has no fetch to offer this package.
 *
 * `./selfcustody` is the one entry with a dependency: `@cancore/wallet`, a peer,
 * for how a prepared leg is signed. tsup leaves peers external, so it is
 * imported, not bundled — the signing rules have one copy.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/swap.ts', 'src/bridge.ts', 'src/realtime.ts', 'src/auth.ts', 'src/selfcustody.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
