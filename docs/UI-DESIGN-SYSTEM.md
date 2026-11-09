# Start-First UI / UX Design System v2 — Calm Focus

**Status:** implemented visual iteration, awaiting external user testing. **Date:** 2026-11-09.  
**Source of truth:** [Product PRD](https://github.com/1998x-stack/projects/blob/main/projects/productivity/anti-procrastination-todo/reports/prd-mvp-v1.0.md) and [MVP specification](https://github.com/1998x-stack/projects/blob/main/projects/productivity/anti-procrastination-todo/reports/mvp-functional-spec-v1.0.md).

## 1. The product emotion

**Calm Focus** — composed, optimistic, non-judgmental. A productive interface is one that lowers decision cost, not one that fills the user's screen with charts or guilt.

- **Not a scoreboard:** No public streak, failure count, leaderboard or automated deadline shame.
- **One clear choice per page:** Each state has one visually dominant next action and recoverable secondary actions.
- **Evidence of safety:** The data notice explicitly says *browser-local*, and explains clearing site data may lose tasks; don't equate local storage with encrypted backup.
- **User agency:** The first action is always editable; the user decides whether a Step or the parent Task was completed.
- **Focus and forgiveness:** Time is an optional support, not a measure of human worth; a hidden clock must stay fully functional.

## 2. Information architecture and screen narrative

| Screen | User question | Primary focus | Supporting pattern | Avoid |
| --- | --- | --- | --- | --- |
| Inbox / S0-S1 | What's hard to begin? | Large quick-capture form; clear resume when needed | Quiet 3-step method rail, task list, local-storage notice | Full project manager, dashboards, motivational nagging |
| Blocker / S2 | Why am I stuck? | Five descriptive selectable cards, skip option | Suggested micro-action with editable textarea and live character counter | Diagnosis, implicit profiling, mandatory AI |
| Ready / S3 preflight | What's the smallest commitment? | User-confirmed action, 2/5/10-minute choice and Start CTA | Four-step progress indicator | Turning time estimate into a completion guarantee |
| Active / S3 | What should I do right now? | Large current action and calm circular time visualization | Pause, end, hide-clock controls | Loud alarms, punitive countdown |
| Review / S4 | How did it go? | Four independently named outcome choices | Explicit distinction between Step and Task completion | "Success"/"failure" binary |
| Data settings / S5 | Where is my work? | Export, deletion, disabled telemetry status | Optional persistent light/dark visual preference | Hidden data risk, false cloud backup promise |

### Functional contracts retained during redesign

Existing public IDs and testable labels are intentionally retained: \`#capture-form\`, \`#capture-input\`, \`#step-form\`, \`#step-input\`, \`#timer-number\`, \`#timer-circle\`; all action buttons preserve their corresponding \`data-action\` handlers. No task, step or session domain semantic was changed by this design release.

## 3. Visual language and tokens

| Foundation | Design |
| --- | --- |
| Background | Warm low-contrast canvas \`#f7f7f2\`, limited ambient radial wash using CSS only |
| Primary surface | Soft white \`#fffefb\`, restrained border \`#d8e2d8\` |
| Core text | Evergreen ink \`#20392f\`, strong heading \`#142c24\` |
| Primary action | Forest green \`#235944\`; inverse text and high visibility |
| Support | Pastel lime \`#e4f0c8\` reserved for selections and step encouragement |
| Warning | Muted warm red only for destructive actions and actual errors |
| Type | Local system and CJK fallbacks, no remote webfonts and no external font requests |
| Density | 8/12/16/24/32px rhythm with >44px primary interaction height |
| Radius | 12–24px rounded cards and pill-shaped choice groups |
| Motion | Simple 150–200ms hover/focus transitions, disabled for reduced-motion preference |
| Dark mode | Semantic-token inversion, saved as an optional **appearance preference**, never affects task data |

All colors are intent tokens in \`code/frontend/styles.css\`. Accessibility contrast must be measured in target browsers rather than inferred solely from design intent.

## 4. Primary interaction behavior

**Inbox**: The first-time question takes precedence. Desktop has main capture and a secondary explanation panel; below 790px the explanation moves after the form. Below 560px actions expand for touch. Empty state helps start, without looking like an error.

**Blocker**: Two-column descriptive cards on large screens, large tap areas on small screens. Selection exposed via \`aria-pressed\` and accessible name. "Skip" covers the full row. Writing in the Step textarea updates \`N / 160\` without rerender or lost focus. Changing blocker or rotating a suggestion still protects a modified draft with confirmation.

**Ready**: No infinite backlog. The single confirmed action is displayed in higher-contrast typography, with the session duration directly below and a dominant Start button.

**Timer**: Circular progress visualization indicates **this session's elapsed fraction**, not percentage of Task completion. Display can be hidden. Visibility-change and refresh rules remain tied to the existing IndexedDB state; the browser does **not** infer verified concentration during hidden-tab time.

**Review**: Four outcomes are visually separated. An attempted or unfinished Step is not a failure; "Task done" is a distinct action with a second confirmation. No streak penalty or self-judgment label.

**Settings**: Appearance toggle is functional and persists only as a harmless local preference. Data export and deletion use existing semantics; telemetry is explicitly disabled.

## 5. Accessibility contract

1. Maintain keyboard operation of all primary controls; focus indication uses \`--focus\` with at least 3px outline.
2. After moving between screens, place focus on the new heading rather than dropping it silently onto the document body.
3. Show screen stage in a semantic \`nav/ol\` with \`aria-current="step"\`; the stages are **status indicators**, not clickable false navigation.
4. Every blocker button has an accessible name matching the visible title and indicates selected state with \`aria-pressed\`; descriptions are decorative for assistive technologies.
5. Timer numbers use \`role="timer"\` and \`aria-live="off"\`; the end-of-time status is announced separately, not every second.
6. Form fields use visible labels and \`aria-describedby\` hints; counter content is updated without stealing focus.
7. Never rely solely on color to distinguish selected, paused, failed save or completed states.
8. At 320/375px, CTAs stay in the viewport horizontally; test with 200% zoom and screen readers before a public release.
9. \`prefers-reduced-motion: reduce\` disables decorative animation and transition.

These are intended behaviors and automated checks. No independent WCAG compliance certification or assistive-technology study is claimed.

## 6. Verification and visual regression

\`tests/browser/ui.spec.js\` adds browser checks for:
- Desktop grid/hierarchy and no horizontal overflow.
- 320px and 375px mobile CTA reachability.
- Selected blocker, editable Step and live counter.
- Visible/hidden timer and pause state.
- Persistent light/dark theme without losing tasks.
- Review outcome accessibility and distinct parent completion.

The suite emits **synthetic-content screenshots only** in \`artifacts/\` (home desktop, mobile, first step, timer and review). The CI workflow retains the screenshot artifact for inspection. No real customer data should be included.

**QA before launch:** Manual iOS Safari and Android Chrome, Firefox, low-end device performance, screen readers, 200%/400% zoom, forced-colors mode, independent contrast check and 12–15 user usability interviews focused on the first-action flow.

## 7. Design decisions and limits

| Decision | Rationale | Open question |
| --- | --- | --- |
| CSS-only visual system | Fast static delivery; avoids network tracking and image weight | Would a custom editorial illustration materially improve comprehension? |
| Calm forest green | Supportive, non-alarmist identity; one CTA stands out | Should accent preference be user-customizable? |
| Prominent task capture | Move from intention into a concrete action without onboarding | Does adding example text improve or anchor task input? |
| Descriptive blocker cards | Offer useful choices without a psychological label | Are five cards too many for some users? |
| Visible Stage 1–4 | Show a short path to a tangible next action | Does stage navigation create pressure in this context? |
| Circular timer | Make duration perceptible but optional | Do some users prefer elapsed time or no timer at all? |
| Dark theme | Readability option, no account required | Verify long-form CJK contrast on multiple screens |

**Version notes:** v2 (2026-11-09) — visual tokens, desktop/mobile composition, first-step editor, session visuals, review hierarchy, local appearance preference and automated visual checkpoints. This release does **not** represent validated reduction in procrastination.
