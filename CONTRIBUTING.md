# Contributing to the Cancore SDK

Every change starts from a Linear ticket and lands through a pull request. These rules apply to every package under `packages/` (including `@cancore/botd`, `@cancore/bot-mcp`, `@cancore/trader`, `@cancore/client`, `@cancore/wallet`, `@cancore/contracts`, `@cancore/dapp-connector`, and `@cancore/mcp`).

## 1. Comments: why only (`CAN-2777`)

No comments that restate what the code does: say it with intention-revealing names of functions, variables and types, and put the why of a change in the Linear ticket, the PR description and the commit message — `git blame` and `git log` lead from any line back to them. A short comment is allowed only for a why the code cannot carry: an invariant, a money or security constraint, a reference to an external fact (a pin, a platform limit), or `shortcut: <limit>, <when to redo>`. Existing comments stay — do not delete them when touching a file. Comments are in English. No license headers in source files.

Name code and tests after what they do or prove: `refuseExpiredQuote`, not `check2`; `settledFillUsdValue`, not `val`. If a comment restates a line, rename or split the code.

(CAN-2777; operator decision 2026-10-19 on the CTO compromise.)

## 2. Unit Test Coverage (`>= 90%` — Local-Only Gate)

- **No unit tests in CI during the current phase:** running unit tests (`npm test` / `jest`) and `npm run coverage:check` via CI is **prohibited** during the current phase. Unit tests and the coverage ratchet are mandatory **local pre-PR gates** executed by the author before opening or updating a PR, with the results attached to the PR description.
- Every new or changed production file must achieve **`>= 90%` line coverage** in unit tests, and must cover all happy, negative, and boundary/edge branches.
- Package and global floors are enforced locally by `npm run coverage:check` against `scripts/coverage-floors.json`.
- `npm run coverage:check:update` only ratchets existing floors upward when coverage improves; it never lowers an existing floor or adds new unapproved baseline keys.

## 3. Mutation Testing (Local & Nx Blast-Radius Gate)

- CI does **not** run mutation tests (`CAN-1400`). Mutation testing is a mandatory **local pre-PR gate** executed by the author before requesting review.
- **Scope — changed files AND `nx`/blast-radius affected scope**:
  1. Run mutation checks on every production file changed in `git diff origin/main...HEAD`.
  2. Compute the `nx`/blast-radius affected scope (`npx tsx scripts/harness/blast-radius.ts` / `npx nx affected` / workspace dependents and callers of touched exports across `packages/*`) and verify mutation resilience across affected consumers.
- **Thresholds & PR report**:
  - **0 surviving mutants** on new or modified logic (`C3 >= 90%`, `C2 >= 80%` mutation score).
  - Attach the blast-radius scope and mutation table (`mutant -> killed / survived + killing test`) to the PR description.

## 4. File Size (`<= 500 LOC` Hard Cap, `< 300 LOC` Target)

- Target **under 300 LOC** per production `.ts` file; **500 LOC** is the hard blocking ceiling (`npm run loc:check`).
- Generated artifacts (`packages/contracts/src/generated/**`, `packages/client/spec/openapi.json`) are excluded from the ratchet.
- Legacy files above 500 LOC are pinned in `scripts/loc-baseline.json` (`file -> maxLines`). They may not grow by even 1 line (`GREW`); once split to `<= 500 LOC`, `npm run loc:check:update` removes them from the baseline.

## 5. Cognitive Complexity (`CC <= 12`)

- Every function, method, or arrow callback must keep **cognitive complexity `<= 12`** (`npm run complexity:check`).
- Keep control flow flat with guard clauses, early returns, and focused helpers.
- Legacy functions above 12 are pinned in `scripts/cc-baseline.json` (`file -> maxCC`) and cannot grow (`GREW`). Run `npm run complexity:check:update` when refactoring reduces complexity.

## 6. Type Safety (`No any`)

- **Zero new explicit `any`** in production TypeScript (`npm run any:check` against `scripts/any-baseline.json`).
- Banned forms: `: any`, `as any`, `<any>`, `any[]`, `Array<any>`, `Record<..., any>`, `Promise<any>`, and `@ts-ignore` (`@ts-expect-error` requires a linked ticket).
- Parse untrusted inputs (`JSON.parse`, RPC/HTTP payloads, IPC frames, CLI args) as `unknown` and narrow with schemas or type guards.

## 7. Algebraic Data Types (`ADT` & `assertNever`)

- Model fixed sets of variants (outcomes, protocol states, IPC/CLI verdicts, order lifecycle states) as **discriminated unions** with a literal tag (`kind`, `type`, `status`, or `ok`) rather than optional bag properties or stringly-typed flags.
- Narrow discriminated unions with `switch` and enforce compile-time exhaustiveness in the `default` branch:

```ts
export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}
```

## 8. What a pull request must carry

Attach these results, from the PR's head commit, to the PR description. CI repeats them; the PR shows what you ran before asking for review.

