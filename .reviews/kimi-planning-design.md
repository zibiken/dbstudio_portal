**ASCII wireframe (desktop)**

```
┌─────────────────────────────────────────┐
│                                         │
│   ●── Phase 2: Build                    │
│   │   [phase-in-progress]               │
│   │   Started 12/05/2024                │
│   │   3 of 10 done    [Show checklist]  │
│   │                                     │
│   ●── Phase 1: Discovery                │
│       [phase-done]                      │
│       Completed 01/04/2024              │
│       8 of 8 done     [Show checklist]  │
│                                         │
└─────────────────────────────────────────┘
```
`│` = rail connector line; `●` = node. Last phase has no descender.

---

**EJS partials**

1. `partials/customer/timeline.ejs`
   - **In:** `phases` (pre-filtered: no `not_started`, chronological order).
   - **Out:** wrapper `<ol>` with the rail and a loop of phase cards.

2. `partials/customer/timeline-phase.ejs`
   - **In:** `phase` object, `isLast` boolean.
   - **Out:** timeline item containing the node, status pill, dates, checklist summary string, and a `<details>` expander.

3. `partials/customer/checklist.ejs`
   - **In:** `items` array (label, done boolean, visible_to_customer hint string).
   - **Out:** checklist list for inside the open `<details>`.

---

**Tokens & class names**

*Reuse existing:*  
`--bg-light`, `--fg-on-light`, `--fg-on-light-muted`, `--border-light`, `--radius-md`, `--c-success`, `--s-1`…`--s-12`, `--f-xs`, `--f-sm`, `--f-md`, `--f-lg`, and the existing `status-pill--phase-*` classes.

*NEW classes (prefix `customer-timeline__`):*
- `.customer-timeline` — list reset / positioning context
- `.customer-timeline__item` — flex row aligning node + card
- `.customer-timeline__rail` — absolute left track (line via pseudo-element, color `--border-light`)
- `.customer-timeline__node` — circular dot (`--s-3`, filled `--fg-on-light`)
- `.customer-timeline__card` — content container (`--bg-light`, 1px `--border-light`, radius `--radius-md`)
- `.customer-timeline__header` — title + pill row
- `.customer-timeline__title` — phase label (`--f-md`, weight 600)
- `.customer-timeline__meta` — dates (`--f-sm`, `--fg-on-light-muted`)
- `.customer-timeline__summary` — checklist count line (`--f-sm`)
- `.customer-timeline__details` — native `<details>` wrapper
- `.customer-timeline__checklist` — item list
- `.customer-timeline__checklist-item` — row with icon + label + optional hint
- `.customer-timeline__checklist-item--done` — icon color `--c-success`
- `.customer-timeline__hint` — visible-to-customer note (`--f-xs`, `--fg-on-light-muted`)

---

**Key copy strings**

- Empty state: *“No active phases to display. Check back once work has started.”*
- Checklist summary: *“<%= done %> of <%= total %> done”*
- Details summary: *“Show checklist”*
- Date labels: *“Started <%= date %>”* / *“Completed <%= date %>”*

---

**Spacing & typography scale**

- Timeline gap between items: `--s-6`
- Rail width desktop: `--s-8`; mobile: `--s-4`
- Node size: `--s-3` (mobile can remain `--s-3` or `--s-2`)
- Card internal padding: `--s-4`
- Card corner radius: `--radius-md`
- Phase title: `--f-md` (600 weight)
- Dates / summary / checklist body: `--f-sm`
- Hint text: `--f-xs`
- Respect `prefers-reduced-motion: reduce`; no custom motion required.

---

**Recommendation for 30+ items**

Inside the expanded `<details>`, split the list into two visually separated groups—**“Outstanding”** followed by **“Completed”**—so customers immediately see remaining work without pagination or virtualization.
