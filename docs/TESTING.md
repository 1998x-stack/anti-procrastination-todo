# Start-First testing and verification

> This file records **which checks are automated**, not a blanket guarantee of correctness. For current outcomes, inspect [the CI workflow](https://github.com/1998x-stack/anti-procrastination-todo/actions/workflows/ci.yml) for the exact commit.

## Automated suites

| Layer | Command | Tested behavior |
| --- | --- | --- |
| Syntax | npm run check | Parse all executable JavaScript modules |
| Pure domain | npm test | Task validation, focus, step revisions, start/pause/resume/end, outcome semantics, edit version guard, batch undo |
| Deterministic algorithm | npm test | Kind detection, blocker coverage, candidate validity, rotation, generic fallback |
| Local persistence contract | npm test | Atomic memory adapter, idempotency, rollback on errors, export, wipe |
| Event privacy contract | npm test | Strict allowed event names/fields and blocked free-text payloads |
| Chromium E2E | npm run test:e2e | Full UI golden path, refresh recovery, bulk import/export, data deletion, XSS safe rendering, offline-after-load, concurrent local clients, edit/undo |

The browser suite is run in a real Chromium instance by Playwright in GitHub Actions. No running backend is needed.

## Expected P0 invariants

1. A Step may be complete while its Task remains active; Task becomes done only via explicit task_done choice.
2. At most one session is running or paused; second concurrent start fails atomically.
3. Reload while running results in a paused recoverable session, not a second session or guessed background work.
4. Data mutation failure may not be displayed as successful saving.
5. A recent batch can be undone only if none of its entries has a confirmed Step/Session.
6. A stale Task edit must not silently overwrite newer content.
7. Raw Task/Step text must not appear in outbound analytics, external resources or executable HTML.
8. Core capture, focus, Step and Session flows work after the initial app has loaded offline.

## Manual release gates not yet verified

| Gate | Required validation |
| --- | --- |
| Device/browser compatibility | Mobile Safari, Firefox, Android Chrome, browser storage eviction and private mode |
| User accessibility | Screen reader, keyboard-only, 200% zoom, WCAG 2.2 AA audit and focus order |
| Fault injection | QuotaExceededError, aborted transaction, versionchange blocked, abrupt device shutdown |
| Time accuracy | Long sessions, sleep/wake, system clock edits and switching into external work apps |
| Privacy review | Actual hosting logs, content security policy and any third-party telemetry controls |
| User outcomes | Pre-registered randomized start-rate study, qualitative interviews and pressure guardrails |

Passing tests establishes specified behavior under tested conditions only. It does **not** establish the product reduces procrastination, meets all 76 PRD acceptance criteria, or provides clinical benefit.
