import { defineConfig } from 'tsup';
import { cleanExceptBins, daemonBinConfig } from '../../scripts/tsup-http1-installer';

const BINS = { daemon: 'src/daemon.ts', cli: 'src/cli.ts' };

/**
 * Named entries keep the subpath layout (`dist/protocol/index.js`). The
 * protocol and ipc/client entries are built on their own so a client of the socket (bot-mcp) never
 * pulls keystore or signer code: `protocol-isolation.test.ts` checks the output.
 */
export default defineConfig([{
  entry: {
    index: 'src/index.ts',
    'protocol/index': 'src/protocol/index.ts',
    'ipc/client': 'src/ipc/client.ts',
  },
  format: ['esm'],
  dts: { entry: { index: 'src/index.ts', 'protocol/index': 'src/protocol/index.ts', 'ipc/client': 'src/ipc/client.ts' } },
  sourcemap: true,
  clean: cleanExceptBins(BINS),
  treeshake: true,
}, daemonBinConfig(BINS)]);
