import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './cli';

type Repo = { work: string; origin: string; git: (...args: string[]) => string; commit: (message: string) => void; tags: () => string[]; originTags: () => string[] };

const roots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

// A working repo with a bare `origin`, so "annotated tag, pushed" is observable on the remote.
function repo(branch: string): Repo {
  const root = mkdtempSync(join(tmpdir(), 'cancore-release-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', branch, work]);
  const run = (...args: string[]) => git(work, args);
  run('config', 'user.email', 'ci@cancore.test');
  run('config', 'user.name', 'ci');
  run('config', 'tag.gpgSign', 'false');
  run('remote', 'add', 'origin', origin);
  const list = (cwd: string) => git(cwd, ['tag', '--list']).split('\n').filter(Boolean).sort();
  return {
    work,
    origin,
    git: run,
    commit: (message) => void run('commit', '-q', '--allow-empty', '-m', message),
    tags: () => list(work),
    originTags: () => list(origin),
  };
}

function seeded(seed: string | null, branch = 'main'): Repo {
  const r = repo(branch);
  r.commit('chore: initial');
  if (seed) {
    r.git('tag', '-a', seed, '-m', seed);
    r.git('push', '-q', 'origin', seed);
  }
  return r;
}

function run(r: Repo, argv: string[], env: Record<string, string> = {}) {
  return main(argv, { cwd: r.work, env });
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('release version --channel prod --cut (main)', () => {
  // @edge: a breaking commit on v1.4.2 is released as 2.0.0.
  it('feat! on v1.4.2 cuts an annotated v2.0.0 on HEAD and pushes it', async () => {
    const r = seeded('v1.4.2');
    r.commit('feat(api)!: drop the v1 order endpoint');
    const out = await run(r, ['version', '--channel', 'prod', '--cut']);
    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toBe('2.0.0');
    expect(r.git('cat-file', '-t', 'v2.0.0').trim()).toBe('tag');
    expect(r.git('rev-list', '-n', '1', 'v2.0.0').trim()).toBe(r.git('rev-parse', 'HEAD').trim());
    expect(r.originTags()).toContain('v2.0.0');
  });

  it('writes version= and tag= to $GITHUB_OUTPUT', async () => {
    const r = seeded('v1.4.2');
    r.commit('feat: add a field');
    const file = join(r.work, '..', 'github-output');
    writeFileSync(file, '');
    await run(r, ['version', '--channel', 'prod', '--cut'], { GITHUB_OUTPUT: file });
    expect(readFileSync(file, 'utf8').split('\n')).toEqual(expect.arrayContaining(['version=1.5.0', 'tag=v1.5.0']));
  });

  it('a second run on the same commit reuses the tag: no new tag, same version', async () => {
    const r = seeded('v1.4.2');
    r.commit('feat(api)!: drop the v1 order endpoint');
    await run(r, ['version', '--channel', 'prod', '--cut']);
    const again = await run(r, ['version', '--channel', 'prod', '--cut']);
    expect(again.code).toBe(0);
    expect(again.stdout.trim()).toBe('2.0.0');
    expect(r.tags()).toEqual(['v1.4.2', 'v2.0.0']);
    expect(r.originTags()).toEqual(['v1.4.2', 'v2.0.0']);
  });

  it.each([
    ['feat: x', 'v1.5.0'],
    ['fix: x', 'v1.4.3'],
    ['wip: no convention', 'v1.4.3'],
    ['fix: x\n\nRelease-Bump: major', 'v2.0.0'],
    ['feat: x\n\nRing-Bump: patch', 'v1.4.3'],
  ])('%j on v1.4.2 -> %s', async (message, tag) => {
    const r = seeded('v1.4.2');
    r.commit(message);
    const out = await run(r, ['version', '--channel', 'prod', '--cut']);
    expect(out.code).toBe(0);
    expect(r.tags()).toEqual(['v1.4.2', tag].sort());
  });

  it('the highest level over last..HEAD decides, not the last commit', async () => {
    const r = seeded('v1.4.2');
    r.commit('feat(api)!: breaking');
    r.commit('fix: later and smaller');
    expect((await run(r, ['version', '--channel', 'prod', '--cut'])).stdout.trim()).toBe('2.0.0');
  });

  it('counts only tags merged into HEAD: a higher tag on another branch is not the base', async () => {
    const r = seeded('v1.4.2');
    r.git('checkout', '-q', '-b', 'elsewhere');
    r.commit('chore: release elsewhere');
    r.git('tag', '-a', 'v9.9.9', '-m', 'v9.9.9');
    r.git('checkout', '-q', 'main');
    r.commit('fix: x');
    expect((await run(r, ['version', '--channel', 'prod', '--cut'])).stdout.trim()).toBe('1.4.3');
  });

  // D2: the seed tag is pushed by hand; the CLI never invents a starting point.
  it('no seed tag: exit 1 naming the seed tag, nothing tagged', async () => {
    const r = seeded(null);
    r.commit('feat: x');
    const out = await run(r, ['version', '--channel', 'prod', '--cut']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/seed tag/i);
    expect(r.tags()).toEqual([]);
  });

  // I1: a release tag is cut on main only.
  it('on a feature branch --cut refuses and tags nothing', async () => {
    const r = seeded('v1.4.2', 'feature/x');
    r.commit('feat: x');
    const out = await run(r, ['version', '--channel', 'prod', '--cut']);
    expect(out.code).toBe(1);
    expect(r.tags()).toEqual(['v1.4.2']);
  });
});

describe('release version on dev and stage: a prerelease string, never a tag (I1, D8)', () => {
  it('dev: next-dev.N, N = commits since the last tag', async () => {
    const r = seeded('v1.4.2');
    r.commit('feat(api)!: drop the v1 order endpoint');
    const out = await run(r, ['version', '--channel', 'dev']);
    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toBe('2.0.0-dev.1');
    expect(r.tags()).toEqual(['v1.4.2']);
  });

  it('stage: next-stage.N counts every commit since the tag', async () => {
    const r = seeded('v1.4.2', 'stage');
    r.commit('fix: a');
    r.commit('fix: b');
    r.commit('feat: c');
    const out = await run(r, ['version', '--channel', 'stage']);
    expect(out.stdout.trim()).toBe('1.5.0-stage.3');
    expect(r.tags()).toEqual(['v1.4.2']);
  });

  it('dev writes version= and no tag= to $GITHUB_OUTPUT', async () => {
    const r = seeded('v1.4.2');
    r.commit('fix: a');
    const file = join(r.work, '..', 'github-output');
    writeFileSync(file, '');
    await run(r, ['version', '--channel', 'dev'], { GITHUB_OUTPUT: file });
    const lines = readFileSync(file, 'utf8').split('\n');
    expect(lines).toContain('version=1.4.3-dev.1');
    expect(lines.some((l) => l.startsWith('tag='))).toBe(false);
  });

  it.each(['dev', 'stage'])('%s --cut is refused and nothing is tagged', async (channel) => {
    const r = seeded('v1.4.2');
    r.commit('feat: x');
    const out = await run(r, ['version', '--channel', channel, '--cut']);
    expect(out.code).not.toBe(0);
    expect(r.tags()).toEqual(['v1.4.2']);
  });

  it('no seed tag: exit 1 here too', async () => {
    const r = seeded(null);
    expect((await run(r, ['version', '--channel', 'dev'])).code).toBe(1);
  });
});

describe('release CLI arguments', () => {
  it.each([[['version']], [['version', '--channel', 'qa']], [['bump']], [[]]])('%j -> exit 2 with usage on stderr', async (argv) => {
    const r = seeded('v1.4.2');
    const out = await run(r, argv);
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/usage/i);
  });
});

