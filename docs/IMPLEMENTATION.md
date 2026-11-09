# Start-First implementation record

**Code repository:** https://github.com/1998x-stack/anti-procrastination-todo  
**Product documentation:** https://github.com/1998x-stack/projects/tree/main/projects/productivity/anti-procrastination-todo  
**Record date:** 2026-11-09 · **Stage:** Runnable technical prototype, not launched product.

| Phase | Expected capability | Current implementation | Evidence / next gate |
| --- | --- | --- | --- |
| 0 · Foundation | Code taxonomy, CI, project docs | **Implemented** | Tracked code folders, Node CI and browser CI |
| 1 · Domain + algorithm | User-selected blocker, pure transitions and safe first-step templates | **v2 implemented** | 36 template cells, 144-case synthetic matrix, retry E2E; user benefit not measured |
| 2 · Local storage | IndexedDB commit semantics, state recovery, export and delete | **Implemented with v2 snapshot validation** | Schema/reference/status invariants; browser concurrency; fault-injection/device QA still needed |
| 3 · UI vertical slice | Capture → focus → editable step → short session → outcome → retry | **Implemented core + Calm Focus v2 visual iteration** | Chromium flow and visual viewport checks; UX/accessibility research not completed |
| 4 · Optional backend and privacy telemetry | Explicit study consent, event API, deletion workflow | **Loopback reference implemented; not deployed/connected** | HTTP tests, write/delete token separation, idempotency, TTL; no real opt-in UI or durable database |
| 5 · Product validation | Interviews, randomized baseline comparison, measuring difficult-task starts | **Not started** | Must preregister metrics and recruit consenting participants |

## Technical decisions

**ADR-001 — ship a no-build browser prototype first.** The prior frontend design suggests React + TypeScript + Vite. This first vertical slice deliberately uses native ES Modules, CSS and Node's built-in test runner to ensure the task-start loop is executable with no runtime dependency or API. The cost is weaker static typing and a custom UI rendering layer. Migrate to React/TS if continued product investment justifies it; do not call this a completion of the original React code plan.

**ADR-002 — IndexedDB as the only source of truth.** Business objects are atomically persisted in a single versioned snapshot. It is appropriate for an early single-device product, not a claim of arbitrary-scale performance. The model enforces a single running/paused session. Stored command IDs are bounded to avoid indefinite growth.

**ADR-006 — harden local snapshot at transaction boundary.** New `validateSnapshot` rejects unsupported schema, duplicate active Tasks/sessions and broken references without silently wiping stored data. This adds O(N) validation cost to the existing single-record design; measure larger datasets before normalizing stores.

**ADR-007 — optional research API remains lab-only.** A memory-backed HTTP reference verifies registration, whitelisted events, duplicate detection and deletion. It is disabled without an explicit environment variable and binds only 127.0.0.1. No frontend event uploads or production database are connected.

**ADR-003 — no LLM for P0.** User-selected blocker and deterministic templates must provide a safe editable step. An online assistant requires new consent, privacy review, cost budgets and a controlled improvement experiment.

**ADR-004 — server not required.** The optional backend folder is a future strict event contract. No user title, note or step is transmitted. A deployment of telemetry would need separate verified consent and retention/delete semantics.

**ADR-005 — verified vs inferred elapsed time.** The browser tracks confirmed visible-page runtime, not true human concentration. Hidden-tab time and uncertain restart time are excluded; this prevents inflated analytics but may not fit workflows that move into another app. A usability study should validate that trade-off.

## UI iteration

Calm Focus v2 introduces a two-column desktop inbox, descriptive blocker cards, a user-editable Step with live character counter, a low-pressure ring timer, a four-stage guide, clearer outcome cards and a persistent light/dark appearance preference. It intentionally avoids remote fonts and decorative network requests. Source: [UI design system](UI-DESIGN-SYSTEM.md). CI contains automated layout and interaction regression tests; device accessibility auditing is still required.

## Deep algorithm/backend design v2

- [Algorithm optimization v2](https://github.com/1998x-stack/projects/blob/main/projects/productivity/anti-procrastination-todo/reports/algorithm-optimization-v2.md): 36-case authored template grid, conservative classifier and professional guard, edit-safe retry, 144 synthetic combinations, performance benchmark.
- [Backend optimization v2](https://github.com/1998x-stack/projects/blob/main/projects/productivity/anti-procrastination-todo/reports/backend-optimization-v2.md): IndexedDB snapshot invariants and loopback-only event API reference, security/auth/retention/test contract, PostgreSQL blueprint.

## Remaining high-priority work

- Restore/import JSON snapshots with schema validation and conflict strategy.
- Stronger fault-injection QA for quota exhaustion, interrupted browser upgrade and schema migration; multi-device Safari/Firefox manual testing.
- Extend undo beyond the most recent unstarted batch, add richer Task editing while preserving version checks.
- Keyboard and screen-reader audit against WCAG 2.2 AA on real assistive technology.
- Prove the prototype's effect on difficult-task start rate against a simpler baseline; measure pressure complaints.
- Only after evidence: consider AI suggestions, task-manager integration, cross-device account/sync.

## Engineering release discipline

The repository can be run locally and tested through CI. **Do not market as a finished product** until browser/device tests, privacy review and user-study gates pass. Use GitHub issues/PRs for individual remaining items. No retention, conversion, medical or user-outcome data has been measured.
