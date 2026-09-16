# Design System

> Every value here is a token. If a screen needs a colour, size or radius that is not
> in this file, the answer is to change this file — not to write a literal in a
> component. The design system is part of the product architecture, not a cleanup task
> scheduled for later.

## 1. Principles

1. **Neutral ground, controlled accent.** The interface is mostly greys. Colour is
   information, so a dashboard that is colourful everywhere carries information
   nowhere.
2. **Every insight ends in a verb.** A number without a next action is a number the
   user has to interpret alone. See §12.
3. **Density follows the role.** One system, four densities: teacher and institute are
   information-dense; student and parent are calm.
4. **Motion is feedback, not decoration.** In the test player, motion is near-zero.
5. **AI is a capability, not a skin.** The ✦ mark and one tinted surface. No glow, no
   gradient sweeps, no "futuristic" chrome.
6. **Refuse rather than guess.** An empty chart says what is missing and how to fill
   it. A mastery figure with too little evidence is not rendered at all.

## 2. Colour

All tokens are CSS custom properties on `:root`, redefined for dark mode. Components
reference roles (`--text-secondary`), never ramp steps directly.

### 2.1 Neutral ramp

| Step | Light | Role |
|---|---|---|
| `neutral-0` | `#FFFFFF` | Surface |
| `neutral-25` | `#FAFBFC` | Raised surface tint |
| `neutral-50` | `#F5F7FA` | App canvas |
| `neutral-100` | `#EDF0F5` | Sunken, table header, skeleton base |
| `neutral-200` | `#DFE3EB` | Hairline border |
| `neutral-300` | `#C7CDD9` | Strong border, disabled fill |
| `neutral-400` | `#9BA3B4` | **Non-text only** — 2.53:1 on white. Icons ≥24px, borders, disabled glyphs. |
| `neutral-500` | `#5F6877` | Tertiary text — 4.92:1 on `surface-sunken`, 5.63:1 on white. Passes AA at any size. |
| `neutral-600` | `#545C6B` | Secondary text — 5.89:1 on `surface-sunken`, 6.73:1 on white |
| `neutral-800` | `#272C36` | Headings — 12.26:1 on `surface-sunken`, 14.00:1 on white |
| `neutral-900` | `#151922` | Primary text — 15.40:1 on `surface-sunken`, 17.59:1 on white |

Every ratio above names the background it was measured against, and the first
figure is the WORST real surface rather than the flattering one. `neutral-500`
used to be `#6E7787`, documented here as "4.51:1 — ≥14px only": that ratio was
measured against pure white, a surface the token is never used on, and on the
real ones it sat at 4.21:1 and 3.95:1. The size restriction was a mitigation for
a token that failed, so replacing the token retired the rule — this row said
otherwise for months afterwards, and cost a later reader three edits that were
not bugs.
| `neutral-950` | `#0B0D12` | Dark-mode canvas |

`neutral-400` failing text contrast is deliberate and documented. It is the colour
most likely to be misused for a caption; it is not a text colour.

### 2.2 Primary — Indigo

The brand hue. Trust and intelligence without arriving at "corporate SaaS blue".

| Step | Hex | Role |
|---|---|---|
| `primary-50` | `#F1F2FD` | Selected row, subtle wash |
| `primary-100` | `#E3E6FB` | Badge fill, chip |
| `primary-200` | `#C8CDF6` | Border on tinted surfaces |
| `primary-300` | `#A6AEEF` | Dark-mode text (8.31:1 on `neutral-900`) |
| `primary-500` | `#5F6BDA` | Hover on dark |
| `primary-600` | `#4A56D2` | **Default action.** 5.91:1 both as text on white and as fill under white text. |
| `primary-700` | `#3B45AE` | Hover / pressed (7.93:1 under white) |
| `primary-900` | `#2A3170` | Deep accent |

### 2.3 Semantic

Used for *state*, never for decoration and never for series identity.

| Role | Light text/icon | Light fill | Light border | Dark text/icon |
|---|---|---|---|---|
| Success | `#0F7A4D` (5.37) | `#E8F5EE` | `#A8DCC0` | `#4ABE86` (7.54) |
| Warning | `#9C5D00` (5.28) | `#FDF3E3` | `#F0CE95` | `#E0A81A` (8.20) |
| Danger | `#C2352B` (5.47) | `#FDECEA` | `#F3B6B0` | `#F0796E` (6.42) |
| Info | `#0B69B8` (5.63) | `#E8F2FB` | `#A9CDEE` | `#5FAEEA` (7.31) |

