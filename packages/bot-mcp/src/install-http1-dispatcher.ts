import { Agent, setGlobalDispatcher } from 'undici';
import undiciPackage from 'undici/package.json' with { type: 'json' };

// The npm undici Agent (>= 8.12.3) already carries the dead-h2 fix (undici#6073); Node's bundled copy only runs fetch's front half.
// shortcut: h2 disabled globally, re-enable per origin after a load test of h2 on the installed npm undici (>= 8.12.3).
setGlobalDispatcher(new Agent({ allowH2: false }));
process.stderr.write(`cancore-bot-mcp: global fetch pinned to HTTP/1.1 (npm undici ${undiciPackage.version}, node undici ${process.versions.undici})\n`);
