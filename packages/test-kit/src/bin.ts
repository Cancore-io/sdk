#!/usr/bin/env node
/**
 * `cancore-test-kit mock-gateway [options]` — starts the mock and prints one
 * JSON line `{"event":"ready","url","http","control"}` on stdout; SIGTERM or
 * SIGINT stops it. Logs, if any, go to stderr.
 */
import { parseArgs } from 'node:util';
import { DEFAULT_FILLERS, startMockGateway } from './index';
import type { FillerConfig, Hex, MockGatewayOptions } from './index';

const USAGE = `usage: cancore-test-kit mock-gateway [--host 127.0.0.1] [--port 8787] [--control 8788]
    [--clock frozen|real] [--clock-base <unix ms>] [--accept-by-ms 3000] [--issue-delay-ms 3000]
    [--heartbeat-ms 15000] [--heartbeat-misses 3] [--min-ticket-ttl-s 60]
    [--filler <fillerId>:<quoteKeyAddress>:<fillerAddress>]...
TEST ONLY: every key of the mock is public.`;

class UsageError extends Error {}

const NUMBERS: Record<string, keyof MockGatewayOptions> = {
  port: 'port',
  control: 'controlPort',
  'clock-base': 'clockBaseMs',
  'accept-by-ms': 'acceptByMs',
  'issue-delay-ms': 'issueDelayMs',
  'heartbeat-ms': 'heartbeatMs',
  'heartbeat-misses': 'heartbeatMisses',
  'min-ticket-ttl-s': 'minTicketTtlS',
};

function filler(spec: string): FillerConfig {
  const m = /^([a-z0-9][a-z0-9-]{0,62}):(0x[0-9a-fA-F]{40}):(0x[0-9a-fA-F]{40})$/.exec(spec);
  if (!m) throw new UsageError(`--filler ${spec}: expected <fillerId>:<quoteKeyAddress>:<fillerAddress>`);
  return { fillerId: m[1]!, quoteKey: m[2]!.toLowerCase() as Hex, fillerAddress: m[3]!.toLowerCase() as Hex };
}

function options(argv: string[]): MockGatewayOptions {
  const [command, ...rest] = argv;
  if (command !== 'mock-gateway') throw new UsageError(`unknown command ${command ?? '(none)'}`);
  const { values } = parseArgs({
    args: rest,
    options: {
      host: { type: 'string' },
      clock: { type: 'string' },
      filler: { type: 'string', multiple: true },
      ...Object.fromEntries(Object.keys(NUMBERS).map((k) => [k, { type: 'string' as const }])),
    },
  });
  const out: Record<string, unknown> = {};
  for (const [flag, key] of Object.entries(NUMBERS)) {
    const raw = values[flag as keyof typeof values];
    if (raw === undefined) continue;
    if (!/^\d+$/.test(String(raw))) throw new UsageError(`--${flag} ${String(raw)}: expected a non-negative integer`);
    out[key] = Number(raw);
  }
  if (values.clock !== undefined && values.clock !== 'frozen' && values.clock !== 'real') throw new UsageError('--clock: frozen or real');
  if (values.clock) out.clock = values.clock;
  if (values.host) out.host = values.host;
  const extra = (values.filler as string[] | undefined)?.map(filler) ?? [];
  if (extra.length) out.fillers = [...DEFAULT_FILLERS, ...extra];
  return out as MockGatewayOptions;
}

async function main() {
  let opts: MockGatewayOptions;
  try {
    opts = options(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${USAGE}\n`);
    process.exit(2);
  }
  const gw = await startMockGateway(opts);
  process.stdout.write(`${JSON.stringify({ event: 'ready', url: gw.url, http: gw.httpUrl, control: gw.controlUrl })}\n`);
  const stop = () => void gw.close().then(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

void main();