Ratios measured against `#FFFFFF` and `#151922`. All pass WCAG AA for body text.

**Semantic colour never travels alone.** Every semantic state ships an icon and a text
label. A red dot is not a message.

### 2.4 Mastery scale — the one place colour is quantitative

Mastery is the product's core number, so it gets a reserved, ordered scale that
nothing else may use:

| Band | Label shown to teacher | Label shown to student | Token |
|---|---|---|---|
| ≥ 0.80 | Secure | "You've got this" | `--mastery-secure` `#0F7A4D` |
| 0.60–0.79 | Developing | "Almost there" | `--mastery-developing` `#4A56D2` |
| 0.40–0.59 | Fragile | "Needs practice" | `--mastery-fragile` `#9C5D00` |
| < 0.40 | Critical | "Let's start here" | `--mastery-critical` `#C2352B` |
| insufficient evidence | **"Not enough evidence yet"** | same | `--mastery-unknown` `#9BA3B4` |

The fifth band is not a colour on a gradient; it is a refusal. It renders as a hatched
grey chip with no number. There is deliberately no way to make it look like a low
score, because "we don't know" and "they're failing" must never be confusable.

### 2.5 Chart series palette — validated, not chosen by eye

Run through `scripts/validate_palette.js` against this system's own surfaces
(`#FFFFFF` light, `#151922` dark). Both modes pass the lightness band, chroma floor,
CVD separation, normal-vision floor and contrast checks on the adjacent pairlist.

| Slot | Hue | Light | Dark |
|---|---|---|---|
| 1 | indigo | `#4A56D2` | `#7C86EE` |
| 2 | orange | `#E0662B` | `#D2612C` |
| 3 | teal | `#0E9E86` | `#12977F` |
| 4 | amber | `#D9A100` | `#BE8A00` |
| 5 | magenta | `#DB6FA0` | `#D2698F` |
| 6 | green | `#167C3E` | `#0A8A42` |
| 7 | violet | `#7A4FD6` | `#9B7BE8` |
| 8 | red | `#D6453F` | `#E4645E` |

Measured results — light: worst adjacent CVD ΔE 12.2, worst adjacent normal-vision
ΔE 22.0. Dark: worst adjacent CVD ΔE 11.0, normal-vision ΔE 18.3.

**Rules that come with it:**

- Slots are assigned **in fixed order and never cycled**. A ninth series folds into
  "Other" or becomes small multiples.
- **Series cap of 3 for all-pairs forms** (scatter, bubble, small multiples). Slots
  1–3 validate under `--pairs all` in both modes; the full eight do not.
- Slot 4 (amber, `#D9A100`) sits at 2.32:1 on white. The **relief rule** applies: any
  chart using it ships visible direct labels or a table view.
- Chart series colours are **not** the semantic colours. A green series is slot 6, not
  "success". Status colours never impersonate a series.
- **Sequential** encoding: one hue, indigo, light→dark. **Diverging** (improvement vs
  decline): indigo ↔ orange with a neutral `#EDF0F5` midpoint — never a hue at the
  midpoint, never a rainbow.
- **Never a dual-axis chart.** Two measures of different scale become two charts or an
  indexed common base.

### 2.6 Dark mode

Dark mode is *selected*, not an inverted flip. Tokens are redefined under both
`@media (prefers-color-scheme: dark)` (guarded with `:root:not([data-theme="light"])`)
and `:root[data-theme="dark"]`, so an explicit toggle wins in both directions.

Dark canvas `#0B0D12`, surface `#151922`, raised `#1C2130`, border `#2A3040`.

## 3. Typography

**Inter** (variable), fallback `system-ui, -apple-system, "Segoe UI", sans-serif`.
One family everywhere, including numerals. No display face.

