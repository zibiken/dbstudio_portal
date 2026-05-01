# Phase C — Invoice OCR auto-fill (design)

> **Status:** approved 2026-05-01 (operator). To be planned alongside Phase A (UI fixes) and Phase B (digest emails) in a single combined implementation plan.

## Why

Admins currently type six metadata fields (invoice number, amount, currency, issued-on, due-on, notes) by hand for every uploaded invoice PDF. The accounting platform that emits the PDFs uses a stable, predictable format across all three languages (NL/EN/ES). A small server-side parser can prefill ~95 % of these fields, turning the upload form into "drop file → review chips → save".

## In scope

- Server-side text extraction from the uploaded PDF using `pdf-parse` (no system deps, no external services).
- A tight, format-specific regex parser tuned to the operator's invoice template.
- A two-step AJAX UX in the admin "Upload invoice" form: pick file → POST to `/admin/invoices/parse-pdf` → prefill fields with "Auto-filled" chips → admin reviews → submit the regular upload form.
- Graceful degradation: partial extraction shows a banner; total miss is silent and indistinguishable from today's flow.

## Out of scope

- Tesseract OCR for scanned/image PDFs. Not needed today; can be added behind a feature flag later if a scan ever lands.
- External AI services (Document AI, Textract, OpenAI Vision). Conflict with the portal's isolation model.
- Any changes to the persistence pipeline once the form is submitted — `domain/invoices/service.create` is unchanged.
- Parsing line items, IGIC breakdowns, IBAN/BIC, customer details. v1 only extracts the five header fields.

---

## 1. Architecture overview

```
Admin form (admin/invoices/new.ejs)
        │
        │  1. <input type="file"> change event
        ▼
[ AJAX POST /admin/invoices/parse-pdf (multipart, in-memory only) ]
        │
        ▼
[ lib/invoice-parser.js — pdf-parse → regex → canonical JSON ]
        │
        ▼
{ invoice_number, amount_cents, currency, issued_on, due_on, lang, fields_found: 4 }
        │
        ▼
Admin form populates fields, attaches "Auto-filled" chips, shows
  partial-banner if fields_found < 5 (excluding currency).
        │
        ▼
Admin clicks "Upload invoice"
        │
        ▼
[ existing POST /admin/customers/:id/invoices — unchanged ]
```

The parse endpoint is **stateless and storage-free**: the PDF is streamed into a Buffer, parsed, the Buffer is dropped. Nothing is persisted. The admin still has to upload the file a second time on form submit; this is the intentional trade-off for security (no temporary file written to disk anywhere) and simplicity (no parse-id/upload-id correlation).

---

## 2. The parser (`lib/invoice-parser.js`)

### Dependency

Add `pdf-parse` to the production dependencies. Pure JavaScript, no native binding, ~50 KB. Tested input is the exact format emitted by the operator's accounting platform (sample reviewed during brainstorming).

### Public API

```js
import { parseInvoicePdf } from '../lib/invoice-parser.js';

const result = await parseInvoicePdf(buffer);
// {
//   ok: true,
//   lang: 'nl' | 'en' | 'es',
//   fields: {
//     invoice_number: '2026/002772',
//     amount_cents:   19800,
//     currency:       'EUR',
//     issued_on:      '2026-04-27',
//     due_on:         '2026-05-04',
//   },
//   fields_found: 5,           // count of non-null fields excluding currency (which is always EUR)
//   warnings: [],              // strings, e.g. 'multiple_total_candidates'
// }
// or { ok: false, reason: 'no_text' | 'parse_error', message: '...' }
```

### Field rules

Tuned to the operator's invoice format. Each rule is a regex on the line-by-line text returned by `pdf-parse`. Rules run in language priority: try the language with the most label hits first; if confidence ties, prefer the customer's stored locale.

