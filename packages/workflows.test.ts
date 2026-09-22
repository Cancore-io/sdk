import * as fs from 'fs';
import * as path from 'path';

/**
 * The CI definition is the artifact this repository ships to itself.
 *
 * Nothing in a test suite fails when a `concurrency` block is deleted, a
 * `permissions:` block quietly regains a write scope, or the one workflow that
 * carries a red run to Slack is removed in a merge conflict. The first person
 * to notice is whoever eventually wonders why nobody was told — which, for a
 * public repository publishing five npm packages, is a stranger.
 *
 * Deliberately blunt, in the same spirit as readme-symbols.test.ts: this reads
 * the workflow files as TEXT and checks that the decisions are written down. It
 * does not parse YAML (that would cost a dependency for five assertions) and it
 * proves nothing about what a runner does at runtime — the concurrency, token
 * and Slack behaviours are proven by real runs, on the PR and after the merge.
 * What this file guards is that the decisions cannot be undone silently.
 *
 * CAN-1645.
 */
const ROOT = path.join(__dirname, '..');
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');

/**
 * Every workflow, discovered — never a hand-written list, for the reason
 * readme-symbols.test.ts gives about packages: a literal passes for the files
 * someone remembered and says nothing about the one they did not.
 */
const workflowFiles = (): string[] =>
  fs
    .readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();

const read = (file: string) => fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');

const exists = (file: string) => fs.existsSync(path.join(WORKFLOW_DIR, file));

/** The line following a top-level key, e.g. the `group:` under `concurrency:`. */
const blockOf = (text: string, topLevelKey: string): string => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `${topLevelKey}:`);
  if (start === -1) return '';
  const end = lines.findIndex((l, i) => i > start && l !== '' && !l.startsWith(' ') && !l.startsWith('#'));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
};

/**
 * Job names and their bodies, without a YAML parser: a job header is a key
 * indented exactly two spaces with nothing after the colon, inside the `jobs:`
 * block. Blunt, and it is checked for vacuity by every caller — a file whose
 * jobs this fails to find must fail the test, not pass it for free.
 */
const jobsOf = (text: string): Array<{ name: string; body: string }> => {
  const lines = text.split('\n');
  const jobsAt = lines.findIndex((l) => l === 'jobs:');
  if (jobsAt === -1) return [];
  const out: Array<{ name: string; body: string }> = [];
  const headers: Array<{ name: string; at: number }> = [];
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const m = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(lines[i]);
    if (m) headers.push({ name: m[1], at: i });
  }
  headers.forEach((h, i) => {
    const end = i + 1 < headers.length ? headers[i + 1].at : lines.length;
    out.push({ name: h.name, body: lines.slice(h.at, end).join('\n') });
  });
  return out;
};