| Token | Size / line-height | Weight | Use |
|---|---|---|---|
| `text-display` | 36 / 42 | 600 | Marketing, result hero score |
| `text-h1` | 28 / 36 | 600 | Page title |
| `text-h2` | 22 / 30 | 600 | Section heading |
| `text-h3` | 18 / 26 | 600 | Card heading |
| `text-body-lg` | 16 / 26 | 400 | **Question text — the reading default** |
| `text-body` | 15 / 24 | 400 | Interface default |
| `text-sm` | 14 / 20 | 400 | Table cells, secondary |
| `text-caption` | 13 / 18 | 400 | Metadata |
| `text-overline` | 11 / 16 | 600, `0.06em`, uppercase | Section eyebrow |
| `text-metric` | 32 / 38 | 600, `tabular-nums` | Stat card value |

Weights: 400 regular, 500 medium, 600 semibold. **No 700+** — heavier weights read as
shouting at these sizes and are the fastest way to make a professional tool look like
a consumer app.

`tabular-nums` is applied to table columns, axis ticks and stat values so digits
align; body prose keeps proportional figures.

**Question text is 16px minimum and never truncated.** A student reads questions for
three hours. Line length is capped at 68 characters.

## 4. Spacing, radius, elevation

**Spacing** — 4px base, 8px rhythm: `0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80`.
Page padding: 16px mobile, 24px tablet, 32px desktop.

**Radius** — one per kind of thing, so sibling elements stop disagreeing:

| Token | Value | Applies to |
|---|---|---|
| `radius-sm` | 6px | Badge, chip, tag |
| `radius-control` | 10px | Button, input, select, chip button |
| `radius-card` | 14px | Card, panel, list group |
| `radius-modal` | 18px | Modal, drawer, sheet |
| `radius-full` | 999px | Avatar, pill, progress track |

**Elevation** — four levels, and shadows are soft rather than dark. A UI with six
shadow levels has no shadow language at all.

| Token | Value | Use |
|---|---|---|
| `shadow-none` | — | Default. Most cards use a border, not a shadow. |
| `shadow-sm` | `0 1px 2px rgb(16 20 30 / .06)` | Raised card, table header on scroll |
| `shadow-md` | `0 4px 12px rgb(16 20 30 / .08)` | Dropdown, popover, tooltip |
| `shadow-lg` | `0 16px 40px rgb(16 20 30 / .14)` | Modal, drawer |

Default separation is `1px solid var(--border)`. Shadow is for things that float.

## 5. Motion

| Token | Duration | Easing | Use |
|---|---|---|---|
| `motion-instant` | 90ms | `ease-out` | Button press, checkbox |
| `motion-fast` | 150ms | `cubic-bezier(.2,0,0,1)` | Hover, tooltip, dropdown |
| `motion-base` | 220ms | `cubic-bezier(.2,0,0,1)` | Modal, drawer, tab change |
| `motion-slow` | 400ms | `cubic-bezier(.4,0,.2,1)` | Progress, chart draw-in |

`@media (prefers-reduced-motion: reduce)` collapses every duration to 0ms and removes
transforms; only opacity survives.

**The test player runs in reduced motion regardless of the OS setting.** A student
racing a clock does not need a card to slide.

## 6. Layout

12-column grid, 24px gutter. Content max-width 1440px; reading columns 720px.

| Breakpoint | Width | Behaviour |
|---|---|---|
| `sm` | < 640 | Single column, bottom tab bar, sidebar becomes a sheet |
| `md` | 640–1023 | Two columns, sidebar collapses to icons |
| `lg` | 1024–1439 | Full sidebar (240px), main content |
| `xl` | ≥ 1440 | Sidebar + main + 320px insight rail |

**Not a shrunken desktop.** A teacher's analytics table becomes a stack of student
cards on mobile — the same data, a different structure.

Minimum tap target 44×44px, enforced by an automated check in CI, not by inspection.

## 7. Components

Every component below has the full state set: `default, hover, focus-visible, active,
disabled, loading, error`. A component missing a state is not done.

**Focus is never removed.** `:focus-visible` draws a 2px `primary-600` ring at 2px
offset, on every interactive element, in both themes.

### Button

| Variant | Fill | Text | Border | Use |
|---|---|---|---|---|
| `primary` | `primary-600` | white | none | The one main action per view |
| `secondary` | `neutral-0` | `neutral-900` | `neutral-300` | Supporting actions |
| `ghost` | transparent | `neutral-600` | none | Tertiary, toolbar |
| `danger` | `#C2352B` | white | none | Destructive, always confirmed |
| `ai` | `--ai-surface` | `primary-700` | `primary-200` | Prefixed ✦. See §11. |

