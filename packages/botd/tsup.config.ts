import { defineConfig } from 'tsup';

/**
 * Named entries keep the subpath layout (`dist/protocol/index.js`). The
 * protocol and ipc/client entries are built on their own so a client of the socket (bot-mcp) never
 * pulls keystore or signer code: `protocol-isolation.test.ts` checks the output.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'protocol/index': 'src/protocol/index.ts',
    'ipc/client': 'src/ipc/client.ts',
    daemon: 'src/daemon.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  dts: { entry: { index: 'src/index.ts', 'protocol/index': 'src/protocol/index.ts', 'ipc/client': 'src/ipc/client.ts' } },
  sourcemap: true,
  clean: true,
  treeshake: true,
});
