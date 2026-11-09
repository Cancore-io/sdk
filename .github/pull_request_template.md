## Summary

- Ticket: `CAN-XXXX`
- Why:

## Quality Gates Checklist (`CONTRIBUTING.md`)

- [ ] Comments: why-only in English (CAN-2777) — no "what the code does" comments, existing comments preserved, no license headers
- [ ] Unit tests & coverage (local-only — running unit tests in CI is prohibited during the current phase): ≥ 90% line coverage on new/changed code; coverage-floors.json ratcheted locally (pnpm test && pnpm run coverage:check)
- [ ] Local + nx/blast-radius mutation testing: executed locally over changed files and their nx/blast-radius affected scope; 0 surviving mutants on new/changed logic; report attached to PR body
- [ ] File size (LOC): target < 300 LOC, hard cap ≤ 500 LOC (pnpm run loc:check)
- [ ] Cognitive complexity: CC ≤ 12 per function (pnpm run complexity:check)
- [ ] Type safety (no any): 0 new explicit any, no @ts-ignore (pnpm run any:check)
- [ ] Algebraic Data Types (ADT): fixed variant sets modeled as discriminated unions with exhaustive default: return assertNever(x)
- [ ] Local stand verification: end-to-end verified on local compose stand before review
- [ ] Integration suites registered in a lane (CAN-3253): every new or renamed `*.int.test.ts` is named in `ci.yml`, is `*.stand.int.test.ts`, or runs in `npm run test:int` with no skip path (`node --test scripts/int-registration.test.mjs`) — or `n/a`
- [ ] Allure & Docs-as-Code RTM traceability: scenarios linked in `docs/rtm/rtm.yaml` (`REQ-<DOMAIN>-<NNN>`) and verified in Allure via the external CAEF script [`scripts/ci/allure-rtm-sync.ts`](https://github.com/Cancore-io/CAEF/blob/main/scripts/ci/allure-rtm-sync.ts) (no Qase.io)
- [ ] ReportPortal launch uploaded: launch URL (https://reportportal-dev.cancore.app/ui/#caef/launches/all/<id>) attached to the PR and Linear ticket (--tx-evidence reportportal_run=...), uploaded with the full command in `CONTRIBUTING.md` §10 — or `n/a: no Allure producer yet (CAN-3413)`: jest writes no JUnit/Allure results yet

## Local & Nx Blast-Radius Mutation Report

- Changed files:
- Affected `nx` / blast-radius scope:

| File | Mutant | Status (`killed` / `survived`) | Killing Test |
| --- | --- | --- | --- |
| | | | |

## Verification Evidence

- Stand run:
- RTM (`docs/rtm/rtm.yaml`) PR:
- Allure / `allure-rtm-sync.ts` verification:
- ReportPortal launch (`https://reportportal-dev.cancore.app/ui/#caef/launches/all/<id>`):
