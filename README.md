# Start-First · 先开始

[![CI](https://github.com/1998x-stack/anti-procrastination-todo/actions/workflows/ci.yml/badge.svg)](https://github.com/1998x-stack/anti-procrastination-todo/actions/workflows/ci.yml)

**A local-first productivity prototype for starting one difficult task, not managing a larger backlog.**

> 当你明知道有件重要的事却难以开始，Start-First 帮你把它变成一个 2–5 分钟内可以动手的小动作。不必注册，也不用立刻做完全部。

**Stage:** runnable MVP engineering prototype · Not a validated product or medical intervention. No claim of effectiveness, retention, customer adoption or PMF.

## What works

| Feature | Implementation |
| --- | --- |
| Fast capture | Single task, multi-line paste, import preview (up to 20 entries), recent-batch undo |
| One-task focus | Exactly one active parent task; edit, archive and return to the inbox |
| Identify a blocker | Five selectable reasons + skip, without diagnosis or profiling |
| First action | Algorithm v2: 36 blocker × kind cells, conservative classifier, safe fallbacks, editable proposals, outcome-specific smaller retries |
| Short session | 2/5/10-minute timer, pause, resume, end, hidden display and safe reload recovery |
| Gentle reflection | Step done / partial / not started / parent task done are distinct |
| Reliable local data | IndexedDB atomic snapshot transactions; v2 pre/post-commit snapshot invariants, duplicate-command guard, cross-tab conflict prevention, JSON export and deletion |
| Privacy | Task text stays in this browser; no account or active telemetry. Optional loopback-only research API reference is separate and not deployed |
| Calm Focus UI v2 | Warm editorial layout, four-stage guide, blocker cards, calm circular session timer, descriptive review, responsive mobile UI and persistent visual theme |

**Honest limitations:** Browser data may be erased by clearing site storage or private browsing. Exported JSON is a portable snapshot but **import/restore is not implemented yet**. Switching away from the page pauses confirmed foreground time; time in another app is not treated as verified work. No cloud sync, AI API, scheduled reminders or server-side research metrics are running.

## Try it locally

The app is intentionally dependency-free **at runtime**. You need a current browser and a simple static HTTP server (opening index.html as file:// may restrict ES module imports).

~~~bash
git clone https://github.com/1998x-stack/anti-procrastination-todo.git
cd anti-procrastination-todo
python3 -m http.server 4173
# Open http://127.0.0.1:4173/
~~~

Automated unit tests require Node.js 20+; browser tests use a development-only Playwright dependency:

~~~bash
npm test                 # Node.js domain, algorithm, persistence-contract and privacy schema tests
npm run check            # Syntax checks
npm run verify           # Syntax + unit tests
npm run benchmark:algorithm  # 12,000 synthetic suggestion/classification calls
npm install
npx playwright install chromium
npm run test:e2e         # Local Chromium end-to-end tests
~~~

GitHub Actions runs Node unit/contract tests, Chromium E2E and an informational algorithm microbenchmark on pushes to main and on pull requests. UI tests also save synthetic desktop/mobile/focus/timer/review screenshots as workflow artifacts. A passing CI does not replace cross-device or real-user testing.

## Code categories / Repository map

~~~text
.
├── index.html                  # Static app entry
├── assets/                     # Brand assets
├── code/
│   ├── algorithm/              # Offline first-step suggestion engine
│   ├── domain/                 # Pure Task / Step / Session state and guards
│   ├── persistence/            # IndexedDB transaction-backed state and export
│   ├── frontend/               # Responsive UI, timer, recovery, styles
│   └── backend/                # Local-only opt-in event reference server + SQL plan; not deployed
├── tests/
│   ├── *.test.js               # Node unit and contract tests
│   └── browser/                # Chromium browser flows
├── docs/
│   ├── IMPLEMENTATION.md       # Phases and decisions
│   ├── TESTING.md              # Test matrix and known unverified scenarios
│   └── UI-DESIGN-SYSTEM.md     # Calm Focus v2 design tokens, flows and QA
└── .github/workflows/ci.yml   # Automated validation
~~~

See [code responsibilities](code/README.md), [implementation phases](docs/IMPLEMENTATION.md), [Calm Focus UI/UX design system](docs/UI-DESIGN-SYSTEM.md), and [testing coverage](docs/TESTING.md).

## Architecture

~~~text
UI (browser)
  ↓ commands + confirmed user input
Pure domain: Task → Step → Session
  ↔ deterministic suggestion algorithm (no LLM call)
  ↓ one atomic local transaction
IndexedDB: source of truth
  ↓ optional user export
JSON file on the user's own device

Optional research reference: loopback-only and disabled by default
Production backend: NOT DEPLOYED
~~~

- **One parent task ≠ one completed step.** A completed Step never marks a Task done automatically.
- **One session at a time.** Concurrent IndexedDB readwrite transactions prevent duplicate running sessions; BroadcastChannel only prompts other tabs to refresh.
- **No save confirmation before commit.** Operations succeed only when the database transaction completes. A failed write returns an error instead of faking success.
- **Timer honesty.** Tab visibility changes pause verified foreground time; after an unexpected restart, uncertain background time is not added to the recorded duration.
- **User agency.** Rules are suggestions, not instructions; the text is editable and not sent to an AI or analytics service.

## Product source of truth

The product research and approved design assumptions live in the portfolio repository:

- [Original Hacker News / Product Hunt research](https://github.com/1998x-stack/projects/blob/main/projects/productivity/anti-procrastination-todo/reports/research-2026-11.md)
- [Product Requirements Document v1.0](https://github.com/1998x-stack/projects/blob/main/projects/productivity/anti-procrastination-todo/reports/prd-mvp-v1.0.md)
- [76-item MVP functional specification](https://github.com/1998x-stack/projects/blob/main/projects/productivity/anti-procrastination-todo/reports/mvp-functional-spec-v1.0.md)
- [Algorithm optimization v2](https://github.com/1998x-stack/projects/blob/main/projects/productivity/anti-procrastination-todo/reports/algorithm-optimization-v2.md) · [Backend/data optimization v2](https://github.com/1998x-stack/projects/blob/main/projects/productivity/anti-procrastination-todo/reports/backend-optimization-v2.md)
- [Algorithm architecture](https://github.com/1998x-stack/projects/blob/main/projects/productivity/anti-procrastination-todo/reports/architecture-algorithm-v1.0.md) · [Backend architecture](https://github.com/1998x-stack/projects/blob/main/projects/productivity/anti-procrastination-todo/reports/architecture-backend-v1.0.md) · [Frontend architecture](https://github.com/1998x-stack/projects/blob/main/projects/productivity/anti-procrastination-todo/reports/architecture-frontend-v1.0.md)

## Scope and next gates

The initial stack uses **browser ES modules instead of React/TypeScript**, intentionally avoiding dependencies until the action-first loop is useful and trustworthy. Module boundaries permit replacing the UI layer later without rewriting domain semantics.

**Not yet implemented:** production server-side opt-in research event collection (reference loopback-only HTTP service exists, but is not connected), recoverable JSON import, PWA offline cold start, external TODO integrations, accounts/sync, or clinical/behavioral effectiveness validation. Detailed accessibility, mobile Safari and low-end device QA remain release gates.

**License:** No open-source license has been selected. Public source visibility is not a license grant; choose and add a license before inviting external reuse.