| Field | Regex (locale-agnostic) | Notes |
|---|---|---|
| Invoice number | `^\s*(FACTUUR\|INVOICE\|FACTURA)\s+([A-Z0-9/-]*\d[A-Z0-9/-]*)\s*$` (line-anchored, requires at least one digit in the captured token) | Filters out the bare "FACTUUR" header word and column-header occurrences. |
| Issued on | `(?:Datum\|Date\|Fecha)\s+(\d{2}\/\d{2}\/\d{4})` | DD/MM/YYYY → emit `YYYY-MM-DD`. |
| Due on | `(?:Te verwachten\|Due\|Vencimiento)\s+(\d{2}\/\d{2}\/\d{4})` | DD/MM/YYYY → emit `YYYY-MM-DD`. |
| Total amount | `(TOTAAL\|TOTAL)\s+([\d.,]+)\s*€` — match all, take the **last** | Earlier "TOTAAL" matches are column headers, "SUBTOTAAL" is excluded by the word-boundary, "IGIC 7%" is preceded by `IGIC`. The final TOTAAL is the grand total. |
| Currency | (no parser; hardcoded `EUR`) | Operator confirmed always EUR. |

### Amount canonicalisation

Operator's format: `198,00€` — comma as decimal separator, no thousand grouping in observed amounts. Defensive normaliser handles three cases (still safe even though the operator's current format is fixed):

```
function normaliseAmount(raw) {
  // 1) Strip any thousand separators by whichever convention.
  // 2) Treat the last , or . as the decimal point.
  // 3) parseFloat × 100 → integer cents.
}
```

Specifically:
- `198,00` → `198.00` → `19800`
- `1.234,56` → `1234.56` → `123456`
- `1,234.56` → `1234.56` → `123456`
- `1234.56`  → `1234.56` → `123456`
- `1234`     → `1234.00` → `123400`

Output is always integer cents.

### Date canonicalisation

DD/MM/YYYY → `YYYY-MM-DD`. Validates day ≤ 31, month ≤ 12; on invalid date, the field is treated as not-found (parser does not lie).

### Language detection

For each language `L ∈ {nl, en, es}`, count regex hits across the four label families (invoice / issued / due / total). The language with the highest count wins; ties broken by customer's stored locale, then by alphabetical order. If no language scores ≥ 2, return `lang: 'unknown'` and run the locale-agnostic union regex (the table above already uses the union form, so this is a no-op).

### Failure modes

- **Image-only PDF (no text)** → `pdf-parse` returns empty string → `{ ok: false, reason: 'no_text' }`.
- **`pdf-parse` throws** (corrupt PDF, encrypted PDF) → `{ ok: false, reason: 'parse_error', message }`.
- **No fields matched** → `{ ok: true, fields_found: 0, fields: {} }`.
- **Partial match** → `{ ok: true, fields_found: 1..4, fields: { … } }`. Missing fields are absent from the `fields` object (not present-with-null).

### Security

The parser runs in-process inside `portal-app`. Inputs are user-uploaded PDFs from authenticated admins only. `pdf-parse` is pure JavaScript, no native code, so the attack surface is the V8 sandbox. Hard cap on input size: **15 MB** (the existing invoice flow allows 50 MB total, but the parser only reads the first 15 MB — the header fields are always on page 1). Stream is consumed lazily so the cap aborts before the full PDF is in memory.

---

## 3. Routes

### `POST /admin/invoices/parse-pdf`

- **Auth:** `requireAdminSession` (same as every other admin route).
- **CSRF:** uses the existing CSRF protection — the form's hidden `_csrf` token is sent in the `x-csrf-token` header (matches the existing AJAX upload pattern in `admin/invoices/new.ejs:60`).
- **Multipart:** single field `file` (PDF only, MIME-checked at upload, magic-byte-checked via the existing `lib/files.js` validation). 15 MB hard cap.
- **Response (success):**
  ```json
  {
    "ok": true,
    "lang": "nl",
    "fields": {
      "invoice_number": "2026/002772",
      "amount_cents": 19800,
      "currency": "EUR",
      "issued_on": "2026-04-27",
      "due_on": "2026-05-04"
    },
    "fields_found": 5
  }
  ```
- **Response (failure):**
  ```json
  { "ok": false, "reason": "no_text" }
  ```
- **No persistence:** nothing is written to the database, the storage tree, or the audit log. The endpoint is a pure function from PDF bytes to JSON.

### Existing `POST /admin/customers/:id/invoices`

