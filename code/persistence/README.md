# Local Data Persistence & Invariants

User Task/Step/Session data is stored only in the browser's IndexedDB, in a single-versioned snapshot. Readwrite transactions serialize concurrent writes; duplicate command IDs are idempotent, and BroadcastChannel is only a refresh notification.

**v2 hardening:** `invariants.js` validates schema version, unique identities, parent/step/session references, exactly one active Task and outstanding Session, legal status and nonnegative time. The repository validates before and after each mutation and refuses async commands. Invalid stored data is **not** silently replaced with an empty state.

Tests: `tests/store.test.js`, `tests/invariants.test.js`, concurrent-client browser test in `tests/browser/flow.spec.js`.

This snapshot storage strategy is simple but O(N) in copy/write size; benchmark larger datasets on real devices before splitting stores. Export exists; restore/import and cloud backup do **not**. See [backend/data design v2](https://github.com/1998x-stack/projects/blob/main/projects/productivity/anti-procrastination-todo/reports/backend-optimization-v2.md).
