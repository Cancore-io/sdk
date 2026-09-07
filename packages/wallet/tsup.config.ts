import { defineConfig } from 'tsup';

/**
 * Three entries, ESM only, types emitted, runtime dependencies left external.
 *
 * `./web` is its own entry rather than a re-export from the core because that
 * split IS the package's contract: folding web into `index` would put
 * `indexedDB` and `navigator.credentials` inside the file a CLI or an MCP
 * server imports (CAN-612). One entry per allowed runtime, and the split is
 * enforced by the jest project that runs the core in plain node — a browser
 * global that crept into it throws there.
 *
 * ESM only, like `@cancore/dapp-connector`: the core is WebCrypto plus
 * @noble/@scure, and a runtime old enough to need CommonJS has no
 * `crypto.subtle` to offer it.
 *
 * @noble/@scure stay external (tsup's default for `dependencies`): bundling a
 * crypto library into a wallet would pin consumers to our copy and cut them off
 * from its security updates.
 */
export default defineConfig({
  // Without a tsconfig the dts step falls back to TypeScript's defaults
  // (classic resolution) and cannot find `@noble/curves/ed25519`, whose types
  // live behind package `exports`.
  tsconfig: './tsconfig.json',
  entry: ['src/index.ts', 'src/operations.ts', 'src/web/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
