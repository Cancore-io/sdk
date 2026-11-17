// Browser-safe on purpose (no imports beyond ./bump, which has none): the frontend bundles it for its banner.
import { parseVersion } from './bump';

export type NeighbourCheck = { neighbour: string; required: string; actual: string | null; ok: boolean };

export type VersionDocInput = {
  component: string;
  service?: string;
  version: string;
  gitSha: string;
  channel: string;
  builtAt?: string;
  requires?: Record<string, string>;
  compat?: NeighbourCheck[];
};

export type VersionDoc = {
  component: string;
  service?: string;
  version: string;
  gitSha: string;
  channel: string;
  builtAt?: string;
  requires: Record<string, string>;
  compat?: NeighbourCheck[];
};

type Triple = [number, number, number];

// shortcut: only `>=X.Y.Z` and `>=X.Y.Z <A.B.C`, the subset CAEF compat-check.ts evaluates; add ^/~/|| if a repo needs one.
const RANGE_RE = /^>=(\d+\.\d+\.\d+)(?: <(\d+\.\d+\.\d+))?$/;
// D6: the match is on the version core, so `1.5.0-dev.3` counts as 1.5.0.
const CORE_RE = /^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?$/;

const compare = (a: Triple, b: Triple): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function parseRange(range: string): { min: Triple; below: Triple | null } {
  const m = RANGE_RE.exec(range.trim());
  if (!m?.[1]) throw new Error(`invalid range "${range}": expected ">=X.Y.Z" or ">=X.Y.Z <A.B.C"`);
  return { min: parseVersion(m[1]), below: m[2] ? parseVersion(m[2]) : null };
}

function parseCore(version: string): Triple {
  const m = CORE_RE.exec(version.trim());
  if (!m?.[1]) throw new Error(`invalid version "${version}": expected X.Y.Z with an optional -prerelease`);
  return parseVersion(m[1]);
}

export function satisfies(version: string, range: string): boolean {
  const { min, below } = parseRange(range);
  const core = parseCore(version);
  return compare(core, min) >= 0 && (below === null || compare(core, below) < 0);
}

// I4: a check warns, never blocks, so whatever a neighbour answered is a verdict, not an exception.
function isSatisfied(actual: string | null, required: string): boolean {
  if (actual === null) return false;
  try {
    return satisfies(actual, required);
  } catch {
    return false;
  }
}

const check = (neighbour: string, required: string, actual: string | null): NeighbourCheck => ({
  neighbour,
  required,
  actual,
  ok: isSatisfied(actual, required),
});

export function checkNeighbours(requires: Record<string, string>, actuals: Record<string, string | null>): NeighbourCheck[] {
  return Object.entries(requires).map(([neighbour, required]) => check(neighbour, required, actuals[neighbour] ?? null));
}

/** The lowest valid version among several instances of one neighbour (e.g. N attestors): the weakest one decides. */
export function lowestVersion(versions: Array<string | null>): string | null {
  let lowest: { version: string; core: Triple } | null = null;
  for (const version of versions) {
    if (version === null || !CORE_RE.test(version.trim())) continue;
    const core = parseCore(version);
    if (!lowest || compare(core, lowest.core) < 0) lowest = { version, core };
  }
  return lowest?.version ?? null;
}

/** I5: built field by field, so nothing the caller carries (an RPC URL, a secret) reaches the public document. */
export function versionDoc(input: VersionDocInput): VersionDoc {
  const doc: VersionDoc = {
    component: input.component,
    version: input.version,
    gitSha: input.gitSha,
    channel: input.channel,
    requires: { ...(input.requires ?? {}) },
  };
  if (input.service !== undefined) doc.service = input.service;
  if (input.builtAt !== undefined) doc.builtAt = input.builtAt;
  if (input.compat) doc.compat = input.compat.map((c) => ({ neighbour: c.neighbour, required: c.required, actual: c.actual, ok: c.ok }));
  return doc;
}
