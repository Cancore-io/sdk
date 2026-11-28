import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

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
// Group 3 — the sentinels: what must NOT change, and what must stay written.
// ---------------------------------------------------------------------------
describe('group 3: guarded invariants', () => {
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
// Group 4 — no job can hang on the public runner.
// ---------------------------------------------------------------------------
describe('group 4: every job has a timeout', () => {
  test.each(workflowFiles())('%s: every job declares timeout-minutes', (file) => {
    const jobs = jobsOf(read(file));
    // Vacuity guard: a file whose jobs we failed to find must fail here rather
    // than pass an empty loop.
    expect(jobs.length).toBeGreaterThan(0);
    const untimed = jobs.filter((j) => !/^\s*timeout-minutes:\s*\d+/m.test(j.body)).map((j) => j.name);
    expect(untimed).toEqual([]);
  });
});

describe('BUG-1639 npm publication plan', () => {
  const { releaseOrder, checkDependencies, publishPackages } = require('../scripts/publish-plan.cjs');
  const wallet = { name: '@cancore/wallet', dir: 'wallet', version: '1.2.0', distTag: 'latest' };
  const client = { name: '@cancore/client', dir: 'client', version: '1.0.0-rc.1', distTag: 'rc' };

  test.each([
    ['dependencies', 'workspace:*', '1.2.0'],
    ['optionalDependencies', 'workspace:~', '~1.2.0'],
    ['peerDependencies', 'workspace:^', '^1.2.0'],
    ['dependencies', 'workspace:>=1.1.0 <2', '>=1.1.0 <2'],
    ['dependencies', '^1.2.0', '^1.2.0'],
  ])('orders an internal dependency in %s with %s', (field, spec, range) => {
    const consumer = { [field]: { [wallet.name]: spec, 'external-library': '^2' } };
    const manifests = new Map<string, object>([[wallet.name, wallet], [client.name, consumer]]);
    expect(releaseOrder([client, wallet], manifests)).toEqual([wallet, client]);
    const registry = jest.fn(() => wallet.version);
    expect(() => checkDependencies(consumer, manifests, registry)).not.toThrow();
    expect(registry.mock.calls).toEqual([[wallet.name + '@' + range]]);
  });

  test('accepts a registry version array and rejects empty results and E404', () => {
    const consumer = { dependencies: { [wallet.name]: '^1.2.0' } };
    const manifests = new Map([[wallet.name, wallet]]);
    expect(() => checkDependencies(consumer, manifests, () => ['1.2.0', '1.3.0'])).not.toThrow();
    expect(() => checkDependencies(consumer, manifests, () => [])).toThrow(/No published version/);
    expect(() => checkDependencies(consumer, manifests, () => '')).toThrow(/No published version/);
    const missing = new Error('npm E404');
    expect(() => checkDependencies(consumer, manifests, () => { throw missing; })).toThrow(missing);
  });

  test('refuses a cycle in the selected publish plan', () => {
    const manifests = new Map<string, object>([
      [wallet.name, { ...wallet, dependencies: { [client.name]: 'workspace:*' } }],
      [client.name, { ...client, peerDependencies: { [wallet.name]: 'workspace:^' } }],
    ]);
    expect(() => releaseOrder([client, wallet], manifests)).toThrow(/Circular workspace release dependencies/);
  });

  const mcp = { name: '@cancore/mcp', dir: 'mcp', version: '0.3.0', distTag: 'latest' };
  type Item = typeof wallet;
  const npmError = (code: string) => Object.assign(new Error('npm view failed'), { stderr: 'npm error code ' + code });
  const withSummary = (check: (env: Record<string, string>, summary: string) => void) => {
    const temp = fs.mkdtempSync(path.join(tmpdir(), 'sdk-publish-'));
    const summary = path.join(temp, 'summary');
    try {
      check({ GITHUB_STEP_SUMMARY: summary, GITHUB_SHA: 'head', GITHUB_REF_TYPE: 'branch' }, summary);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  };
  // A registry that knows only what this run published, plus scripted answers per `npm view` spec.
  const fakeRun = (items: Item[], answers: Record<string, string | Error> = {}, failPublish: Record<string, Error> = {}, remoteTags = '') => {
    const published = new Set<string>();
    return jest.fn((command: string, args: string[], options?: { cwd?: string }) => {
      if (command === 'npm') {
        const answer = answers[args[1]];
        if (answer instanceof Error) throw answer;
        if (answer !== undefined) return answer;
        if (published.has(args[1])) return JSON.stringify(args[1].slice(args[1].lastIndexOf('@') + 1));
        throw npmError('E404');
      }
      if (command === 'pnpm') {
        const item = items.find(({ dir }) => options?.cwd === path.join('packages', dir));
        if (!item) throw new Error('pnpm publish outside a package directory: ' + options?.cwd);
        if (failPublish[item.name]) throw failPublish[item.name];
        published.add(item.name + '@' + item.version);
      }
      return command === 'git' && args[0] === 'ls-remote' ? remoteTags : '';
    });
  };
  const gitCalls = (run: jest.Mock) => run.mock.calls.filter(([bin]) => bin === 'git').map(([, args]) => args);
  const tagged = (tag: string) => [['ls-remote', '--tags', 'origin', 'refs/tags/' + tag], ['tag', tag, 'head'], ['push', 'origin', 'refs/tags/' + tag]];

  test.each(['branch', 'tag', 'existing tag'])('publishes with the requested dist-tag and handles %s refs', (mode) => {
    withSummary((branchEnv, summary) => {
      const refType = mode === 'tag' ? 'tag' : 'branch';
      const env = { ...branchEnv, GITHUB_REF_TYPE: refType };
      const manifests = new Map<string, object>([
        [wallet.name, wallet],
        [client.name, { ...client, dependencies: { [wallet.name]: 'workspace:*' } }],
      ]);
      const run = fakeRun([wallet, client], {}, {}, mode === 'existing tag' ? 'head refs/tags/wallet-v1.2.0' : '');
      expect(publishPackages([client, wallet], manifests, env, run)).toBe(0);
      const commands = run.mock.calls;
      const view = (spec: string) => ['npm', 'view', spec, 'version', '--json'];
      expect(commands.filter(([bin]) => bin !== 'git').map(([bin, args]) => [bin, ...args])).toEqual([
        view(wallet.name + '@' + wallet.version),
        ['pnpm', 'publish', '--access', 'public', '--tag', 'latest', '--no-git-checks'],
        view(client.name + '@' + client.version),
        view(wallet.name + '@' + wallet.version),
        ['pnpm', 'publish', '--access', 'public', '--tag', 'rc', '--no-git-checks'],
      ]);
      expect(commands.filter(([bin]) => bin === 'pnpm').map(([, , options]) => options)).toEqual([
        { cwd: path.join('packages', 'wallet'), stdio: 'inherit' },
        { cwd: path.join('packages', 'client'), stdio: 'inherit' },
      ]);
      const refs = ['wallet-v1.2.0', 'client-v1.0.0-rc.1'];
      expect(gitCalls(run)).toEqual(refType === 'tag' ? [] : refs.flatMap((tag) =>
        mode === 'existing tag' ? [['ls-remote', '--tags', 'origin', 'refs/tags/' + tag]] : tagged(tag)));
      expect(fs.readFileSync(summary, 'utf8')).toBe('- Published @cancore/wallet@1.2.0\n- Published @cancore/client@1.0.0-rc.1\n');
    });
  });

  test.each([
    ['fails to publish', { [wallet.name + '@' + wallet.version]: JSON.stringify(wallet.version) },
      { [client.name]: new Error('registry unavailable') }, '@cancore/client: registry unavailable'],
    ['finds no published version of its dependency', { [wallet.name + '@' + wallet.version]: '[]' }, {},
      '@cancore/client: No published version satisfies @cancore/wallet@1.2.0'],
  ])('keeps releasing independent packages when one package %s', (_case, answers, failPublish, message) => {
    withSummary((env, summary) => {
      const report = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const manifests = new Map<string, object>([
          [wallet.name, wallet],
          [client.name, { ...client, dependencies: { [wallet.name]: 'workspace:*' } }],
          [mcp.name, mcp],
        ]);
        const run = fakeRun([client, mcp], answers, failPublish);
        expect(publishPackages([client, mcp], manifests, env, run)).toBe(1);
        expect(report).toHaveBeenCalledWith(message);
        const publishedDirs = run.mock.calls.filter(([bin]) => bin === 'pnpm').map(([, , options]) => options?.cwd);
        const attempted = Object.keys(failPublish).length ? [path.join('packages', 'client')] : [];
        expect(publishedDirs).toEqual([...attempted, path.join('packages', 'mcp')]);
        expect(gitCalls(run)).toEqual(tagged('mcp-v0.3.0'));
        expect(fs.readFileSync(summary, 'utf8')).toBe('- Published @cancore/mcp@0.3.0\n');
      } finally {
        report.mockRestore();
      }
    });
  });

  test('a re-run skips a version already on npm and still restores its missing tag', () => {
    withSummary((env, summary) => {
      const run = fakeRun([wallet], { [wallet.name + '@' + wallet.version]: JSON.stringify(wallet.version) });
      expect(publishPackages([wallet], new Map([[wallet.name, wallet]]), env, run)).toBe(0);
      expect(run.mock.calls.filter(([bin]) => bin === 'pnpm')).toEqual([]);
      expect(gitCalls(run)).toEqual(tagged('wallet-v1.2.0'));
      expect(fs.readFileSync(summary, 'utf8')).toBe('- Already on npm @cancore/wallet@1.2.0\n');
    });
  });

  test('does not publish when npm cannot say whether the version exists', () => {
    withSummary((env, summary) => {
      const report = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const run = fakeRun([wallet], { [wallet.name + '@' + wallet.version]: npmError('ETIMEDOUT') });
        expect(publishPackages([wallet], new Map([[wallet.name, wallet]]), env, run)).toBe(1);
        expect(run.mock.calls.filter(([bin]) => bin !== 'npm')).toEqual([]);
        expect(fs.existsSync(summary)).toBe(false);
      } finally {
        report.mockRestore();
      }
    });
  });

  test('reports a failed publish and skips tagging and the success summary', () => {
    withSummary((env, summary) => {
      const report = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const run = fakeRun([wallet], {}, { [wallet.name]: new Error('registry unavailable') });
        expect(publishPackages([wallet], new Map([[wallet.name, wallet]]), env, run)).toBe(1);
        expect(report).toHaveBeenCalledWith('@cancore/wallet: registry unavailable');
        expect(gitCalls(run)).toEqual([]);
        expect(fs.existsSync(summary)).toBe(false);
      } finally {
        report.mockRestore();
      }
    });
  });
  // The CLI entry is what publish.yml runs: a failed package must turn the job red, not only the return value.
  test('the publish job exits 1 when npm fails for a package', () => {
    withSummary((env, summary) => {
      const temp = path.dirname(summary);
      fs.mkdirSync(path.join(temp, 'packages', wallet.dir), { recursive: true });
      fs.writeFileSync(path.join(temp, 'packages', wallet.dir, 'package.json'), JSON.stringify(wallet));
      const bin = path.join(temp, 'bin');
      fs.mkdirSync(bin);
      for (const tool of ['npm', 'pnpm']) {
        fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\necho "npm error code ETIMEDOUT" >&2\nexit 1\n', { mode: 0o755 });
      }
      const job = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'publish-plan.cjs')], {
        cwd: temp,
        encoding: 'utf8',
        env: { ...process.env, ...env, PATH: bin + path.delimiter + process.env.PATH, PUBLISH_PLAN: JSON.stringify([wallet]) },
      });
      expect(job.stderr).toContain('@cancore/wallet: Command failed: npm view @cancore/wallet@1.2.0 version --json');
      expect(job.status).toBe(1);
      expect(fs.existsSync(summary)).toBe(false);
    });
  });
});