Sizes: `sm` 32px, `md` 40px (default), `lg` 48px (mobile primary). Loading state keeps
the button width and swaps the label for a spinner plus the verb in progress
("Generating…"), because a button that resizes mid-click moves the next one.

### Input, Select, Textarea

40px tall, `radius-control`, 1px `neutral-300` border, 12px horizontal padding.
Label always present above (never a placeholder as a label). Placeholder is
`neutral-500`. Error state: `#C2352B` border, message below with an icon, and
`aria-describedby` wired to it. Required fields marked in the label, not by colour.

### Card

`neutral-0` surface, 1px `neutral-200` border, `radius-card`, 20px padding,
`shadow-none`. Optional header row (title `text-h3`, action on the right) with a
16px gap. Cards do not nest more than one level.

### StatCard

Label (`text-overline`, `neutral-500`) → value (`text-metric`) → delta chip → optional
one-line context. The delta chip uses an arrow glyph **and** a sign, never colour
alone. **A StatCard with no evidence shows "—" and a tooltip explaining why**, never a
zero — 0% and "no data" mean opposite things to a teacher.

### DataTable

Sticky header (`neutral-100`, `text-overline`), 48px rows, hairline row dividers, hover
wash `neutral-25`. Numeric columns right-aligned and `tabular-nums`. Sortable headers
carry an explicit direction glyph. Row selection is a checkbox column. Below `md` the
table becomes a card list. Every table has: a search field, a filter bar, a column
visibility control, and an empty state naming the active filters.

### Tabs, Modal, Drawer, Dropdown, Tooltip

- **Tabs** — underline style, 2px `primary-600` indicator, `role="tablist"`, arrow-key navigation. Scrollable on mobile, never wrapped to two rows.
- **Modal** — `radius-modal`, `shadow-lg`, 520px default. Focus trapped, Escape closes, focus returns to the trigger. Title is an `h2`. Destructive modals require typing a matching word only when the action is irreversible for a whole class or larger.
- **Drawer** — right side, 480px, for detail-without-navigation (a student profile from a table row). Same focus rules. Becomes a bottom sheet below `md`.
- **Dropdown** — `shadow-md`, 8px radius, 40px items, keyboard-navigable, `aria-activedescendant`.
- **Tooltip** — 150ms delay, `neutral-900` surface, `text-caption`. **Never the only source of information**, because it does not exist on touch.

### Badge

`radius-sm`, `text-caption`, 500 weight, 2/8px padding. Variants: neutral, primary,
success, warning, danger, and `ai`. Difficulty badges are outline-only with a text
label ("Easy"), never a colour-only dot.

### Progress

- **ProgressBar** — 8px track (`neutral-200`), `radius-full`, fill by mastery band. Always labelled with the number beside it.
- **ProgressRing** — 96px, 8px stroke, value centred. Used for a single headline figure; never a row of five rings, which is a bar chart wearing a costume.
- **StepIndicator** — for the assessment builder. Numbered, shows completed / current / upcoming, and lets a user jump back to any completed step.

## 8. Empty states

Four required parts: an illustration-free icon, a sentence naming what is missing, a
sentence saying why it matters, and **at least one button**.

```
  ▢  Your question bank is empty

  Questions you add here can be reused in every
  assessment you build, by you and your team.

  [ Add a question ]   [ ✦ Generate with AI ]
```

"No data found" is never shipped. Empty states are written per module and reviewed as
copy, not filled in by a developer at the end.

## 9. Loading states

- **Skeletons**, matched to the real content's shape, for dashboards, tables and charts. Never a centred spinner on a full page.
- **Skeleton base** `neutral-100`, shimmer `neutral-50`, 1.4s, removed under reduced motion (static grey).
- **Optimistic** for local, reversible actions (mark for review, bookmark).
- **AI progress is a real checklist**, driven by actual pipeline stages, never a timed animation:

```
  Generating assessment…
  ✓ Blueprint built              (12 questions across 4 outcomes)
  ✓ Learning outcomes selected
  → Generating questions          8 of 12
  ○ Validating answers
  ○ Checking for duplicates
```

Fake progress is prohibited. If a stage's duration is unknown, show the stage name
without a bar.

## 10. Error states