| Run | Command | Attach |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | exit code (Local + CI) |
| Quality gates | `npm run loc:check && npm run complexity:check && npm run any:check` | exit code (Local + CI) |
| Unit tests with coverage (**local-only — prohibited in CI during current phase**) | `npx jest --selectProjects node web --coverage --coverageReporters=json-summary && npm run coverage:check` | suites/tests passed, coverage of the changed files (`collectCoverageFrom` in `jest.config.mjs`) |
| Mutation tests (local + `nx`/blast-radius) | revert or flip each changed condition and rerun unit tests across changed files and affected `packages/*` consumers | blast-radius scope + table: mutant → killed / survived, with the killing test |
| Integration tests | `npm run test:int` against a stand (section 9) | suites/tests passed, **none skipped** |
| Build | `npm run build` | exit code |

- **Coverage.** Every new branch and refusal path has a test that fails if the change is reverted; name the assertion that observes the new behaviour.
- **Mutation.** Mutants are verified locally on changed files and their `nx`/blast-radius affected scope. A survivor on logic the PR adds or changes is a blocker.
- **Integration.** The `int` project skips its suites when stand artifacts are absent; a skip is not a pass. Run them against a stand and report the count, as CI's `stand` job does.

## 9. The local stand

**This repository's CI stand** (anvil, the router and test tokens from `packages/trader/test/stand/artifacts.json`):

```bash
anvil --chain-id 11155111 --port 8545 &
npm run build -w @cancore/contracts
node packages/trader/test/stand/up.mjs /tmp/stand
CANCORE_INTENT_JSON=/tmp/stand/intent.json \
CANCORE_ACTORS_ENV=/tmp/stand/local-actors.env \
  npx jest --selectProjects int --runInBand
```

**The full local stand** in [Cancore-io/meta](https://github.com/Cancore-io/meta) (Canton participants, EVM, Tron, backend), driven by its [`Makefile`](https://github.com/Cancore-io/meta/blob/main/Makefile) and [`compose.yaml`](https://github.com/Cancore-io/meta/blob/main/compose.yaml), [`compose.local-dev.yaml`](https://github.com/Cancore-io/meta/blob/main/compose.local-dev.yaml), [`compose.overrides.yaml`](https://github.com/Cancore-io/meta/blob/main/compose.overrides.yaml):

```bash
make stand-up          # cold stand: seed snapshot (or seed locally), start the app, check the chains
make intent-genesis    # deploy and configure CancoreRouter on anvil
make intent-smoke      # one intent end to end: open -> fill -> settle -> sweep
make intent-all        # the whole intent rail
make stop              # stop the application
```

Point `CANCORE_INTENT_JSON` and `CANCORE_ACTORS_ENV` at the files meta's genesis writes (`docker/modules/genesis/out/`) and run `npm run test:int`. Every test that can run on a local stand runs there before review; the PR names the stand.

## 10. RTM: use cases and test cases

Traceability lives in meta: [`docs/rtm/RTM-sdk.md`](https://github.com/Cancore-io/meta/blob/main/docs/rtm/RTM-sdk.md), use cases in [`docs/rtm/sdk-usecases.md`](https://github.com/Cancore-io/meta/blob/main/docs/rtm/sdk-usecases.md), manual checklists in [`docs/rtm/чеклисты/`](https://github.com/Cancore-io/meta/tree/main/docs/rtm/чеклисты). A PR that adds or changes behaviour updates its RTM row — the use case, the covering test cases (unit, integration, stand) with file paths, and a checklist for what only a human can check — and links that change.

## 11. Confirmation in Qase

Integration and stand runs are recorded as a **Qase run** through the ticket's feature-loop (`/fl`), linked on the PR and the Linear ticket with passed / failed / skipped counts and the cause of every skip. Request review only after the Qase run is attached.

## 12. PR Quality Gate Checklist (Required in Every PR Description)

Copy and check off every item in the PR description (`.github/pull_request_template.md`):

- [ ] Comments: why-only in English (CAN-2777) — no "what the code does" comments, existing comments preserved, no license headers
- [ ] Unit tests & coverage (local-only — running unit tests in CI is prohibited during the current phase): ≥ 90% line coverage on new/changed code; coverage-floors.json ratcheted locally (npm test && npm run coverage:check)
- [ ] Local + nx/blast-radius mutation testing: executed locally over changed files and their nx/blast-radius affected scope; 0 surviving mutants on new/changed logic; report attached to PR body
- [ ] File size (LOC): target < 300 LOC, hard cap ≤ 500 LOC (npm run loc:check)
- [ ] Cognitive complexity: CC ≤ 12 per function (npm run complexity:check)
- [ ] Type safety (no any): 0 new explicit any, no @ts-ignore (npm run any:check)
- [ ] Algebraic Data Types (ADT): fixed variant sets modeled as discriminated unions with exhaustive default: return assertNever(x)
- [ ] Local stand verification: end-to-end verified on local compose stand before review
- [ ] RTM & Qase: RTM scenarios updated and Qase run attached
