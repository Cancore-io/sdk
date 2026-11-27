# @cancore/release

One SemVer rule for every Cancore repository: which level a change bumps, the `vX.Y.Z` tag cut on
`main`, the prerelease string a `dev` or `stage` build carries, and the check that a neighbour
service runs a version this one supports. No dependencies; the library entry is browser-safe.

## The version, in CI

```bash
npx @cancore/release@0.1.0 version --channel prod --cut   # on main: tag vX.Y.Z on HEAD, push it
npx @cancore/release@0.1.0 version --channel dev          # elsewhere: X.Y.Z-dev.N, no tag
npx @cancore/release@0.1.0 version --channel prod --cut --cut-branch dev   # a repo that cuts its tags on dev
```

- The base is the highest `vX.Y.Z` tag merged into `HEAD`. No such tag: exit 1. The first
  (seed) tag is pushed by hand, annotated, on `main`.
- The level is the highest signal over the commits since that tag: a `Release-Bump: major|minor|patch`
  trailer (`Ring-Bump:` is read too) beats conventional commits (`feat!:`, `fix(x)!:` or a
  `BREAKING CHANGE:` footer is major, `feat` minor, `fix`/`chore`/`docs`/... patch); nothing
  declared is patch. A major resets minor and patch: `1.4.2` + breaking = `2.0.0`.
- `--cut` runs on the cut branch only and only with `--channel prod`. The cut branch is `main`;
  `--cut-branch <name>` names another (a repo that cuts on `dev` still passes `--channel prod --cut`),
  and then `main` is refused like any other branch. A detached HEAD passes only when `GITHUB_REF` is exactly
  `refs/heads/<cut branch>`; any other `GITHUB_REF` (a tag, a pull ref, another branch) is refused even when HEAD is
  already on `origin/<cut branch>`, and `origin/<cut branch>` containing HEAD counts only for a run without
  `GITHUB_REF` (a local detached checkout). A commit that already carries a release tag
  reports it again; a tag is never moved.
- `dev` and `stage` print `<next>-dev.N` / `<next>-stage.N`, N = commits since the tag.
- `version=` (and `tag=` when one exists) go to `$GITHUB_OUTPUT`. Bad arguments exit 2.

## Compatibility, at runtime

```ts
import { checkNeighbours, lowestVersion, versionDoc } from '@cancore/release';

const attestor = lowestVersion(answers.map((a) => a?.version ?? null));
const compat = checkNeighbours({ attestor: '>=2.1.0 <3.0.0' }, { attestor });
const doc = versionDoc({ component: 'backend', service: 'gateway', version, gitSha, channel, compat });
```

- Ranges are `>=X.Y.Z` or `>=X.Y.Z <A.B.C`; anything else throws. A prerelease suffix is ignored:
  `1.5.0-dev.3` satisfies `>=1.5.0`.
- `checkNeighbours` never throws on what a neighbour answered: missing, `unknown` or malformed is
  `ok: false`. A mismatch is for a warning, never for blocking a request.
- `versionDoc` copies its own fields only, so nothing else the caller holds (an RPC URL, a secret)
  reaches the public `/version` document.

## Install

```bash
npm install @cancore/release
```