Unchanged. The form still does the standard upload-and-create flow.

---

## 4. UI integration

### View changes (`views/admin/invoices/new.ejs`)

Two new visual elements:

1. **Auto-filled chip** beside each affected field's label: small inline pill with text `Auto-filled` (locale: "Auto rellenado" / "Auto-ingevuld" — keep simple). The chip is rendered when JS attaches it after a successful parse, and removed on the field's first `input` event (admin edits → no longer auto-filled).

2. **Banner above the form** when `fields_found > 0` but `fields_found < 5`:
   ```
   ✓ Auto-filled 3 of 5 fields from the PDF. Please complete the missing field(s) before saving.
   ```
   Uses the existing `_alert` partial with `variant: 'info'`. Hidden when all 5 fields are auto-filled (no banner needed — silent success). Hidden when 0 fields are auto-filled (silent fallback — admin types as today).

### Client script

Lives in `views/admin/invoices/new.ejs` (inline, nonce-respected, like the existing upload script). On `<input type="file">` change:

1. Construct `FormData` with `file`.
2. `fetch('/admin/invoices/parse-pdf', { method: 'POST', body: fd, headers: { 'x-csrf-token': csrf }, credentials: 'same-origin' })`.
3. If response 2xx and `ok: true`:
   - For each field in `fields`, populate the `<input>` value and append the chip.
   - If `fields_found < 5`, show the banner.
4. If response not-ok or `ok: false`: silent failure (no UI change). Console-log for the operator's dev console only.

### Accessibility

- Chip is `<span aria-label="Auto-filled by PDF parser">…</span>` so screen readers announce it.
- Banner uses `role="status" aria-live="polite"` so it's announced when populated post-parse.
- The chip's removal on edit is communicated by removing the element entirely (no aria-changes needed).

---

## 5. Acceptance

For Phase C to be considered "done":

- Uploading the operator's sample PDF (`FACTUUR 2026/002772`, NL) populates **all five** form fields correctly: `invoice_number=2026/002772`, `amount_cents=19800`, `currency=EUR`, `issued_on=2026-04-27`, `due_on=2026-05-04`. No banner shown (fields_found = 5).
- Uploading an EN-language equivalent (`INVOICE 2026/...`) populates correctly with `lang=en`.
- Uploading an ES-language equivalent (`FACTURA 2026/...`) populates correctly with `lang=es`.
- An image-only PDF: form behaves identically to today's manual flow (no banner, no chips).
- A PDF where only invoice-number and dates are findable: those three fields populate with chips; the amount field is empty; the partial banner is shown.
- The "Auto-filled" chip disappears the moment the admin types into the field.
- The endpoint refuses non-PDF MIME, files > 15 MB, unauthenticated requests, and missing CSRF.

## 6. Test plan

- Unit (`tests/unit/lib/invoice-parser.spec.js`): the operator's sample PDF as a fixture, plus three synthesised variants (EN, ES, mixed-language gibberish) generated from a tiny PDF template. Cover: full extraction, partial extraction, empty extraction, malformed PDF, encrypted PDF.
- Unit (`tests/unit/lib/invoice-parser-amount.spec.js`): canonicalisation table-driven test for `198,00`, `1.234,56`, `1,234.56`, `1234.56`, `1234` → cents.
- Integration (`tests/integration/admin/parse-pdf.spec.js`): full HTTP path, CSRF rejection, auth rejection, MIME rejection, size cap.
- Manual smoke: operator uploads the real invoice PDF → all five fields populate → save → invoice persists with the auto-filled values intact.

## 7. Risk

Low. The parser is read-only and stateless; failures degrade to today's manual flow. The `pdf-parse` dependency is pure JS with no native code, no known critical CVEs in current versions; pinned at install. Adding the parse endpoint enlarges the admin attack surface by one route, mitigated by:
- Same auth & CSRF as every other admin route.
- 15 MB input cap, MIME and magic-byte validation.
- No persistence path from the parse endpoint into the database or filesystem.

Reverting Phase C is a single-commit revert: remove the route, remove the client script block, remove the `pdf-parse` dep, drop the parser file. The form falls back to its current behaviour with zero migration work.
