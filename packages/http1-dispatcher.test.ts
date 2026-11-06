import { execFile } from 'child_process';
import * as fs from 'fs';
import * as http2 from 'http2';
import type { AddressInfo } from 'net';
import * as path from 'path';
import { promisify } from 'util';
import selfsigned from 'selfsigned';

/**
 * CAN-3344: Node 26 global fetch negotiates HTTP/2 and a dead h2 session hangs
 * (undici#6073), so every daemon binary pins the global dispatcher to HTTP/1.1
 * before anything else loads, and no library entry touches the host's dispatcher.
 * Probes run in child processes: jest sandboxes globalThis, so an in-process
 * fetch would not show the process-wide dispatcher.
 */
const run = promisify(execFile);
const PACKAGES = __dirname;
const HOOKS = path.join(PACKAGES, 'ts-source-hooks.mjs');
const DISPATCHER_SYMBOL = "Symbol.for('undici.globalDispatcher.2')";
const DAEMON_PACKAGES = ['botd', 'mcp', 'bot-mcp'];
const ENTRYPOINTS = ['botd/src/daemon.ts', 'botd/src/cli.ts', 'mcp/src/bin.ts', 'bot-mcp/src/bin.ts'];
const LIBRARY_ENTRIES = ['client/src/index.ts', 'botd/src/index.ts', 'mcp/src/index.ts', 'bot-mcp/src/index.ts'];
const installer = (pkg: string) => path.join(PACKAGES, pkg, 'src', 'install-http1-dispatcher.ts');

const runChild = (script: string) =>
  run(process.execPath, ['--import', HOOKS, '--input-type=module', '-e', script], {
    cwd: path.join(PACKAGES, '..'),
    env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_NO_WARNINGS: '1' },
    timeout: 30_000,
  });

describe('global fetch protocol in daemon processes', () => {
  let server: http2.Http2SecureServer;
  let url: string;

  beforeAll(async () => {
    const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 1, keySize: 2048 });
    server = http2.createSecureServer({ key: pems.private, cert: pems.cert, allowHTTP1: true }, (req, res) => res.end(req.httpVersion));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `https://localhost:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('negotiates HTTP/2 without the installer, so the probe can tell the protocols apart', async () => {
    const { stdout } = await runChild(`console.log(await (await fetch('${url}')).text())`);
    expect(stdout.trim()).toBe('2.0');
  });

  it.each(DAEMON_PACKAGES)('%s: importing the installer pins global fetch to HTTP/1.1 and logs the undici version', async (pkg) => {
    const { stdout, stderr } = await runChild(`await import(${JSON.stringify(installer(pkg))}); console.log(await (await fetch('${url}')).text())`);
    expect(stdout.trim()).toBe('1.1');
    expect(stderr).toContain(`undici ${process.versions.undici}`);
  });
});

describe('daemon entrypoints install the dispatcher first', () => {
  it.each(ENTRYPOINTS)('%s', (entry) => {
    const source = fs.readFileSync(path.join(PACKAGES, entry), 'utf8');
    const firstImport = /^import\s.*$/m.exec(source)?.[0];
    expect(firstImport).toBe("import './install-http1-dispatcher';");
  });
});

describe('library entries leave the host dispatcher alone', () => {
  it.each(LIBRARY_ENTRIES)('%s', async (entry) => {
    const { stdout } = await runChild(`await import(${JSON.stringify(path.join(PACKAGES, entry))}); console.log(String(globalThis[${DISPATCHER_SYMBOL}]))`);
    expect(stdout.trim()).toBe('undefined');
  });
});
