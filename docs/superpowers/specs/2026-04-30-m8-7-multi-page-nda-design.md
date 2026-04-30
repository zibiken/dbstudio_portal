# M8.7 — Multi-page NDA print design

**Status:** Draft (awaiting operator approval).
**Owner:** DB Studio Portal.
**Author:** brainstorming session 2026-04-30.
**Replaces:** the strict single-page guard in `pdf-service.js` and the corresponding `NdaOverflowError` path in `domain/ndas/service.js`.

---

## 1 · Why

The verbatim legal NDA template at `templates/nda.html` was designed by counsel as a single A4 page at 8.5pt body type. With realistic Spanish company data — `razón_social` ~50 chars, `domicilio` ~70 chars, `representante_cargo` ~40 chars, `objeto_proyecto` paragraph-length — the rendered HTML overflows one A4 and the M8.4 single-page guard fires. The current behavior (refuse to render any overflow) blocks the operator from generating NDAs against real customers.

Real Spanish legal NDAs commonly span 2–3 pages. Per operator instruction (2026-04-30): the document is important, removing the guard is not enough — multi-page rendering must be **deliberately designed** so legal clauses don't split awkwardly, signatures land cleanly via Yousign overlays, and the printed/PDF output reads as a polished legal instrument across however many pages the content needs.

This spec defines the multi-page redesign. M8.7 is the only task in this scope; the implementation plan that follows lands the redesign + relaxes the single-page guard + updates the integration tests.

---

## 2 · Constraints

- **Verbatim legal text untouched.** The Spanish clauses, definitions, and titles in `templates/nda.html` are the operator-supplied legal canon — no wording changes. CSS, structural wrappers, page-break hints, and the signature block are in scope. Mustache placeholder shape is unchanged (the 9 placeholders enumerated in `lib/nda.js#NDA_PLACEHOLDERS`).
- **Auditability invariant preserved.** `template_version_sha = sha256(rendered HTML)` continues to be deterministic and regression-tested via `tests/integration/ndas/generate.test.js`. Any change to the template flips the sha *once* — the runbook procedure ("archive prior template under `nda-<sha>.html` before re-running `bootstrap-templates.sh`") covers the migration.
- **Yousign signature workflow.** Yousign places signature widgets in operator-defined rectangles via `data-yousign-anchor` attributes on DOM nodes (or by manual placement in their UI). The template provides two visible rectangles sized for Yousign widgets. Signaturit's vertical-strip behavior is NOT a constraint — operator confirmed Yousign-only.
- **No customer email is enqueued at any NDA stage** (carryover from M8 operator scope clarification): the customer signs externally and downloads the signed copy + audit-trail via the M8.5 / M8.6 surfaces. M8.7 inherits this — drafts remain admin-only, audits remain `visible_to_customer=FALSE` for draft generation.
- **portal-pdf.service hardening unchanged.** ProtectSystem=strict + ProtectHome=true + AF_UNIX-only network. The redesign affects only HTML/CSS in `templates/nda.html` and the Puppeteer call options in `pdf-service.js`. The systemd unit isn't touched.

---

## 3 · Design decisions (locked in via brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | Signature placement | Two visible signature rectangles at the foot of the final page, sized to fit Yousign widgets. NO per-page initials, NO running header tying parties — Yousign owns the signature workflow. |
| 2 | Page-break behavior | `page-break-inside: avoid` on every numbered clause (`PRIMERA` through final). Clauses never split across pages — if a clause won't fit on the current page, it starts on the next. |
| 3 | Page margins | 20mm top / 20mm bottom / 25mm left / 18mm right. Standard Spanish legal proportions; Yousign-friendly bottom space; binding-edge convention on left. |
| 4 | Page numbering | `Página X de Y` bottom-center on every page via Puppeteer's `pdf({displayHeaderFooter:true, footerTemplate:...})`. Subtle 8pt grey type. |
| 5 | Continuation header | Slim continuation header on pages 2+: thin horizontal rule + "Acuerdo de Confidencialidad — {{CLIENTE_RAZON_SOCIAL}}" in small grey type. Page 1 keeps the existing black brand bar; pages 2+ get the slim grey header instead. |
| 6 | Body type size | 9.5pt body, 10.5pt headings. Up from 8.5pt — easier on screen, looks "legal document" not "fine print", typically renders the document in 2 pages for most realistic NDAs. |
| 7 | Closing block | Single closing paragraph ("Y en prueba de conformidad, las Partes firman el presente Acuerdo electrónicamente en el lugar y la fecha indicados arriba.") immediately followed by the two signature rectangles. The current printed-style signature lines are removed. |