// I1 in CI: actions/checkout of a tag or a PR leaves HEAD detached, so main must still be recognised there,
// and nothing else may pass for it.
describe('release version --cut on a detached HEAD', () => {
  it('HEAD already on origin/main: cuts', async () => {
    const r = seeded('v1.4.2');
    r.commit('feat: x');
    r.git('push', '-q', '-u', 'origin', 'main');
    r.git('checkout', '-q', '--detach', 'HEAD');
    const out = await run(r, ['version', '--channel', 'prod', '--cut']);
    expect(out.code).toBe(0);
    expect(r.originTags()).toContain('v1.5.0');
  });

  it('a run started for refs/heads/main: cuts', async () => {
    const r = seeded('v1.4.2');
    r.commit('fix: x');
    r.git('checkout', '-q', '--detach', 'HEAD');
    const out = await run(r, ['version', '--channel', 'prod', '--cut'], { GITHUB_REF: 'refs/heads/main' });
    expect(out.code).toBe(0);
    expect(r.tags()).toContain('v1.4.3');
  });

  it('neither: refused, nothing tagged', async () => {
    const r = seeded('v1.4.2');
    r.commit('fix: x');
    r.git('checkout', '-q', '--detach', 'HEAD');
    const out = await run(r, ['version', '--channel', 'prod', '--cut'], { GITHUB_REF: 'refs/pull/7/merge' });
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/main only/);
    expect(r.tags()).toEqual(['v1.4.2']);
  });

  it('a named branch other than main is refused even when the run claims main', async () => {
    const r = seeded('v1.4.2', 'feature/x');
    r.commit('fix: x');
    expect((await run(r, ['version', '--channel', 'prod', '--cut'], { GITHUB_REF: 'refs/heads/main' })).code).toBe(1);
    expect(r.tags()).toEqual(['v1.4.2']);
  });
});

