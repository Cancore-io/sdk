import { Agent, setGlobalDispatcher } from 'undici';
import undiciPackage from 'undici/package.json' with { type: 'json' };

// Runs inside each daemon's bundled installer chunk; undici stays external, so it resolves from that daemon's own node_modules (CAN-3344).
// The npm undici Agent (>= 8.12.3) already carries the dead-h2 fix (undici#6073); Node's bundled copy only runs fetch's front half.
// shortcut: h2 disabled globally, re-enable per origin after a load test of h2 on the installed npm undici (>= 8.12.3).
export function installHttp1GlobalDispatcher(logPrefix: string): void {
  setGlobalDispatcher(new Agent({ allowH2: false }));
  process.stderr.write(`${logPrefix}: global fetch pinned to HTTP/1.1 (npm undici ${undiciPackage.version}, node undici ${process.versions.undici})\n`);
}
