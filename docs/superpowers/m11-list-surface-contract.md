# M11 — List-surface contract

> **Authored:** 2026-04-30 in Task 15. **Owners:** all M11 list / table surfaces (admin and customer). **Inheritors:** T17 customer dashboard (bento grid mirrors empty-state shape), T18a/b customer per-section pages, T19 admin profile sessions/audit lists. T22 final sweep validates against this doc.

This is the canonical pattern for any view that renders zero-or-many rows from a query. T15 codifies it after operator polish review on T13 — the goal is that every list surface across the portal feels like one designer made one set of decisions, not seven independent passes against the same tokens.

---

## 1. Spacing rhythm

The vertical sequence on a list page is **always**:

1. `_page-header` (eyebrow + title + optional subtitle + optional actions)
2. `_admin-customer-tabs` (only on per-customer subroutes)
3. **gap: --s-6** (built into the layout above)
4. `_list-toolbar` (search + result-count line + optional CTA)
5. **gap: --s-6** between toolbar and table-or-empty-state — owned by `.list-toolbar__count` margin-bottom (do NOT add an extra margin-top on the next sibling)
6. `<div class="table-wrap">` with `.data-table` **OR** `_empty-state` (mutually exclusive)
7. **gap: --s-8** between table and pagination (owned by `.pagination` `padding-block`)
8. `_pagination` (renders nothing if `totalPages <= 1`)

Token mapping for these gaps:

| Gap | Token | Pixels (at base scale) |
|---|---|---|
| Page-header → toolbar | `--s-6` | 24 |
| Toolbar → table / empty-state | `--s-6` (via `.list-toolbar__count` `margin-bottom: --s-6`) | 24 |
| Table → pagination | `--s-8` (via `.pagination` `padding-block: --s-8`) | 32 |
| Empty-state internal padding | `--s-12` `--s-6` (via `.empty-state` `padding`) | 48 24 |
| Empty-state icon → headline | `--s-2` (via `.empty-state__icon` `margin-bottom`) | 8 |
| Inside `.empty-state` between blocks | `--s-3` (via `gap`) | 12 |

**Why these specific values:** they match the rhythm rendered by `https://dbstudio.one`'s capability-section grid (24 / 24 / 32 / 48). The 48px internal padding on `.empty-state` is what makes the panel feel like a "destination" and not a placeholder error — operator visual review on T13 specifically called out the cramped feel of the previous bare-row pattern.

---

## 2. The `_list-toolbar` partial

**File:** `views/components/_list-toolbar.ejs`

Replaces the previous `<form class="form-inline">` pattern. Locals:

- `action` — form GET target (where the search submits)
- `q` — current search term (for input value + result-count copy)
- `total` — total count (drives the result-count line)
- `totalLabel` — singular noun ("customer", "invoice", "NDA"). Plural is auto-derived (`y → ies`, otherwise `+ s`).
- `placeholder` — input placeholder
- `ctaHref`, `ctaLabel` — optional primary "New …" CTA on the right

Shape:

```
[ Search [ 🔍 input ] [ Search ] [ Clear ] ]      [ + New customer ]
N customers for "search term".
```

The "Clear" button only renders when `q` is non-empty. The result-count line uses the singular/plural correctly: "1 customer", "12 customers", "No customers yet", "No customers match \"foo\".".

**Do not** put margin-bottom on `.list-toolbar` itself — the `.list-toolbar__count` line owns that gap so the spacing is consistent whether or not search is populated.

---

## 3. The `_empty-state` partial

**File:** `views/components/_empty-state.ejs`

Replaces every previous bare-`<div class="data-table__empty">` block. Locals:

- `headline` (required) — short noun phrase: `"No customers yet"`, `"No NDAs yet for {name}"`, `"No invoices match this search"`
- `lead` (optional) — one or two sentences explaining what populates the list (the *next action*, not the past lack)
- `ctaHref`, `ctaLabel` (optional, must come as a pair) — primary CTA, e.g. "Add the first customer"
- `secondaryHref`, `secondaryLabel` (optional pair) — ghost-button secondary, e.g. "Clear search"
- `icon` (optional, raw SVG) — overrides the default empty-table glyph; pass a contextual icon (e.g. document for documents, key for credentials) when it noticeably improves recognition

### Copy register

| Situation | Pattern |
|---|---|
| Resource never populated | "No {plural noun} yet" / "No {plural} yet for {customer}" |
| Search hit zero | "No {plural} match this search" |
| First action available | CTA: "Add the first {noun}" / "Generate the first draft" / "Open the first request" |
| Cleared-search escape | secondaryLabel: "Clear search" |

