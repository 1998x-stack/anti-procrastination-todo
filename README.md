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
| Deployable | No-build static artifact + versioned releases, atomic `current` switch, nginx security headers, 28 health checks, verified rollback and deployment-level browser verification |

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
npm ci                   # uses the committed package-lock.json
npm test                 # Node.js domain, algorithm, persistence-contract and privacy schema tests
npm run check            # Syntax checks
npm run verify           # Syntax + unit tests
npm run benchmark:algorithm  # 12,000 synthetic suggestion/classification calls
npx playwright install chromium   # first run on a new machine (browser build must match @playwright/test)
npm run test:e2e         # Local Chromium end-to-end tests (dev harness on 127.0.0.1:4173)
npm run verify:lab-api   # Lab-only research API checks (temporarily listens on 127.0.0.1:4317)
~~~

If the browser tests report `browserType.launch: Executable doesn't exist`, that is a **missing browser download, not a product failure** — run `npx playwright install chromium` first. See [gotchas](docs/gotchas.md) GOTCHA-006.

GitHub Actions runs Node unit/contract tests, Chromium E2E, an informational algorithm microbenchmark, the lab-only research API checks and a real **deployment smoke** (build release → nginx container → verify the served origin) on pushes to main and on pull requests. UI tests also save synthetic desktop/mobile/focus/timer/review screenshots as workflow artifacts. A passing CI does not replace cross-device or real-user testing.

## Deploy on Linux (static site)

The app is a no-build static site, so the deployment target is a plain static file server. This repository ships a reviewed, versioned deployment: an nginx container publishing an immutable release directory behind a `current` symlink, bound to **127.0.0.1 only** unless a public origin is explicitly authorized.

~~~bash
npm run deploy:linux        # build release + atomic switch + nginx -t + reload + 27 health checks
npm run deploy:healthcheck  # read-only health check
npm run test:deploy:scripts # isolated release/rollback fault-injection tests
npm run test:e2e:deployed   # verify the ACTUAL served origin (headers, CSP, IndexedDB, full flow)
deploy/rollback.sh --list   # rollback points
~~~

**Follow-up PR #2:** candidate nginx preflight, archived release-specific configs, automatic restoration after failed activation, safer default rollback, and refusal to auto-delete drifted containers. CI evidence is not a substitute for re-testing the actual Ubuntu host.

**Security gate:** 0.0.0.0 is not LAN-only access control. Plain HTTP permits in-transit JS modification; modified same-origin scripts could read IndexedDB. Verify firewall/TLS before real-user access (GOTCHA-024 OPEN).

~~~bash
npm run test:deploy:scripts   # offline deployment/rollback fault-injection contracts (no Docker needed)
npm run test:deploy:staging   # REAL Docker + nginx fault injection against an isolated staging root
npm run lab:mixed-version     # reproducible cross-release mixed-version experiment (GOTCHA-026)
~~~

Full runbook: [docs/deployment-linux.md](docs/deployment-linux.md) · Operational incident handbook for the next agent: [docs/gotchas.md](docs/gotchas.md) · Latest measured results: [docs/test-report.md](docs/test-report.md).

**Loopback-first is deliberate:** `crypto.randomUUID()` and other secure-context APIs require HTTPS or localhost, and IndexedDB is isolated per origin. A public deployment must terminate HTTPS before it is exposed; see gotchas GOTCHA-005 and GOTCHA-018.

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
│   ├── browser/                # Chromium browser flows
│   └── deployed/               # Verification of the real deployed origin
├── deploy/                     # Linux deployment scripts + nginx config
├── scripts/                    # Benchmark and lab-only API verification
├── docs/
│   ├── IMPLEMENTATION.md       # Phases and decisions
│   ├── TESTING.md              # Test matrix and known unverified scenarios
│   ├── UI-DESIGN-SYSTEM.md     # Calm Focus v2 design tokens, flows and QA
│   ├── deployment-linux.md     # Deployment runbook (topology, rollback, HTTPS)
│   ├── gotchas.md              # Incident/root-cause handbook for the next agent
│   └── test-report.md          # Dated results, environment and unverified gates
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
