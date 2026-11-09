# Frontend

Accessible single-task experience and local timer controls; no runtime dependencies.

## Calm Focus v2

UI screens remain native ES Modules, with all mutable Task/Step/Session logic in `../domain` and all persistence in `../persistence`. Design tokens and responsive patterns are maintained in [UI-DESIGN-SYSTEM.md](../../docs/UI-DESIGN-SYSTEM.md). The four-stage progress element is informational; `aria-current` marks the current stage and it does not imply task completion. A visible countdown can be hidden without affecting time recording.

The default warm-light UI and optional dark visual theme share semantic CSS variables; the theme preference is local-only and does not modify task data. Read [browser UI tests](../../tests/browser/ui.spec.js) to reproduce tested states.