Errors say what happened, what survived, and what to do next.

```
  We couldn't finish generating this assessment.

  The 8 questions already generated are saved as a draft —
  nothing was lost.

  [ Try the remaining 4 ]   [ Build them manually ]
```

Never a status code as the message. Never "Something went wrong." Every error surface
names the preserved state, because the user's real question is "did I lose my work?"

## 11. AI components

One tinted surface and one glyph. That is the whole vocabulary.

- `--ai-surface` `#F4F5FE` light / `#1A1E30` dark
- `--ai-border` `primary-200` / `#333A55`
- **✦** precedes every AI-initiated action label.

| Component | Shape |
|---|---|
| `AIActionButton` | `✦ Generate with AI` — the `ai` button variant |
| `AIInsightCard` | Overline `✦ AI INSIGHT`, 2–3 sentences of plain prose, then **an action button**. An insight card with no button is deleted, not shipped. |
| `AIGenerationProgress` | The stage checklist from §9 |
| `AIValidationChip` | Per-question verdict: `✓ Valid`, `⚠ Review suggested`, `✗ Rejected`, with the reason on the chip |
| `AIDisclosure` | A one-line footer under generated content: "Drafted by AI · Review before publishing" |

**What is prohibited:** glow effects, gradient borders, animated sparkles, typewriter
text, and an "AI" label on a feature that is a database query. Marketing a filter as
AI teaches users to distrust the parts that genuinely are.

## 12. The action rule

Reviewed on every screen before it is called done. A metric is only complete when it
answers *"what should I do next?"*

**Not this:**

```
  Geometry   54%
```

**This:**

```
  ⚠  Geometry needs attention

  15 of 40 students are below the mastery
  threshold. The weakest outcome is
  "Similarity of Triangles" (38%).

  [ View students ]   [ ✦ Create remedial test ]
```

## 13. Role densities

| | Row height | Base text | Card padding | Nav |
|---|---|---|---|---|
| Teacher | 48px | 15px | 20px | Sidebar 240px |
| Institute | 44px | 14px | 16px | Sidebar 240px |
| Student | 56px | 16px | 24px | Bottom tabs |
| Parent | 60px | 16px | 24px | Bottom tabs, 4 max |

Same tokens, different selections from them. There is no second design system.

## 14. Accessibility

Enforced, not aspired to:

- WCAG 2.2 AA contrast for all text. The ratios in §2 are measured, not estimated.
- Every interactive element reachable and operable by keyboard; visible focus always.
- Semantic HTML first: `button` for actions, `a` for navigation, real `table`, real `form`, real `fieldset` for a question's options.
- The test player's question navigator is a `nav` with `aria-label`, and each item announces state ("Question 4, answered", "Question 7, marked for review").
- Every chart has a table view behind a toggle. Colour is never the only encoding — legend plus direct labels.
- The timer announces at 10, 5 and 1 minute via `aria-live="polite"`, and is never the only warning.
- `prefers-reduced-motion` honoured globally.
- Target size ≥ 44×44px, checked in CI.

## 15. Component inventory

Built once, in `src/ui/`, before the screens that use them:

**Shell** — AppShell, Sidebar, TopBar, PageHeader, BottomTabs, InsightRail
**Data** — StatCard, DataTable, FilterBar, SearchInput, Pagination, ColumnPicker
**Feedback** — Toast, Alert, ConfirmDialog, EmptyState, Skeleton, ErrorBoundaryPanel
**Form** — Button, Input, Select, Textarea, Checkbox, Radio, Switch, Slider, DatePicker, ChipInput, FileDrop
**Overlay** — Modal, Drawer, Dropdown, Popover, Tooltip
**Domain** — AssessmentCard, QuestionCard, QuestionEditor, BlueprintEditor, StepIndicator, TestTimer, QuestionNavigator, OptionList, ResultSummary, MasteryCard, MasteryBar, GapCard, MistakeCard, RecommendationCard, StudentRow, StudentAvatar, ClassPicker, CurriculumPicker
**Charts** — ChartCard, TrendLine, ComparisonBars, MasteryHeatmap, DistributionBars, TableView
**AI** — AIActionButton, AIInsightCard, AIGenerationProgress, AIValidationChip, AIDisclosure, CopilotPanel

A pattern that appears twice becomes a component before it appears a third time.