describe('release version --channel prod without --cut', () => {
  it('prints the next version and tags nothing', async () => {
    const r = seeded('v1.4.2');
    r.commit('feat: x');
    const out = await run(r, ['version', '--channel', 'prod']);
    expect(out.stdout.trim()).toBe('1.5.0');
    expect(r.tags()).toEqual(['v1.4.2']);
  });
});

describe('release version --cut when the push fails', () => {
  it('exit 1 and the local tag is removed, so a rerun is not a false reuse', async () => {
    const r = seeded('v1.4.2');
    r.commit('feat: x');
    r.git('remote', 'set-url', 'origin', join(r.work, '..', 'missing.git'));
    const out = await run(r, ['version', '--channel', 'prod', '--cut']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/could not push v1\.5\.0/);
    expect(r.tags()).toEqual(['v1.4.2']);
  });
});

describe('release CLI: an unknown flag', () => {
  it('exit 2 naming it', async () => {
    const out = await run(seeded('v1.4.2'), ['version', '--channel', 'prod', '--force']);
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/--force/);
  });
});

// I1 with a configured cut branch (BUG-1726): the cut moves to the named branch, and main stops passing for it on
// every one of the three recognition paths.
describe('release version --cut --cut-branch dev', () => {
  const cutOnDev = ['version', '--channel', 'prod', '--cut', '--cut-branch', 'dev'];

  it('on dev: cuts and pushes the tag', async () => {
    const r = seeded('v1.4.2', 'dev');
    r.commit('feat: x');
    const out = await run(r, cutOnDev);
    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toBe('1.5.0');
    expect(r.originTags()).toContain('v1.5.0');
  });

  it('--cut-branch " dev" while on dev: refused, the name is taken as given (sdk#328 r4 BG-1)', async () => {
    const r = seeded('v1.4.2', 'dev');
    r.commit('feat: x');
    expect((await run(r, ['version', '--channel', 'prod', '--cut', '--cut-branch', ' dev'])).code).toBe(1);
    expect(r.tags()).toEqual(['v1.4.2']);
  });

  it('on main: refused naming dev, nothing tagged', async () => {
    const r = seeded('v1.4.2');
    r.commit('feat: x');
    const out = await run(r, cutOnDev);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/cut on dev only/);
    expect(r.tags()).toEqual(['v1.4.2']);
  });

  it('detached, a run started for refs/heads/dev: cuts', async () => {
    const r = seeded('v1.4.2', 'dev');
    r.commit('fix: x');
    r.git('checkout', '-q', '--detach', 'HEAD');
    const out = await run(r, cutOnDev, { GITHUB_REF: 'refs/heads/dev' });
    expect(out.code).toBe(0);
    expect(r.originTags()).toContain('v1.4.3');
  });

  it('detached, a run started for refs/heads/main: refused, nothing tagged', async () => {
    const r = seeded('v1.4.2');
    r.commit('fix: x');
    r.git('checkout', '-q', '--detach', 'HEAD');
    expect((await run(r, cutOnDev, { GITHUB_REF: 'refs/heads/main' })).code).toBe(1);
    expect(r.tags()).toEqual(['v1.4.2']);
  });

  it('detached, HEAD already on origin/dev: cuts', async () => {
    const r = seeded('v1.4.2', 'dev');
    r.commit('feat: x');
    r.git('push', '-q', '-u', 'origin', 'dev');
    r.git('checkout', '-q', '--detach', 'HEAD');
    const out = await run(r, cutOnDev);
    expect(out.code).toBe(0);
    expect(r.originTags()).toContain('v1.5.0');
  });

  it('detached, HEAD only on origin/main: refused, nothing tagged', async () => {
    const r = seeded('v1.4.2');
    r.commit('feat: x');
    r.git('push', '-q', '-u', 'origin', 'main');
    r.git('checkout', '-q', '--detach', 'HEAD');
    expect((await run(r, cutOnDev)).code).toBe(1);
    expect(r.tags()).toEqual(['v1.4.2']);
  });

  // Exact match on every recognition path: a near-miss name or ref never passes for dev (sdk#326 audit RX-1). Per path:
  // prefix, suffix, substring, case variant, another remote, a tag and a pull ref (sdk#327 audit RX-1..RX-3).
  // Fullwidth letters and a zero-width space stay distinct: no Unicode folding or stripping (sdk#328 r4 RX-5, RX-6).
  it.each(['dev-evil', 'develop', 'dev/x', 'feature-dev', 'feature/dev', 'feature/dev/x', 'Dev', 'DEV', 'origin/dev', 'upstream/dev', 'heads/dev', 'tags/dev', 'pull/1/merge', 'd', 'de', 'ev', 'dev\u00a0', '\u00a0dev', 'dev\ufeff', 'dev\u3000', '\uff44\uff45\uff56', 'dev\u200b'])('checked-out branch %j: refused, nothing tagged', async (branch) => {
    const r = seeded('v1.4.2', branch);
    r.commit('feat: x');
    expect(r.git('symbolic-ref', '--short', 'HEAD').replace(/\n$/, '')).toBe(branch);
    expect((await run(r, cutOnDev)).code).toBe(1);
    expect(r.tags()).toEqual(['v1.4.2']);
  });

  // A checked-out branch decides alone: no env var naming dev rescues another branch (sdk#327 r3 audit RX-3).
  const envNamingDev: Record<string, string>[] = [{ GITHUB_HEAD_REF: 'dev' }, { GITHUB_BASE_REF: 'dev' }, { GITHUB_REF_NAME: 'dev' }];
  it.each(envNamingDev)('checked-out feature, a run with %j: refused, nothing tagged', async (env) => {
    const r = seeded('v1.4.2', 'feature');
    r.commit('feat: x');
    expect((await run(r, cutOnDev, env)).code).toBe(1);
    expect(r.tags()).toEqual(['v1.4.2']);
  });

  it.each([
    'refs/heads/dev-evil', 'refs/heads/develop', 'refs/heads/dev/x', 'refs/tags/dev', 'refs/pull/1/merge', 'refs/remotes/origin/dev', 'dev', 'refs/heads/feature/dev',
    'refs/heads/feature-dev', 'refs/heads/feature/dev/x', 'refs/heads/Dev', 'refs/heads/DEV', 'REFS/HEADS/dev', 'refs/remotes/upstream/dev', ' refs/heads/dev', 'refs/heads/dev\n',
    'refs/heads/de', 'refs/heads/d', 'refs/heads/', 'heads/dev', 'refs/heads/\uff44\uff45\uff56', 'refs/heads/dev\u200b',
  ])(
    'detached, a run started for %j: refused, nothing tagged',
    async (ref) => {
      const r = seeded('v1.4.2', 'feature');
      r.commit('feat: x');
      r.git('checkout', '-q', '--detach', 'HEAD');
      expect((await run(r, cutOnDev, { GITHUB_REF: ref })).code).toBe(1);
      expect(r.tags()).toEqual(['v1.4.2']);
    },
  );

  // Only GITHUB_REF names the run's ref: the PR head or base and the short name of a tag never pass for dev.
  it.each<Record<string, string>>([
    { GITHUB_REF: 'refs/pull/1/merge', GITHUB_HEAD_REF: 'dev' },
    { GITHUB_REF: 'refs/pull/1/merge', GITHUB_BASE_REF: 'dev' },
    { GITHUB_REF: 'refs/tags/dev', GITHUB_REF_NAME: 'dev' },
  ])('detached, a run with %j: refused, nothing tagged', async (env) => {
    const r = seeded('v1.4.2', 'feature');
    r.commit('feat: x');
    r.git('checkout', '-q', '--detach', 'HEAD');
    expect((await run(r, cutOnDev, env)).code).toBe(1);
    expect(r.tags()).toEqual(['v1.4.2']);
  });

  it.each(['dev-evil', 'develop', 'dev/x', 'feature-dev', 'feature/dev', 'feature/dev/x', 'Dev', 'DEV', 'pull/1/merge', 'd', 'de', 'dev\u00a0', '\u00a0dev', '\uff44\uff45\uff56', 'dev\u200b'])('detached, HEAD only on origin/%j: refused, nothing tagged', async (branch) => {
    const r = seeded('v1.4.2', branch);
    r.commit('feat: x');
    r.git('push', '-q', '-u', 'origin', branch);
    r.git('checkout', '-q', '--detach', 'HEAD');
    expect(r.git('branch', '-r', '--contains', 'HEAD', '--format=%(refname:short)').split('\n')).toContain(`origin/${branch}`);
    expect((await run(r, cutOnDev)).code).toBe(1);
    expect(r.originTags()).toEqual(['v1.4.2']);
  });

  // Without GITHUB_REF only origin/dev decides: no other env var naming dev rescues a HEAD off it (sdk#327 r3 audit RX-4).
  it.each(envNamingDev)('detached, no GITHUB_REF, HEAD only on origin/feature, a run with %j: refused, origin gets no tag', async (env) => {
    const r = seeded('v1.4.2', 'feature');
    r.commit('feat: x');
    r.git('push', '-q', '-u', 'origin', 'feature');
    r.git('checkout', '-q', '--detach', 'HEAD');
    expect((await run(r, cutOnDev, env)).code).toBe(1);
    expect(r.originTags()).toEqual(['v1.4.2']);
  });

  // Path 3 reads origin's remote-tracking branches only: dev on another remote, or a local branch or tag that
  // shortens to origin/dev, never passes for it.
  const upstreamDev = (target: string) => (r: Repo) => {
    const upstream = join(r.work, '..', 'upstream.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', upstream]);
    r.git('remote', 'add', 'upstream', upstream);
    r.git('push', '-q', 'upstream', `HEAD:refs/heads/${target}`);
    r.git('fetch', '-q', 'upstream');
  };
  it.each<[string, (r: Repo) => void]>([
    ['refs/remotes/upstream/dev', upstreamDev('dev')],
    ['refs/remotes/upstream/origin/dev', upstreamDev('origin/dev')],
    ['refs/heads/origin/dev', (r) => void r.git('branch', 'origin/dev')],
    ['refs/tags/origin/dev', (r) => void r.git('tag', 'origin/dev')],
  ])('detached, no GITHUB_REF, HEAD only on %s (origin has no dev): refused, origin gets no tag', async (ref, place) => {
    const r = seeded('v1.4.2', 'feature');
    r.commit('feat: x');
    place(r);
    r.git('checkout', '-q', '--detach', 'HEAD');
    expect(r.git('for-each-ref', '--contains', 'HEAD', '--format=%(refname)').split('\n')).toContain(ref);
    expect((await run(r, cutOnDev)).code).toBe(1);
    expect(r.originTags()).toEqual(['v1.4.2']);
  });

  // A set GITHUB_REF decides on a detached HEAD: origin/dev containing HEAD does not rescue another ref (audit BG-1).
  it.each(['refs/tags/x', 'refs/tags/dev', 'refs/pull/1/merge', 'refs/heads/feature', ''])(
    'detached, HEAD on origin/dev, a run started for %j: refused, nothing tagged',
    async (ref) => {
      const r = seeded('v1.4.2', 'dev');
      r.commit('feat: x');
      r.git('push', '-q', '-u', 'origin', 'dev');
      r.git('checkout', '-q', '--detach', 'HEAD');
      const out = await run(r, cutOnDev, { GITHUB_REF: ref });
      expect(out.code).toBe(1);
      expect(out.stderr).toMatch(/cut on dev only/);
      expect(r.originTags()).toEqual(['v1.4.2']);
    },
  );

  it('checked-out dev decides before GITHUB_REF: cuts even when the run names another ref', async () => {
    const r = seeded('v1.4.2', 'dev');
    r.commit('feat: x');
    expect((await run(r, cutOnDev, { GITHUB_REF: 'refs/pull/1/merge' })).code).toBe(0);
    expect(r.originTags()).toContain('v1.5.0');
  });

  it.each([
    [['version', '--channel', 'prod', '--cut', '--cut-branch'], /needs a branch name/],
    [['version', '--channel', 'prod', '--cut', '--cut-branch', ''], /needs a branch name/],
    [['version', '--channel', 'prod', '--cut-branch', '--cut'], /needs a branch name/],
    [['version', '--channel', 'prod', '--cut-branch', 'dev'], /only goes with --cut/],
    [['version', '--channel', 'dev', '--cut-branch', 'dev'], /only goes with --cut/],
  ])('%j -> exit 2 (%s), nothing tagged', async (argv, reason) => {
    const r = seeded('v1.4.2', 'dev');
    r.commit('feat: x');
    const out = await run(r, argv);
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(reason);
    expect(r.tags()).toEqual(['v1.4.2']);
  });
});
