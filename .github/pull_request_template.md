## Summary

- Ticket: `CAN-XXXX`
- Why:

## Quality Gates Checklist (`CONTRIBUTING.md`)

- [ ] Comments: why-only in English (CAN-2777) — no "what the code does" comments, existing comments preserved, no license headers
- [ ] Unit test coverage: ≥ 90% line coverage on new/changed code; coverage-floors.json ratcheted (npm run coverage:check)
- [ ] Local + nx/blast-radius mutation testing: executed locally over changed files and their nx/blast-radius affected scope; 0 surviving mutants on new/changed logic; report attached to PR body
- [ ] File size (LOC): target < 300 LOC, hard cap ≤ 500 LOC (npm run loc:check)
- [ ] Cognitive complexity: CC ≤ 12 per function (npm run complexity:check)
- [ ] Type safety (no any): 0 new explicit any, no @ts-ignore (npm run any:check)
- [ ] Algebraic Data Types (ADT): fixed variant sets modeled as discriminated unions with exhaustive default: return assertNever(x)
- [ ] Local stand verification: end-to-end verified on local compose stand before review
- [ ] RTM & Qase: RTM scenarios updated and Qase run attached

## Local & Nx Blast-Radius Mutation Report

- Changed files:
- Affected `nx` / blast-radius scope:

| File | Mutant | Status (`killed` / `survived`) | Killing Test |
| --- | --- | --- | --- |
| | | | |

## Verification Evidence

- Stand run:
- RTM PR:
- Qase run:
