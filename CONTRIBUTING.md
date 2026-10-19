# Contributing to the Cancore SDK

Every change starts from a Linear ticket and lands through a pull request. These rules apply to every package under `packages/`.

## 1. Comments: why only

No comments that restate what the code does: say it with intention-revealing names of functions, variables and types, and put the why of a change in the Linear ticket, the PR description and the commit message — `git blame` and `git log` lead from any line back to them. A short comment is allowed only for a why the code cannot carry: an invariant, a money or security constraint, a reference to an external fact (a pin, a platform limit), or `shortcut: <limit>, <when to redo>`. Existing comments stay — do not delete them when touching a file. Comments are in English.

Name code and tests after what they do or prove: `refuseExpiredQuote`, not `check2`; `settledFillUsdValue`, not `val`. If a comment restates a line, rename or split the code.

(CAN-2777; operator decision 2026-10-19 on the CTO compromise.)

## 2. What a pull request must carry

Attach these results, from the PR's head commit, to the PR description. CI repeats them; the PR shows what you ran before asking for review.

| Run | Command | Attach |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | exit code |
| Unit tests with coverage | `npx jest --selectProjects node web --coverage` | suites/tests passed, coverage of the changed files (`collectCoverageFrom` in `jest.config.mjs`) |
| Mutation tests | revert or flip each changed condition and rerun the unit tests | table: mutant → killed / survived, with the killing test |
| Integration tests | `npm run test:int` against a stand (section 3) | suites/tests passed, **none skipped** |
| Build | `npm run build` | exit code |

- **Coverage.** Every new branch and refusal path has a test that fails if the change is reverted; name the assertion that observes the new behaviour.
- **Mutation.** No mutation runner is configured yet, so mutants are made by hand on a copy of the changed code. A survivor on logic the PR adds or changes is a blocker.
- **Integration.** The `int` project skips its suites when stand artifacts are absent; a skip is not a pass. Run them against a stand and report the count, as CI's `stand` job does.

## 3. The local stand

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

## 4. RTM: use cases and test cases

Traceability lives in meta: [`docs/rtm/RTM-sdk.md`](https://github.com/Cancore-io/meta/blob/main/docs/rtm/RTM-sdk.md), use cases in [`docs/rtm/sdk-usecases.md`](https://github.com/Cancore-io/meta/blob/main/docs/rtm/sdk-usecases.md), manual checklists in [`docs/rtm/чеклисты/`](https://github.com/Cancore-io/meta/tree/main/docs/rtm/чеклисты). A PR that adds or changes behaviour updates its RTM row — the use case, the covering test cases (unit, integration, stand) with file paths, and a checklist for what only a human can check — and links that change.

## 5. Confirmation in Qase

Integration and stand runs are recorded as a **Qase run** through the ticket's feature-loop (`/fl`), linked on the PR and the Linear ticket with passed / failed / skipped counts and the cause of every skip. Request review only after the Qase run is attached.

## Before you request review

- [ ] The ticket is linked in the PR title or body.
- [ ] No new comments that restate the code; why-comments only for invariants, money/security, external facts, `shortcut:`.
- [ ] Typecheck, unit with coverage, mutation table, integration (none skipped) and build results are in the PR description.
- [ ] Stand run named, RTM row updated, Qase run linked on the PR and the ticket.
