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
