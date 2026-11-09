# Algorithm v2 · Deterministic First-Step Engine

**Implemented:** `suggest.js` now covers all **36 blocker × task-kind cells**, each with ≥2 authored candidate templates, conservative Chinese/English classification, ambiguity fallback, professional-context guard and stable index rotation. No LLM, diagnosis or external calls.

**Retry:** `proposeRetry` accepts only `partial` or `not_started`, suggests a smaller action, and does not commit anything. The UI asks for user confirmation and preserves old Step/Session history.

**Safety:** Does not interpolate Task text into recommendations; task text stays in local IndexedDB. Time suggestions are attempt lengths, not completion predictions.

**Verification:** `tests/algorithm.test.js`, `tests/algorithm-regression.test.js` (144 synthetic task×blocker combinations), `tests/browser/retry.spec.js`, and `npm run benchmark:algorithm`.

See [algorithm optimization design v2](https://github.com/1998x-stack/projects/blob/main/projects/productivity/anti-procrastination-todo/reports/algorithm-optimization-v2.md). Actual procrastination improvement remains untested.