The lead paragraph is **always present** if there's room — it's the line that turns a dead-end into a guided next step. Keep it ≤ 52ch (the partial's max-width) and slightly formal: "Customers added here are invited by secure email — they receive a single-use link to set their password and register an authenticator app."

---

## 4. The `_pagination` partial

**File:** `views/components/_pagination.ejs`

Locals: `page`, `totalPages`, `q` (optional), `perPage` (optional), `qs` (function — see `routes/admin/customers.js#buildQs`).

Renders nothing when `totalPages <= 1` (no "Page 1 of 1" noise).

Shape: `[← Previous]   Page 2 of 7   [Next →]`. Disabled state on first/last preserves the layout (Previous on page 1 is rendered as `pagination__link--disabled`, no href, `aria-disabled="true"`).

The chevron icons are inline SVG (matches the eye/eye-off pattern from VISUAL FIX 3). 16×16, current-color stroke.

---

## 5. The `_user-mention` partial

**File:** `views/components/_user-mention.ejs`

Used inside table cells for any "person" reference (primary contact on customer rows, NDA representative, project lead, etc.). Locals: `name`, `email`. Either or both may be empty; renders `—` if both empty.

Shape:
```
Alice Anderson
alice@example.com    ← muted, smaller
```

NOT to be confused with DB Football's `<UserMention>` JSX component (different repo, different runtime). The portal is server-rendered EJS — there's no client-side component layer.

---

## 6. Table chrome

The `.data-table` partial (and any inline `.data-table` markup) carries the polished tweaks added in T15:

- **Headers** rendered as small caps (mono, uppercase, ls-upper, --fg-on-light-muted, --f-xs). Header content stays sentence-case in the partial locals (e.g. `label: 'Company name'`); the CSS does the visual styling. Do NOT pre-uppercase the strings.
- **Row hover** — full-row background tint to `--bg-light-alt`. Subtle, not a hard highlight.
- **Cell links** — inherit `--c-obsidian` ink colour, no underline by default; on hover switch to `--c-moss` with underline-offset 3px. Focus-visible draws a 2px moss outline at offset 2px (keyboard affordance).
- **Zebra stripes** kept (existing rule). Hover takes precedence over zebra (CSS specificity is intentional).
- **Empty `<td>`** — render `<span class="muted">—</span>`, never an empty cell. The em-dash in muted ink is the canonical "no value here" marker.

---

## 7. Hover + focus states (cross-cutting)

- **Focus ring** on inputs, buttons, links, table-cell anchors: 2px solid `--c-moss` at 2px outline-offset (or, on inputs, 3px box-shadow at `rgba(47, 93, 80, 0.18)`). Never `outline: none` without a replacement.
- **Hover transitions** are 150ms `--ease-base`. Reduced-motion partner (`@media (prefers-reduced-motion: reduce)`) MUST disable transitions on any motion-bearing component (already enforced by T19's `scripts/a11y-check.js` extension).

---

## 8. Copy register — Spanish stored, English displayed

The portal stores Spanish-language column names (legal-document context). Display is always English. Mapping (canonical):

| DB column | English display label |
|---|---|
| `razon_social` | Company name (helper: "Razón social — the legal name on file.") |
| `nif` | Tax ID (helper: "CIF / NIF for Spanish entities, or the equivalent.") |
| `domicilio` | Registered address (helper: "The address that appears on invoices and the NDA.") |
| `representante_nombre` | Full name (under "Legal representative (NDA)" group) |
| `representante_dni` | National ID (DNI) |
| `representante_cargo` | Position / title |
| `objeto_proyecto` | Description (project list / detail) |

The Spanish term is referenced in the `helper` string only — to give Spanish-speaking operators the bridge between the form and the legal-document terminology — never as the primary label.

---

## 9. Admin Documents + Credentials list views (added in T15)

The admin customer tab strip used to point Documents and Credentials at GET routes that didn't exist (404). Both list views landed in T15:

- **`/admin/customers/:id/documents`** — `routes/admin/documents.js`. Reads from `listDocumentsByCustomer`. Columns: File · Category · Size · Uploaded. Empty-state CTA → `/documents/new`.
- **`/admin/customers/:id/credentials`** — new `routes/admin/credentials.js`. **Metadata only.** Per M7 spec §2.4 the credential payload is encrypted with the customer's DEK and the server never holds it in cleartext outside the customer's own request scope; the admin surface deliberately shows only label, provider, origin, freshness, and timestamps. Decryption stays customer-side. Columns: Label · Provider · Origin · Freshness · Created · Updated. Empty-state CTA → "Open a credential request" (the admin's actual mechanism for asking for a credential).

The credentials list carries a leading info alert that states "metadata only — decrypted values live behind the customer's vault unlock and are never readable from this surface" so any operator who lands here understands the security boundary without having to dig into the spec.

---

## 10. How T17 / T18 inherit this

- **T17 customer dashboard** — the bento card for each section uses the empty-state copy register (§3) for sections with zero rows ("No NDAs yet" with a "View NDAs" link). The card's internal padding uses the same `--s-6` rhythm.
- **T18a admin/customer NDAs / Documents / Invoices / Projects** — all list surfaces, all use `_list-toolbar` + `_empty-state` + `_pagination` directly.
- **T18b admin/customer Credentials / Credential-requests / Activity / Profile** — same partials. The credentials reveal modal contract from M7 (30s countdown + clipboard copy + auto-mask) is preserved verbatim — DO NOT change.
- **T19 admin profile sessions table + audit list** — both use the same partials. The audit list's metadata-detail modal is `<dialog>`-based, separate concern.
- **T22 final sweep** — the dryrun walk validates every restyled surface against this doc; any drift is fixed inline before signing off v1.0.

---

## 11. Page-header harmonisation (added in T15 follow-up)

Every restyled surface uses the same page-header skeleton: **eyebrow + title + subtitle**, NO `actions` slot. The `.page-header` carries a `min-height` so headers don't shift between tabs even when one tab has more chrome below.

- **Status pills, "Edit details" buttons, and any per-surface badge** belong in a small status-strip rendered *below* the sub-tabs (see `.detail-status-strip` on `views/admin/customers/detail.ejs`), not in the page-header `actions` slot.
- The `_list-toolbar`'s "+ New …" CTA is the canonical place for "create a new X" actions on list pages — not in the page-header.
- Sub-pages where the title alone tells the whole story (Edit, New) skip the status-strip.

This eliminates the "menu jumps" the operator caught in T15 review: the sidebar (now sticky on desktop) stays put, and the page-header itself doesn't change height between tabs because `actions` was the only variable.

The detail tabs (`Overview`, `Edit`) and list tabs (`NDAs`, `Documents`, etc.) all wrap their primary content in `.card` blocks (`.card__title` + optional `.card__subtitle`), so the visual rhythm matches whether the tab is a form, a table, or a kv definition list.

---

## 12. Sub-tab strip on mobile

`.subtabs` switches to `flex-wrap: wrap` at ≤768px so the 8 sub-tabs reflow to two rows instead of horizontally scrolling. The `overflow-x: auto` rule is kept as defence in depth in case future tab counts blow out the row count, but `flex-wrap: wrap` is the primary mobile behaviour.

---

## 13. Responsive behaviour (added in T15)

All list-surface partials carry mobile breakpoints at ≤640px:

- **`.list-toolbar`** — flex-direction column at ≤640px. Search input fills width, Search/Clear buttons split width 50/50, "+ New …" CTA stacks at full width below the search row.
- **`.empty-state`** — internal padding scales to `--s-8 --s-4`, headline drops to `--f-lg`, action buttons stack vertically and stretch full-width.
- **`.kv` definition lists** — collapse to single column (dt above dd) at ≤640px so a long value never crushes the label column to nothing.
- **`.page-header`** — title scales from `--f-3xl` to `--f-2xl`, actions block stacks below.
- **`.subtabs`** — already had `overflow-x: auto`; pre-existing behavior preserved.
- **`.data-table`** — already had a 768px breakpoint that turns rows into vertically-stacked cards; pre-existing behavior preserved.

The chrome itself: `_top-bar` already has the hamburger toggle visible below 1024px and `_sidebar-admin` / `_sidebar-customer` start collapsed on mobile (toggled in/out via the inline script in the layout).

When adding a new list surface, you should NOT need to write fresh responsive CSS — using the four partials inherits all of the above for free.

---

## 14. Don't

- **Don't add ad-hoc spacing** between toolbar and table. The `.list-toolbar__count` margin-bottom owns it.
- **Don't pre-uppercase column headers in the locals**. The CSS does it. Pre-uppercasing breaks the accessible-text reading for screen readers.
- **Don't use `_table`'s `emptyState` string** for full-list surfaces. That partial keeps the inline text-only empty for *sub-tables* (e.g., the Users sub-table on customer detail). For full lists, render `_empty-state` outside an `if (rows.length)` branch.
- **Don't translate brand names**. "DB Studio" and "DB Studio Portal" stay verbatim across all locales.
- **Don't add the legacy `.form-inline` class** to new surfaces. It's kept only so any unrestyled view doesn't crash; remove the rule entirely once the last caller is migrated (probably T19).
