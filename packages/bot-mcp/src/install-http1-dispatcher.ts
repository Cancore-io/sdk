import { Agent, setGlobalDispatcher } from 'undici';

// Node 26.13 bundles undici 8.12.2, whose dead h2 sessions hang fetch (undici#6073).
// shortcut: h2 disabled globally, re-enable per origin once Node bundles undici >= 8.12.3 and load-tested.
export function installHttp1GlobalDispatcher(): void {
  setGlobalDispatcher(new Agent({ allowH2: false }));
  process.stderr.write(`cancore-bot-mcp: global fetch pinned to HTTP/1.1 (undici ${process.versions.undici})\n`);
}

installHttp1GlobalDispatcher();
