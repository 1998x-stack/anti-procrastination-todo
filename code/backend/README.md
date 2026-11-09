# Optional backend · Loopback-only research reference

**No backend is connected to the MVP browser.** Task title/note/Step/session body never leaves the browser; no user analytics is active.

This folder now contains a **local-only, non-production in-memory HTTP reference** for a future *separately consented* research service:

| File | Purpose |
| --- | --- |
| `event-schema.js` | Strict event and attribute enum allowlists, no free text |
| `telemetry-service.js` | Random write/deletion credentials, SHA256 hashes, registration, idempotent event batches, revocation, retention |
| `server.js` | Explicit HTTP routes, 64KiB size cap, security headers, fixed errors |
| `dev-server.js` | Disabled by default; loopback-only when explicitly enabled |
| `schema.sql` | PostgreSQL **proposal**, not executed or connected |

Run only on a developer-controlled machine:

~~~bash
START_FIRST_LOCAL_TELEMETRY=1 node code/backend/dev-server.js
npm test
~~~

**Do not expose this server publicly:** its data is volatile; there is no durable DB adapter, trusted consent UX, production rate limiting, governance/audit, backup/deletion schedule, or proven compliance. A consent field in a request is not proof of valid user permission. Development tests must use synthetic events only.

See [backend optimization design v2](https://github.com/1998x-stack/projects/blob/main/projects/productivity/anti-procrastination-todo/reports/backend-optimization-v2.md) and `tests/telemetry-service.test.js`.