/** The workflow's own `name:` — what a `workflow_run` trigger matches on. */
const nameOf = (text: string): string => {
  const m = /^name:\s*(.+?)\s*$/m.exec(text);
  return m ? m[1].replace(/^['"]|['"]$/g, '') : '';
};

const NOTIFIER = 'github-events.yml';

// ---------------------------------------------------------------------------
// Group 1 — ci.yml cancels superseded PR runs, and never a run on main.
// ---------------------------------------------------------------------------
describe('group 1: ci.yml concurrency', () => {
  test('declares a top-level concurrency block', () => {
    expect(read('ci.yml')).toMatch(/^concurrency:/m);
  });

  test('groups by github.ref, so a PR run and a push run of one commit do not collide', () => {
    expect(blockOf(read('ci.yml'), 'concurrency')).toMatch(/group:.*github\.ref/);
  });

  // The reason this is not a bare `true`: a cancelled run has conclusion
  // `cancelled`, not `failure`, so the CI-failure notifier never fires for it.
  // Cancelling runs on main would silently swallow exactly the red-main signal
  // the notifier is being added for.
  test('excludes refs/heads/main from cancellation', () => {
    expect(blockOf(read('ci.yml'), 'concurrency')).toMatch(/cancel-in-progress:.*refs\/heads\/main/);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — ci.yml runs with a read-only token.
// ---------------------------------------------------------------------------
describe('group 2: ci.yml permissions', () => {
  test('declares a top-level permissions block', () => {
    expect(read('ci.yml')).toMatch(/^permissions:/m);
  });

  test('grants contents: read and no write scope anywhere in the file', () => {
    const text = read('ci.yml');
    expect(blockOf(text, 'permissions')).toMatch(/contents:\s*read/);
    const writes = text
      .split('\n')
      .filter((l) => /^\s*[a-z-]+:\s*write\s*(#.*)?$/.test(l));
    expect(writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Group 3 — a red run reaches #dev at all.
// ---------------------------------------------------------------------------
describe('group 3: the CI-failure notifier is wired', () => {
  test(`${NOTIFIER} exists`, () => {
    expect(exists(NOTIFIER)).toBe(true);
  });

  test('triggers on a completed workflow_run', () => {
    const text = exists(NOTIFIER) ? read(NOTIFIER) : '';
    expect(text).toMatch(/workflow_run:/);
    expect(text).toMatch(/types:\s*\[\s*completed\s*\]/);
  });

  // Pinned by commit, never by tag or branch: a mutable ref in a workflow that
  // holds SLACK_BOT_TOKEN is a supply-chain hole. renovate.json's
  // helpers:pinGitHubActionDigests keeps the pin current.
  test('pins Cancore-io/.github/actions/ci-failure-notify by a 40-character commit sha', () => {
    const text = exists(NOTIFIER) ? read(NOTIFIER) : '';
    expect(text).toMatch(/Cancore-io\/\.github\/actions\/ci-failure-notify@[0-9a-f]{40}\b/);
  });

  // Discovered from the files, not a literal: a workflow added later and left
  // out of the watch list is unmonitored, and a list cannot say so about itself.
  test('watches every other workflow in this repository by name', () => {
    const text = exists(NOTIFIER) ? read(NOTIFIER) : '';
    const others = workflowFiles().filter((f) => f !== NOTIFIER);
    expect(others.length).toBeGreaterThan(0);
    // `nameOf` reads the file's CONTENT, never its filename — a `workflow_run`
    // trigger matches on `name:`. Passing the filename here made this test pass
    // vacuously on every input (found by running the red, CAN-1645 G3), so the
    // names are asserted non-empty before they are used.
    const names = others.map((f) => nameOf(read(f)));
    expect(names.filter((n) => n === '')).toEqual([]);
    expect(names.filter((n) => !text.includes(n))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Group 4 — the sentinels: what must NOT change, and what must stay written.
// ---------------------------------------------------------------------------
describe('group 4: guarded invariants', () => {
  // Aborting a tag run mid-publish is worse than wasted runner minutes: the tag
  // is already pushed, the version is already fixed in the manifest, and a
  // half-run `npm publish` can leave the registry in a state no retry fixes.
  test('publish.yml never cancels itself', () => {
    expect(read('publish.yml')).not.toMatch(/cancel-in-progress/);
  });

  // CAN-1120 made cancore-runners the organization standard. sdk is the only
  // PUBLIC repository in the organization, and a self-hosted runner on a public
  // repository serves fork PRs. The exception is legitimate; an exception
  // nobody wrote down is not, and the next audit arrives with the same claim.
  test('every workflow runs on ubuntu-latest and says why (CAN-1120)', () => {
    const offenders = workflowFiles().filter((f) => {
      const text = read(f);
      return !/runs-on:\s*ubuntu-latest/.test(text) || !text.includes('CAN-1120');
    });
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Group 5 — no job can hang on the public runner.
// ---------------------------------------------------------------------------
describe('group 5: every job has a timeout', () => {
  test.each(workflowFiles())('%s: every job declares timeout-minutes', (file) => {
    const jobs = jobsOf(read(file));
    // Vacuity guard: a file whose jobs we failed to find must fail here rather
    // than pass an empty loop.
    expect(jobs.length).toBeGreaterThan(0);
    const untimed = jobs.filter((j) => !/^\s*timeout-minutes:\s*\d+/m.test(j.body)).map((j) => j.name);
    expect(untimed).toEqual([]);
  });
});
