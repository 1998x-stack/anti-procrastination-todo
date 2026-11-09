# Tests

Node.js 20+:

~~~bash
npm run verify
~~~

For browser E2E, use Node.js + Python 3 and install the development-only Playwright runner:

~~~bash
npm install
npx playwright install chromium
npm run test:e2e
~~~

Unit tests cover the algorithm, Task/Step/Session invariants, in-memory transaction contract and opt-in event schema. Playwright tests serve the actual app over HTTP and exercise IndexedDB, UI actions, privacy boundaries and multi-client concurrency. GitHub Actions runs both jobs on each main push/PR.

See [test coverage and gaps](../docs/TESTING.md).