**Signature rectangle specification:**
- Two rectangles in a flexbox row: left = Provider, right = Cliente.
- Each rectangle: 78mm wide × 40mm tall, 0.5pt solid hairline border (`#999`), 4mm internal padding. (Sized to fit two side-by-side inside the 167mm content area with an 11mm gap; comfortably accommodates a Yousign signature widget at its default ~60×30mm size.)
- Above each rectangle: label in small caps grey ("POR EL PROVEEDOR — DBStudio" / "POR EL CLIENTE — {{CLIENTE_RAZON_SOCIAL}}") and below the label, the printed name in regular type ("Bram Deprez" for the provider; `{{CLIENTE_REPRESENTANTE_NOMBRE}}` for the client).
- DOM attribute `data-yousign-anchor="provider"` / `data-yousign-anchor="client"` on each rectangle so Yousign's UI / API can target them.
- Whole signature block (label + name + rectangle, both columns, plus closing paragraph) wrapped in a container with `page-break-inside: avoid` so it never splits.
- Below the rectangles, a centered footer line in 7.5pt grey: "Firmado electrónicamente mediante Yousign · {{LUGAR_FIRMA}}, {{FECHA_FIRMA}}".

---

## 4 · Implementation surface

### `templates/nda.html`
- Wrap each numbered clause (`<section class="clausula">…</section>`) so it's a discrete CSS block carrying `page-break-inside: avoid`.
- Replace the existing `@page { size: A4; margin: 0 }` with `@page { size: A4; margin: 20mm 18mm 20mm 25mm; }`.
- Add a `.continuation-header` block (thin rule + small grey title) inside `<body>` that's hidden on the first page via `:first-child` / a content-positioning trick — see §6 implementation notes.
- Keep the existing black brand bar but scope it so it ONLY appears at the top of the first content section (`.cover-bar` or similar). Subsequent pages do NOT repeat it.
- Body font: bump from 8.5pt to 9.5pt; headings from current to 10.5pt.
- Replace the current `.firma-meta` paragraph + signature lines with the new closing paragraph + two-column signature rectangle block described in §3.

