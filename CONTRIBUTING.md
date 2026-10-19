# Contributing to the Cancore SDK

Every change starts from a Linear ticket and lands through a pull request. These
rules apply to every package under `packages/`.

## 1. Comments: why only

No comments that restate what the code does: say it with intention-revealing
names of functions, variables and types, and put the why of a change where it
stays attached to the change:

- the **Linear ticket**: what is asked, why, the decisions taken;
- the **pull request description**: what changed, why this way, what was run;
- the **commit message**: the cause of the change, in a sentence or two.

`git blame` and `git log` lead from any line back to its commit, PR and ticket.

A short comment is allowed only for a why the code cannot carry: an invariant,
a money or security constraint, a reference to an external fact (a pin, a
platform limit), or `shortcut: <limit>, <when to redo>`. Comments are in
English.

A function, variable, type or test is named after what it does or proves:
`refuseExpiredQuote`, not `check2`; `settledFillUsdValue`, not `val`. If a
comment restates a line, rename or split the code instead.

Existing comments stay — do not delete them when touching a file.

(CAN-2777; operator decision 2026-10-19 on the CTO compromise.)

## 2. What a pull request must carry

Attach the results of these runs to the PR description, on the PR's head commit.
CI repeats them, but the PR shows what you ran before asking for review.

| Run | Command | What to attach |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | exit code |
| Unit tests with coverage | `npx jest --selectProjects node web --coverage` | suites/tests passed, coverage of the changed files (`collectCoverageFrom` in `jest.config.mjs`) |
| Mutation tests | revert or flip each changed condition and rerun the unit tests | a table: mutant → killed / survived, with the test that kills it |
| Integration tests | `npm run test:int` against a stand (section 3) | suites/tests passed, **none skipped** |
| Build | `npm run build` | exit code |

Rules for the results:

- **Coverage.** Every new branch and every refusal path has a test that fails if
  the change is reverted. Name the assertion that observes the new behaviour.
- **Mutation.** No mutation runner is configured in this repository yet, so the
  mutants are made by hand on a copy of the changed code. A surviving mutant on
  logic the PR adds or changes is a blocker, not a nit.
- **Integration.** The `int` project skips its suites when the stand artifacts are
  absent. A skipped suite is not a pass: run them against a stand and report the
  count, as CI's `stand` job does.

## 3. The local stand

Integration suites run against a stand. Two are available:

**The CI stand of this repository** (anvil, the router and test tokens from
`packages/trader/test/stand/artifacts.json`):

```bash
anvil --chain-id 11155111 --port 8545 &
npm run build -w @cancore/contracts
node packages/trader/test/stand/up.mjs /tmp/stand
CANCORE_INTENT_JSON=/tmp/stand/intent.json \
CANCORE_ACTORS_ENV=/tmp/stand/local-actors.env \
  npx jest --selectProjects int --runInBand
```

**The full local stand** in [Cancore-io/meta](https://github.com/Cancore-io/meta)
(Canton participants, EVM, Tron and the backend). It is driven by meta's
[`Makefile`](https://github.com/Cancore-io/meta/blob/main/Makefile) and compose
files [`compose.yaml`](https://github.com/Cancore-io/meta/blob/main/compose.yaml),
[`compose.local-dev.yaml`](https://github.com/Cancore-io/meta/blob/main/compose.local-dev.yaml)
and [`compose.overrides.yaml`](https://github.com/Cancore-io/meta/blob/main/compose.overrides.yaml):

```bash
make stand-up          # cold stand: seed snapshot (or seed locally), start the app, check the chains
make intent-genesis    # deploy and configure CancoreRouter on anvil
make intent-smoke      # one intent end to end: open -> fill -> settle -> sweep
make intent-all        # the whole intent rail
make stop              # stop the application
```

Point `CANCORE_INTENT_JSON` and `CANCORE_ACTORS_ENV` at the files meta's genesis
writes (`docker/modules/genesis/out/`) and run `npm run test:int`. Every test that
can run on a local stand is run there before review, and the PR names the stand
it ran on.

## 4. RTM: use cases and test cases

Requirements traceability lives in meta:
[`docs/rtm/RTM-sdk.md`](https://github.com/Cancore-io/meta/blob/main/docs/rtm/RTM-sdk.md)
for this repository, narrative use cases in
[`docs/rtm/sdk-usecases.md`](https://github.com/Cancore-io/meta/blob/main/docs/rtm/sdk-usecases.md),
manual checklists in
[`docs/rtm/чеклисты/`](https://github.com/Cancore-io/meta/tree/main/docs/rtm/чеклисты).

A PR that adds or changes behaviour adds or updates its RTM row: the use case,
the test cases that cover it (unit, integration, stand) with their file paths,
and a checklist for what can only be checked by hand. Link the RTM change from
the PR.

## 5. Confirmation in Qase

The integration and stand runs are recorded as a **Qase run**, created through
the ticket's feature-loop (`/fl`): the run is linked on the PR and on the Linear
ticket, with the passed, failed and skipped counts and the cause of every skip.
Review is requested only after the Qase run is attached.

## Before you request review

- [ ] The ticket is linked in the PR title or body.
- [ ] No new comments that restate the code; why-comments only for invariants, money/security, external facts, `shortcut:`.
- [ ] Typecheck, unit with coverage, mutation table, integration (none skipped)
      and build results are in the PR description.
- [ ] Stand run named, RTM row updated, Qase run linked on the PR and the ticket.
