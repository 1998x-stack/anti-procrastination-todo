# Code categories

| Folder | Responsibility |
| --- | --- |
| [algorithm](algorithm/) | Local deterministic suggestions, no AI calls or psychological diagnosis |
| [domain](domain/) | Pure Task / Step / Session transitions and invariants |
| [persistence](persistence/) | Transactional IndexedDB source of truth, export, multi-tab notifications |
| [frontend](frontend/) | Accessible responsive interface, timers and recovery |
| [backend](backend/) | Future opt-in research event contract only; no task storage API |

Tests are organized under `tests/`. See [implementation plan](../docs/IMPLEMENTATION.md).
