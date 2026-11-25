// Port of CAEF scripts/agent-session/lib/ring-bump-signal.ts (CAN-3594): one bump rule for the harness and every
// Cancore repo. Differences on purpose: the trailer is `Release-Bump:` with `Ring-Bump:` still accepted (D5), and
// an invalid version throws /invalid/ so a caller can tell bad input from a bug.
export type BumpLevel = 'major' | 'minor' | 'patch';
export type BumpSignal = { level: BumpLevel; rationale: string; defaulted: boolean };

const TRAILER_RE = /^(?:release|ring)-bump:\s*(major|minor|patch)\s*$/im;
const TRAILER_LINE_RE = /^[a-z][\w-]*:\s+\S.*$/i;
const BREAKING_FOOTER_RE = /^breaking[ -]change:\s+\S/im;
// One deviation from CAEF: a `!` typed inside the scope (`feat(api!):`) is read as breaking too, not as a scope name.
const CONVENTIONAL_SUBJECT_RE = /^([a-z]+)(!)?(?:\([^)!\r\n]+(!)?\))?(!)?:\s+\S/i;
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const PATCH_TYPES = new Set(['fix', 'chore', 'docs', 'refactor', 'perf', 'test', 'ci', 'build', 'style', 'revert']);
const LEVEL_WEIGHT: Record<BumpLevel, number> = { major: 3, minor: 2, patch: 1 };

type Candidate = { level: BumpLevel; rationale: string };

const normalize = (text: string) => text.replace(/\r\n/g, '\n');
const subjectOf = (message: string) => (normalize(message).split('\n')[0] ?? '').trim();

export function parseBumpLevel(text: string): BumpLevel | null {
  const paragraphs = normalize(text).trimEnd().split(/\n[ \t]*\n/);
  const trailer = paragraphs.at(-1);
  if (paragraphs.length < 2 || !trailer) return null;
  const lines = trailer.split('\n');
  if (!lines.every((line) => TRAILER_LINE_RE.test(line) || /^[ \t]/.test(line))) return null;
  const m = lines.reverse().map((line) => TRAILER_RE.exec(line)).find(Boolean);
  return m?.[1] ? (m[1].toLowerCase() as BumpLevel) : null;
}

function stripLeadingEmoji(subject: string): string {
  let i = 0;
  while (i < subject.length && subject.charCodeAt(i) > 127) i++;
  while (i < subject.length && subject[i] === ' ') i++;
  return subject.slice(i);
}

export function parseConventionalBump(commitMessage: string): BumpLevel | null {
  if (BREAKING_FOOTER_RE.test(normalize(commitMessage))) return 'major';
  const m = CONVENTIONAL_SUBJECT_RE.exec(stripLeadingEmoji(subjectOf(commitMessage)));
  if (!m?.[1]) return null;
  if (m[2] || m[3] || m[4]) return 'major';
  const kind = m[1].toLowerCase();
  if (kind === 'feat') return 'minor';
  return PATCH_TYPES.has(kind) ? 'patch' : null;
}

/** The commit body without its subject and its trailer block: the "why" a release note quotes. */
export function extractRationale(commitMessage: string): string {
  const lines = normalize(commitMessage).split('\n');
  const blank = (i: number) => (lines[i] ?? '').trim() === '';
  let start = 1;
  while (start < lines.length && blank(start)) start++;
  let end = lines.length;
  while (end > start && (blank(end - 1) || TRAILER_LINE_RE.test(lines[end - 1] ?? ''))) end--;
  return lines.slice(start, end).join('\n').trim();
}

export function parseVersion(version: string): [number, number, number] {
  const m = VERSION_RE.exec(version.trim());
  if (!m) throw new Error(`invalid version "${version}": expected a plain X.Y.Z`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function bumpVersion(current: string, level: BumpLevel): string {
  const [major, minor, patch] = parseVersion(current);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const higher = (current: Candidate | null, next: Candidate): Candidate =>
  !current || LEVEL_WEIGHT[next.level] > LEVEL_WEIGHT[current.level] ? next : current;

function highest(commitMessages: string[], read: (message: string) => Candidate | null): Candidate | null {
  let best: Candidate | null = null;
  for (const message of commitMessages) {
    const candidate = read(message);
    if (candidate) best = higher(best, candidate);
  }
  return best;
}

const fromTrailer = (message: string): Candidate | null => {
  const level = parseBumpLevel(message);
  if (!level) return null;
  return { level, rationale: extractRationale(message) || `Release-Bump: ${level} declared with no rationale text alongside it.` };
};

const fromConvention = (message: string): Candidate | null => {
  const level = parseConventionalBump(message);
  return level ? { level, rationale: extractRationale(message) || subjectOf(message) } : null;
};

/** Trailer beats convention beats the PATCH default; within a tier the highest level over the range wins. */
export function resolveBumpSignal(commitMessages: string[]): BumpSignal {
  const decided = highest(commitMessages, fromTrailer) ?? highest(commitMessages, fromConvention);
  if (decided) return { ...decided, defaulted: false };
  return { level: 'patch', rationale: 'no bump level declared in the range, defaulted to PATCH', defaulted: true };
}