### `pdf-service.js`
- Drop the `scrollHeight > A4_HEIGHT_PX` check entirely.
- Drop the `getOffending` selector loop. (The `data-field` markers stay in the template — they're harmless and may be useful for future overflow-tolerance tuning.)
- Pass `displayHeaderFooter: true`, `headerTemplate: '<span></span>'` (empty header — page 1's brand bar is in the body, not in `@page`), and a `footerTemplate` containing the `Página X de Y` block, to `page.pdf({...})`.
- Keep `headless: 'new'`, `pipe: true`, `--no-sandbox` etc. as in M8.4.

### `domain/ndas/service.js`
- Remove `NdaOverflowError` (no longer reachable). Keep `NdaPdfServiceError` for IPC/Puppeteer crashes.
- Remove the corresponding overflow-audit branch (`nda.draft_overflow`) — no event to record.
- Update the docstring on `generateDraft` to drop the single-page-guard reference.

### Test changes
- `tests/integration/ndas/generate.test.js`:
  - Remove the `fakeOverflowClient` test (no longer a real path).
  - Update the `RUN_PDF_E2E` test's "exchanges a real Mustache→IPC→Puppeteer round-trip and returns either a valid PDF or a structured overflow" assertion back to the original single-outcome shape: "produces a real PDF that opens, has a non-zero byte count, and matches its sha on disk." Realistic-fixture data stays.
  - Add an assertion that the rendered PDF is at least 2 pages (count `%%PageCount`-equivalent or use the trailing-bytes pattern; pdf.js bind is overkill — a regex match for `/\d+/Count\s+(\d+)/` in the trailer is enough for our purposes).
- `tests/integration/nda/template-bootstrap.test.js`:
  - Existing `data-field` placeholder asserts stay; new asserts for the two `data-yousign-anchor` attributes ("provider", "client") in the rendered output.
- `tests/unit/nda.test.js`: unchanged — the placeholder list and Mustache-render contract are stable.

### Documentation
- `RUNBOOK.md` "M8.7 — Multi-page NDA print design (deferred)" section is **converted** to "M8.7 — Multi-page NDA print design (landed)" with a brief note pointing to this spec.
- `docs/superpowers/plans/2026-04-29-portal-implementation.md` progress table gains an M8.7 row.

---

## 5 · Out of scope

- Header/footer customization per customer (e.g., per-customer logo). Out of scope; the brand-bar-on-page-1 is fixed DBStudio branding.
- Localization of the NDA into other languages. Spec §2.11 says the NDA template stays Spanish; this redesign inherits that.
- Yousign API integration to programmatically place signature anchors. Out of scope — operator places anchors manually in Yousign's UI by clicking the rectangles. The `data-yousign-anchor` attributes are forward-compatibility for a future API integration if it lands.
- Embedding QR codes or document fingerprints in the rendered PDF. Out of scope for M8.7; the `template_version_sha` already serves as the auditability identifier.
- Multi-signer NDAs (more than two parties). Spec §14 in the original blueprint assumed two parties; the rectangle layout is fixed at two columns. Multi-party support would be a separate spec.

---

## 6 · Implementation notes (CSS techniques)

This section documents the trickier CSS choices so the implementation plan + code review can verify them quickly.

**Brand bar on page 1 only.** The brand bar is the first child of `<body>` and renders inline on page 1. It is NOT in `@page` so it doesn't repeat across pages.

**Continuation header on pages 2+ only.** Implemented via Puppeteer's `headerTemplate` option, which renders on every page. Page 1 suppression: the `headerTemplate` HTML inspects the `pageNumber` placeholder Puppeteer substitutes — when `pageNumber === '1'`, the template is collapsed to an empty 0-height `<div>`. On page 2+ it renders the thin rule + small grey title. The `headerTemplate` and `footerTemplate` operate inside the `@page` margins; the 20mm top margin is sized to fit the slim continuation header (~6mm content + breathing space) and stay clear of body type on page 1 where the header is empty.

**Signature rectangle width.** Two 78mm rectangles + 11mm gap = 167mm row width, fits exactly inside the 210 − 25 − 18 = 167mm content area. Each rectangle 78mm × 40mm, 0.5pt hairline border, 4mm internal padding.

**Page break inside the parties block.** The "REUNIDOS" block (provider + client identity blocks side-by-side) currently sits before the clauses. Wrap it in a `<section class="reunidos">` with `page-break-inside: avoid` so it stays whole — splitting the parties block across pages reads as broken.

---

## 7 · Acceptance criteria

The implementation plan is complete when ALL of the following hold:

1. `tests/integration/ndas/generate.test.js`'s realistic-fixture e2e (gated behind `RUN_PDF_E2E=1`) **produces a valid PDF** (no overflow throw); rendered PDF matches its sha on disk; rendered PDF is at least 2 pages.
2. The rendered PDF, opened in any standard viewer, shows: page 1 with the black brand bar at top, page 2+ with the slim continuation header, every page with `Página X de Y` bottom-centered, no clause split across pages, two signature rectangles on the final page sized for Yousign widgets.
3. `template_version_sha` is deterministic across two consecutive renders with identical vars (existing test passes).
4. A one-character edit to `templates/nda.html` flips the sha (existing test passes).
5. All M8 service-layer tests still pass (mocked `renderPdf` clients, customer-visibility, attach-signed-document, etc.).
6. Coverage gates in `vitest.config.js` continue to pass for `domain/ndas/**` and `lib/nda.js`.
7. Smoke (`scripts/smoke.sh`) passes 5/5.
8. The verbatim legal text body is byte-for-byte identical to its M8.2 original (only structural CSS wrappers and the signature block change).

---

## 8 · Migration

Because `template_version_sha` changes once (legitimately — the template's HTML is changing), every NDA generated before M8.7 lands references the OLD sha. The runbook procedure in `RUNBOOK.md` "M0-B-pdf" already documents how to archive the prior rendered template for historical reproducibility:

```bash
PREV_SHA="$(sudo sha256sum /var/lib/portal/templates/nda.html | awk '{print $1}')"
sudo cp /var/lib/portal/templates/nda.html "/var/lib/portal/templates/nda-$PREV_SHA.html"
sudo bash /opt/dbstudio_portal/scripts/bootstrap-templates.sh
```

After M8.7 lands and the operator runs the bootstrap, the new template is in place. No NDAs have been generated in production yet (M8 is on staging only), so no live migration is needed — staging-only test data can be deleted by the cleanup helpers in the integration tests.

---

## 9 · Risks

- **Yousign rectangle size mismatch.** If 80mm × 40mm turns out to be too small / too large for Yousign's actual widget rendering on a real signed document, the rectangles can be retuned. This is a tunable, not a structural risk.
- **Page-3 spillover for very long objeto_proyecto.** A `objeto_proyecto` exceeding ~250 chars + a `domicilio` exceeding ~120 chars together could push the document to 3 pages. Acceptable per operator's "2-3 pages" framing.
- **Continuation-header cosmetic edge cases.** Puppeteer's `headerTemplate` rendering across page-number boundaries has known quirks. The implementation plan includes a "render a 3-page test PDF and visually inspect" step before declaring acceptance.
- **Print preview vs. screen rendering divergence.** Chromium's headless print engine sometimes renders slightly differently from screen preview (font hinting, kerning). Acceptance is the PDF output, not screen preview.
