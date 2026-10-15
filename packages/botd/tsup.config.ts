import { defineConfig } from 'tsup';

/**
 * Named entries keep the subpath layout (`dist/protocol/index.js`). The
 * protocol entry is built on its own so a client of the socket (bot-mcp) never
 * pulls keystore or signer code: `protocol-isolation.test.ts` checks the output.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'protocol/index': 'src/protocol/index.ts',
    daemon: 'src/daemon.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  dts: { entry: { index: 'src/index.ts', 'protocol/index': 'src/protocol/index.ts' } },
  sourcemap: true,
  clean: true,
  treeshake: true,
});
