import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { bumpVersion, resolveBumpSignal } from './bump';

export type CliContext = { cwd: string; env: Record<string, string | undefined> };
export type CliResult = { code: number; stdout: string; stderr: string };

type Channel = 'dev' | 'stage' | 'prod';
type Args = { channel: Channel; cut: boolean; cutBranch: string };
type Git = (...args: string[]) => { ok: boolean; out: string; err: string };

const USAGE = 'usage: release version --channel <dev|stage|prod> [--cut [--cut-branch <name>]]   (--cut only with --channel prod, on the cut branch: main unless --cut-branch names another)';
const DEFAULT_CUT_BRANCH = 'main';
const CHANNELS: readonly Channel[] = ['dev', 'stage', 'prod'];
const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+$/;

class Refusal extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  let channel: string | undefined;
  let cut = false;
  let cutBranch: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--cut') cut = true;
    else if (rest[i] === '--channel') channel = rest[++i];
    else if (rest[i] === '--cut-branch') cutBranch = rest[++i] ?? '';
    else throw new Refusal(2, `unknown argument "${rest[i]}"\n${USAGE}`);
  }
  if (command !== 'version' || !CHANNELS.includes(channel as Channel)) throw new Refusal(2, USAGE);
  if (cut && channel !== 'prod') throw new Refusal(2, `--cut is prod-only: dev and stage get a prerelease string, never a tag\n${USAGE}`);
  return { channel: channel as Channel, cut, cutBranch: resolveCutBranch(cut, cutBranch) };
}

function resolveCutBranch(cut: boolean, cutBranch: string | undefined): string {
  if (cutBranch === undefined) return DEFAULT_CUT_BRANCH;
  if (cutBranch === '' || cutBranch.startsWith('-')) throw new Refusal(2, `--cut-branch needs a branch name\n${USAGE}`);
  if (!cut) throw new Refusal(2, `--cut-branch only goes with --cut\n${USAGE}`);
  return cutBranch;
}

// Only the trailing newline is cut: String.prototype.trim would also strip Unicode spaces git allows in ref names (sdk#327 r3 RX-1).
const gitAt = (cwd: string): Git => (...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').replace(/\r?\n$/, ''), err: (r.stderr ?? '').trim() };
};

const releaseTags = (listing: string) => listing.split('\n').map((t) => t.trim()).filter((t) => RELEASE_TAG_RE.test(t));

function lastReleaseTag(git: Git): string {
  const tag = releaseTags(git('tag', '--merged', 'HEAD', '--list', 'v*', '--sort=-v:refname').out)[0];
  if (!tag) throw new Refusal(1, 'no seed tag: no vX.Y.Z tag is merged into HEAD. Push the seed tag by hand (annotated, on the cut branch) first; in CI check out with fetch-depth: 0, a shallow clone sees no tags.');
  return tag;
}

// I1: a release tag is cut on the cut branch only (main unless --cut-branch names another). A CI checkout may be
// detached, so the cut branch is also recognised by the ref the run was started for; a set GITHUB_REF decides alone,
// and origin/<cut branch> already containing HEAD counts only for a run without GITHUB_REF (local, detached).
function onCutBranch(git: Git, env: CliContext['env'], cutBranch: string): boolean {
  const branch = git('symbolic-ref', '-q', '--short', 'HEAD');
  if (branch.ok) return branch.out === cutBranch;
  if (env.GITHUB_REF !== undefined) return env.GITHUB_REF === `refs/heads/${cutBranch}`;
  return git('branch', '-r', '--contains', 'HEAD', '--format=%(refname:short)').out.split('\n').includes(`origin/${cutBranch}`);
}

function nextVersion(git: Git, last: string): string {
  const log = git('log', '--format=%B%x00', `${last}..HEAD`).out;
  const messages = log.split('\0').map((m) => m.trim()).filter(Boolean);
  return bumpVersion(last.slice(1), resolveBumpSignal(messages).level);
}

function cutTag(git: Git, tag: string): void {
  const created = git('tag', '-a', tag, '-m', tag, 'HEAD');
  if (!created.ok) throw new Refusal(1, `could not create ${tag}: ${created.err}`);
  const pushed = git('push', 'origin', `refs/tags/${tag}`);
  if (pushed.ok) return;
  git('tag', '-d', tag);
  throw new Refusal(1, `could not push ${tag}, local tag removed: ${pushed.err}`);
}

function release(git: Git, args: Args, env: CliContext['env']): { version: string; tag: string | null } {
  if (args.cut && !onCutBranch(git, env, args.cutBranch)) throw new Refusal(1, `--cut refused: a release tag is cut on ${args.cutBranch} only (I1)`);
  const last = lastReleaseTag(git);
  if (args.channel !== 'prod') {
    const commits = git('rev-list', '--count', `${last}..HEAD`).out;
    return { version: `${nextVersion(git, last)}-${args.channel}.${commits}`, tag: null };
  }
  // I1: once per commit, never moved — a rerun on a released commit reports the tag it already has.
  const headTag = releaseTags(git('tag', '--points-at', 'HEAD', '--list', 'v*', '--sort=-v:refname').out)[0];
  if (headTag) return { version: headTag.slice(1), tag: headTag };
  const next = nextVersion(git, last);
  if (!args.cut) return { version: next, tag: null };
  cutTag(git, `v${next}`);
  return { version: next, tag: `v${next}` };
}

export async function main(argv: string[], ctx: CliContext): Promise<CliResult> {
  try {
    const { version, tag } = release(gitAt(ctx.cwd), parseArgs(argv), ctx.env);
    if (ctx.env.GITHUB_OUTPUT) appendFileSync(ctx.env.GITHUB_OUTPUT, `version=${version}\n${tag ? `tag=${tag}\n` : ''}`);
    return { code: 0, stdout: `${version}\n`, stderr: '' };
  } catch (error) {
    if (error instanceof Refusal) return { code: error.code, stdout: '', stderr: `${error.message}\n` };
    throw error;
  }
}
