# Implementation phases and quality gates

The source-of-truth product requirements live at [1998X Projects](https://github.com/1998x-stack/projects/tree/main/projects/productivity/anti-procrastination-todo).

| Phase | Deliverable | Required check | Status |
| --- | --- | --- | --- |
| 0 | Code taxonomy, scripts, CI scaffold | All linked folders have tracked files | Implemented |
| 1 | Pure domain model + rule-based start suggestions | Node unit tests for invariants and edge cases | In progress |
| 2 | IndexedDB transactional snapshot repository | Persistence, conflict and save-failure checks | In progress |
| 3 | Accessible local-first UI golden path | Browser flow, refresh, pause and outcome verification | In progress |
| 4 | Privacy, telemetry, optional backend | Explicit opt-in and separate backend/security review | Not implemented |
| 5 | User research and comparative experiment | Informed consent, preregistered behavioral endpoints | Not started |

## Scope and intentional deviations

Initial prototype uses **zero-dependency browser ES modules**, instead of introducing React/TypeScript immediately. This is a reversible engineering decision: clean `algorithm/domain/persistence/frontend` module boundaries retain the PRD's responsibility split, and a React migration can later replace only the rendering layer. The first priority is a testable product loop rather than framework complexity.

P0 user task data stays in IndexedDB; the server-side telemetry design remains a proposal. This code is **not medical treatment**, and no behavior improvement has been measured.

## Definition of done

Changes must retain task/step distinction, no accidental task completion, an explicit save confirmation, no private text in network requests, and no repeated session start after double clicks. CI runs `npm run verify`. A passing unit suite does not establish browser compatibility or user outcome improvement.
