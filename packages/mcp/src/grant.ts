import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where an approved grant lives between runs — the same file, format and mode
 * the Go server uses, so the two runtimes share one approval.
 *
 * ponytail: 0600 on the file is the whole protection — no keyring, no
 * encryption at rest. Ceiling: anything running as this user can read it, the
 * same as the ~/.aws or ~/.kube files next to it. Upgrade path if that stops
 * being acceptable is the OS keyring; the grant is revocable and expires either
 * way.
 */
export interface Grant {
  token: string;
  scopes: string[];
  appName: string;
  /** Unix seconds. */
  obtainedAt: number;
}

/** Keyed by API base URL: a dev grant must never overwrite a mainnet one. */
type GrantFile = Record<string, Grant>;

export function defaultGrantPath(): string {
  const home = homedir();
  if (!home) return join(tmpdir(), 'cancore-mcp-grants.json');
  return join(home, '.config', 'cancore-mcp', 'grants.json');
}

function readFile(path: string): GrantFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as GrantFile) : {};
  } catch {
    return {};
  }
}

export function loadGrant(path: string, baseUrl: string): Grant | undefined {
  const grant = readFile(path)[baseUrl];
  return grant?.token ? grant : undefined;
}

/** Record the grant for one stand, leaving the other stands' grants alone. */
export function saveGrant(path: string, baseUrl: string, grant: Omit<Grant, 'obtainedAt'>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const file = readFile(path);
  file[baseUrl] = { ...grant, obtainedAt: Math.floor(Date.now() / 1000) };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync only applies `mode` when it creates the file; an existing
  // file keeps whatever it had, which may be 0644 from an older writer.
  chmodSync(path, 0o600);
}

export function forgetGrant(path: string, baseUrl: string): void {
  const file = readFile(path);
  if (!(baseUrl in file)) return;
  delete file[baseUrl];
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
