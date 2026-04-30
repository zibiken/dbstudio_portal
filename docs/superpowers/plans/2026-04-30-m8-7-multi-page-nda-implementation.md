# M8.7 — Multi-page NDA print design — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the verbatim legal NDA template across however many A4 pages the content needs, with disciplined page-breaks, page numbering, a slim continuation header on pages 2+, and two Yousign-anchor signature rectangles on the final page.

**Architecture:** CSS-only changes inside the verbatim legal template (the legal text body is byte-for-byte preserved); Puppeteer's `displayHeaderFooter` + `headerTemplate` + `footerTemplate` for `Página X de Y` and the continuation header; removal of the strict single-page guard from `pdf-service.js` and the corresponding `NdaOverflowError` path from `domain/ndas/service.js`.

**Tech Stack:** HTML/CSS print rules, Mustache (untouched), Puppeteer 24+ (`page.pdf()` headerTemplate / footerTemplate / margin options), vitest integration tests gated on `RUN_PDF_E2E=1`.

**Spec:** `/opt/dbstudio_portal/docs/superpowers/specs/2026-04-30-m8-7-multi-page-nda-design.md`

---

## File structure

| File | Change |
|---|---|
| `templates/nda.html` | Modify CSS + structural wrappers; replace `.firmas-section` with the two-rectangle signature block. The legal text body is unchanged. |
| `pdf-service.js` | Remove the `scrollHeight > A4_HEIGHT_PX` overflow check and the offending-field selector loop. Pass `displayHeaderFooter: true`, `headerTemplate`, `footerTemplate`, `margin: 0` to `page.pdf()` (margins now live in the template's `@page` rule). |
| `domain/ndas/service.js` | Remove `NdaOverflowError` class + the corresponding overflow-audit branch in `generateDraft`. Update the docstring. |
| `tests/integration/ndas/generate.test.js` | Remove `fakeOverflowClient` test. Tighten the RUN_PDF_E2E test back to "produces a valid PDF" + a multi-page assertion (rendered PDF carries `/Count 2` or higher in its catalog). |
| `tests/integration/nda/template-bootstrap.test.js` | Add asserts for the two `data-yousign-anchor` attributes ("provider", "client") in the bootstrap-rewritten output. |
| `RUNBOOK.md` | Convert "M8.7 — Multi-page NDA print design (deferred)" to "(landed)" with a pointer to the spec. |
| `docs/superpowers/plans/2026-04-29-portal-implementation.md` | Add an M8.7 row to the live progress table. |

---

## Conventions

- **TDD relaxed.** Templates + Puppeteer rendering aren't naturally TDD'd — the integration test gated on `RUN_PDF_E2E=1` is the load-bearing assertion. Each task lands its CSS / Puppeteer change + a verifying test invocation.
- **Permissions.** Every new/modified file must end up `root:portal-app 0640`; the bootstrap script stays `0750`. Use `sudo chown root:portal-app <path> && sudo chmod 0640 <path>` after any Edit/Write.
- **Test command.** `sudo bash /opt/dbstudio_portal/scripts/run-tests.sh` (the wrapper stops portal.service for the run; never invoke vitest directly for DB-touching tests). `RUN_PDF_E2E=1 sudo -E bash …` to include the live Puppeteer test.
- **Bootstrap after each `templates/nda.html` change.** The portal-pdf service reads from `/var/lib/portal/templates/nda.html`, NOT the repo file. After every template edit, run `sudo SKIP_FONT_CHECK=1 bash scripts/bootstrap-templates.sh` (font check is on; SKIP only used in tests / first dev iteration). Production already has both fonts in place — drop `SKIP_FONT_CHECK=1` once the operator runs it.
- **Service restart between renders.** Puppeteer cold-starts inside portal-pdf.service. After the first render the browser is held; subsequent renders reuse it. Hot-edit cycles are: edit template → run bootstrap → re-render via probe → inspect.

---

## Task 1: Page-break-aware CSS — `@page` margins + clause containment

**Files:**
- Modify: `templates/nda.html` (CSS block at top of `<head>`)

- [ ] **Step 1.1: Replace the `@page` rule.** Find the current `@page { size: A4; margin: 0; }` rule and replace it with the multi-page layout margins:

```css
@page {
  size: A4;
  margin: 20mm 18mm 20mm 25mm;
}
```

The 25mm left honors Spanish legal binding-edge convention; 18mm right keeps line length readable; 20mm top/bottom leaves room for the Puppeteer-injected header/footer templates.

- [ ] **Step 1.2: Drop the `min-height: 297mm` constraint on `.page`.** Locate the `.page { … min-height: 297mm; … }` rule. Remove the `min-height` declaration and the `width: 210mm` (the `@page size: A4` already handles this). Multi-page rendering relies on natural content flow, not a fixed-height container.

- [ ] **Step 1.3: Bump body type and headings.**

```css
html, body {
  /* font-size was 8.5pt; bumped for multi-page readability per spec §3 */
  font-size: 9.5pt;
  /* … existing rules unchanged … */
}

h1, h2, h3, .clause-title, .doc-title, .meta-label {
  /* whatever previous size — bump headings to 10.5pt where they were smaller */
  /* doc-title likely already larger; only bump clause-title + meta-label */
}
```

The doc-title is already a large display heading and should NOT be bumped further. Only `clause-title`, `meta-label`, and any small section-heading classes go from their current size to 10.5pt.

- [ ] **Step 1.4: Confirm `page-break-inside: avoid` is on every clause.** The existing template at `templates/nda.html:173` already declares this on `.clause` for `@media print`. Verify it sits OUTSIDE the `@media print` block too, so headless Chromium honors it consistently:

```css
.clause {
  page-break-inside: avoid;
  break-inside: avoid;        /* modern equivalent */
  margin-bottom: 5mm;          /* breathing room between clauses */
}
.clause-title {
  page-break-after: avoid;    /* heading never orphans at page bottom */
  break-after: avoid;
}
```

- [ ] **Step 1.5: `page-break-inside: avoid` on the parties block.** The "REUNIDOS" / parties block is currently in `<section class="partes">` or similar. Make sure it carries:

```css
.partes, .reunidos, .parties {
  page-break-inside: avoid;
  break-inside: avoid;
}
```

Use whichever class name(s) actually exist in the template (grep for them; if the wrapper is unnamed, add a class).

- [ ] **Step 1.6: Save, fix perms, bootstrap into /var/lib/portal/templates/.**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/templates/nda.html
sudo chmod 0640 /opt/dbstudio_portal/templates/nda.html
sudo SKIP_FONT_CHECK=1 bash /opt/dbstudio_portal/scripts/bootstrap-templates.sh
```

(SKIP_FONT_CHECK is used during dev iteration if the fonts have already been verified earlier in the session. For the production deploy, omit it.)

- [ ] **Step 1.7: Restart portal-pdf.service so any cached browser sees the new template.**

```bash
sudo systemctl restart portal-pdf.service
sleep 2
sudo systemctl is-active portal-pdf.service
```

Expected: `active`.

- [ ] **Step 1.8: Render a probe PDF and inspect the page count.**

```bash
cat > /tmp/probe.mjs <<'EOF'
import { renderPdf } from '/opt/dbstudio_portal/lib/pdf-client.js';
import { renderNda } from '/opt/dbstudio_portal/lib/nda.js';
import { readFileSync, writeFileSync } from 'node:fs';
const tpl = readFileSync('/var/lib/portal/templates/nda.html', 'utf8');
const { html } = renderNda({
  template: tpl,
  vars: {
    CLIENTE_RAZON_SOCIAL: 'Empresa de Construcción y Servicios Integrales S.L.',
    CLIENTE_CIF: 'B12345678',
    CLIENTE_DOMICILIO: 'Avenida de los Acantilados 47, Edificio Central, planta 3, oficina 12, 38670 Adeje, Santa Cruz de Tenerife, España',
    CLIENTE_REPRESENTANTE_NOMBRE: 'María Fernández de Córdoba y Velasco',
    CLIENTE_REPRESENTANTE_DNI: '12345678X',
    CLIENTE_REPRESENTANTE_CARGO: 'Administradora Única y Representante Legal',
    OBJETO_PROYECTO: 'Diseño y desarrollo de un portal cliente con funcionalidades de gestión documental, firma electrónica y cumplimiento normativo',
    FECHA_FIRMA: '30/04/2026',
    LUGAR_FIRMA: 'Adeje',
  },
});
const r = await renderPdf({
  socketPath: '/run/portal-pdf/portal.sock',
  html,
  options: { format: 'A4', margin: 0 },
  timeoutMs: 60_000,
});
if (!r.ok) { console.log('NOT OK', r); process.exit(1); }
writeFileSync('/tmp/probe.pdf', r.pdf);
const count = r.pdf.toString('latin1').match(/\/Count\s+(\d+)/)?.[1];
console.log('bytes:', r.pdf.length, 'pages (Count):', count, 'sha:', r.sha256.slice(0, 16));
EOF
chmod 0644 /tmp/probe.mjs
sudo -u portal-app /opt/dbstudio_portal/.node/bin/node /tmp/probe.mjs
rm /tmp/probe.mjs
```

Expected: `pages (Count): 2` (or higher); a real PDF saved to `/tmp/probe.pdf` (inspect with any PDF viewer if you can).

- [ ] **Step 1.9: Commit.**

```bash
cd /opt/dbstudio_portal
git add templates/nda.html
git commit -m "feat(m8.7): clause-aware page breaks + multi-page margins (Task 1)"
```

---

## Task 2: Two-rectangle Yousign-anchor signature block

**Files:**
- Modify: `templates/nda.html` (CSS block + the `.firmas-section` markup at lines 386-407)

- [ ] **Step 2.1: Replace the `.firmas-section` block.** Find the section starting at `<!-- 04 · FIRMAS -->` (around line 385). Replace the entire block with:

```html
      <!-- 04 · FIRMAS -->
      <section class="firmas-section">
        <div class="meta-label">04 · Firmas</div>

        <p class="firmas-closing">
          Y en prueba de conformidad, las Partes firman el presente Acuerdo
          electrónicamente en el lugar y la fecha indicados arriba.
        </p>

        <p class="firmas-date">En {{LUGAR_FIRMA}}, a {{FECHA_FIRMA}}.</p>

        <div class="firmas">
          <div class="firma-box" data-yousign-anchor="provider">
            <div class="firma-label">POR EL PROVEEDOR — DBStudio</div>
            <div class="firma-name">D. Bram Georges R Deprez</div>
            <div class="firma-rect" aria-label="Firma del proveedor"></div>
          </div>
          <div class="firma-box" data-yousign-anchor="client">
            <div class="firma-label">POR EL CLIENTE — {{CLIENTE_RAZON_SOCIAL}}</div>
            <div class="firma-name">{{CLIENTE_REPRESENTANTE_NOMBRE}}</div>
            <div class="firma-rect" aria-label="Firma del cliente"></div>
          </div>
        </div>

        <p class="firmas-footer">
          Firmado electrónicamente mediante Yousign · {{LUGAR_FIRMA}}, {{FECHA_FIRMA}}
        </p>
      </section>
```

Note: the `data-yousign-anchor` attribute is on the OUTER `.firma-box`, not the rectangle itself. Yousign's UI lets the operator click anywhere within the parent container to place a signature widget — putting the anchor on the box (which contains label + name + rectangle) gives Yousign a meaningful click target with context.

- [ ] **Step 2.2: Add CSS for the new signature classes.** Locate the existing `.firma-box`, `.firma-line`, `.firma-name`, `.firma-meta`, `.firmas` rules and replace them with:

```css
.firmas-section {
  page-break-inside: avoid;
  break-inside: avoid;
  margin-top: 8mm;
}
.firmas-closing {
  font-size: 9.5pt;
  margin-bottom: 4mm;
}
.firmas-date {
  font-size: 9.5pt;
  margin-bottom: 6mm;
}
.firmas {
  display: flex;
  flex-direction: row;
  gap: 11mm;
  page-break-inside: avoid;
  break-inside: avoid;
}
.firma-box {
  width: 78mm;
  page-break-inside: avoid;
  break-inside: avoid;
}
.firma-label {
  font-size: 7.5pt;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: #555;
  margin-bottom: 2mm;
}
.firma-name {
  font-size: 9pt;
  margin-bottom: 3mm;
}
.firma-rect {
  width: 78mm;
  height: 40mm;
  border: 0.5pt solid #999;
  box-sizing: border-box;
}
.firmas-footer {
  margin-top: 6mm;
  font-size: 7.5pt;
  text-align: center;
  color: #666;
}
```

- [ ] **Step 2.3: Save, fix perms, bootstrap.**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/templates/nda.html
sudo chmod 0640 /opt/dbstudio_portal/templates/nda.html
sudo SKIP_FONT_CHECK=1 bash /opt/dbstudio_portal/scripts/bootstrap-templates.sh
sudo systemctl restart portal-pdf.service
sleep 2
```

- [ ] **Step 2.4: Re-run the probe and verify.**

```bash
# Same /tmp/probe.mjs as Task 1; re-run.
cat > /tmp/probe.mjs <<'EOF'
import { renderPdf } from '/opt/dbstudio_portal/lib/pdf-client.js';
import { renderNda } from '/opt/dbstudio_portal/lib/nda.js';
import { readFileSync, writeFileSync } from 'node:fs';
const tpl = readFileSync('/var/lib/portal/templates/nda.html', 'utf8');
const { html, sha256 } = renderNda({
  template: tpl,
  vars: {
    CLIENTE_RAZON_SOCIAL: 'Empresa de Construcción y Servicios Integrales S.L.',
    CLIENTE_CIF: 'B12345678',
    CLIENTE_DOMICILIO: 'Avenida de los Acantilados 47, Edificio Central, planta 3, oficina 12, 38670 Adeje, Santa Cruz de Tenerife, España',
    CLIENTE_REPRESENTANTE_NOMBRE: 'María Fernández de Córdoba y Velasco',
    CLIENTE_REPRESENTANTE_DNI: '12345678X',
    CLIENTE_REPRESENTANTE_CARGO: 'Administradora Única y Representante Legal',
    OBJETO_PROYECTO: 'Diseño y desarrollo de un portal cliente con funcionalidades de gestión documental, firma electrónica y cumplimiento normativo',
    FECHA_FIRMA: '30/04/2026',
    LUGAR_FIRMA: 'Adeje',
  },
});
console.log('html sha:', sha256.slice(0, 16));
console.log('html anchors:', (html.match(/data-yousign-anchor/g) || []).length);
const r = await renderPdf({
  socketPath: '/run/portal-pdf/portal.sock',
  html,
  options: { format: 'A4', margin: 0 },
  timeoutMs: 60_000,
});
if (!r.ok) { console.log('NOT OK', r); process.exit(1); }
writeFileSync('/tmp/probe.pdf', r.pdf);
const count = r.pdf.toString('latin1').match(/\/Count\s+(\d+)/)?.[1];
console.log('bytes:', r.pdf.length, 'pages (Count):', count);
EOF
chmod 0644 /tmp/probe.mjs
sudo -u portal-app /opt/dbstudio_portal/.node/bin/node /tmp/probe.mjs
rm /tmp/probe.mjs
```

Expected: `html anchors: 2`, `pages (Count): 2`, real PDF on disk.

- [ ] **Step 2.5: Commit.**

```bash
cd /opt/dbstudio_portal
git add templates/nda.html
git commit -m "feat(m8.7): two-rectangle Yousign-anchor signature block (Task 2)"
```

---

## Task 3: Continuation header + Página X de Y footer via Puppeteer

**Files:**
- Modify: `pdf-service.js` (the `render` function call to `page.pdf()`).
- Modify: `lib/pdf-client.js` (forward an extra `continuationTitle` field through the IPC payload).
- Modify: `domain/ndas/service.js` (pass the customer's razón social as `continuationTitle` in the renderPdf call).

The continuation header renders on EVERY page (including page 1, where the brand bar above it serves as additional page-1 distinction). Spec §3 decision 5 = "slim continuation header on pages 2+"; we render on every page because Puppeteer's static `headerTemplate` cannot conditionally suppress page 1, and the brand bar on page 1 visually overshadows the slim grey rule beneath it — net visual result matches the spec's intent.

- [ ] **Step 3.1: Forward `continuationTitle` through `lib/pdf-client.js`.** Find the existing `renderPdf` function in `lib/pdf-client.js` and verify it passes the `options` field of the input through to the JSON payload — it already does (`{ html, options }` is the wire shape). No change needed if so. Confirm by reading the file.

- [ ] **Step 3.2: Update `pdf-service.js` `render` to consume `options.continuationTitle`.** Find the `render` function and update the destructure + the `page.pdf()` call:

```js
async function render({ html, options }) {
  const continuationTitle = String((options && options.continuationTitle) || '')
    .replace(/[<>&"]/g, ' ');  // belt-and-braces; the caller already escapes
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      // Margins live in the template's @page rule (M8.7 spec §3 decision 3).
      // Leaving page.pdf()'s margin at 0 means Chromium honors the @page
      // values from the template directly.
      margin: 0,
      displayHeaderFooter: true,
      headerTemplate: `
        <div style="width: 100%; padding: 0 25mm 0 25mm; box-sizing: border-box;
                    font-size: 8pt; color: #888;
                    font-family: 'Inter', system-ui, sans-serif;">
          <div style="border-top: 0.5pt solid #ccc; padding-top: 2mm;">
            Acuerdo de Confidencialidad — ${continuationTitle}
          </div>
        </div>
      `,
      footerTemplate: `
        <div style="width: 100%; padding: 0 25mm 0 25mm; box-sizing: border-box;
                    text-align: center;
                    font-size: 8pt; color: #888;
                    font-family: 'Inter', system-ui, sans-serif;">
          Página <span class="pageNumber"></span> de <span class="totalPages"></span>
        </div>
      `,
    });
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    return { ok: true, pdfBase64: pdf.toString('base64'), sha256 };
  } finally {
    await page.close();
  }
}
```

The previous overflow-detection logic (scrollHeight + selector loop) is removed in Task 4; this step keeps the function shape simpler.

- [ ] **Step 3.3: Pass `continuationTitle` from `domain/ndas/service.js`.** Find the `renderPdf({ socketPath, html, options: { format: 'A4', margin: 0 } })` call inside `generateDraft`. Replace with:

```js
pdfResult = await renderPdf({
  socketPath,
  html,
  options: {
    format: 'A4',
    margin: 0,
    continuationTitle: customer.razon_social,
  },
});
```

- [ ] **Step 3.4: Save, fix perms, restart pdf-service.**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/pdf-service.js /opt/dbstudio_portal/domain/ndas/service.js
sudo chmod 0640 /opt/dbstudio_portal/pdf-service.js /opt/dbstudio_portal/domain/ndas/service.js
sudo systemctl restart portal-pdf.service
sleep 2
```

- [ ] **Step 3.5: Re-run the probe and verify.** Use the Step 2.4 probe verbatim. Confirm the rendered `/tmp/probe.pdf` opens with `Página 1 de 2` (or `de 3`) on each page's footer + the slim grey "Acuerdo de Confidencialidad — <razón social>" continuation header at the top of every page.

- [ ] **Step 3.6: Commit.**

```bash
cd /opt/dbstudio_portal
git add pdf-service.js domain/ndas/service.js
git commit -m "feat(m8.7): continuation header + Página X de Y footer (Task 3)"
```

---

## Task 4: Remove the single-page guard

**Files:**
- Modify: `pdf-service.js` (the `render` function: drop the `scrollHeight` check + the offending-field selector loop).
- Modify: `domain/ndas/service.js` (drop `NdaOverflowError` + the corresponding overflow-audit branch in `generateDraft`).
- Modify: `tests/integration/ndas/generate.test.js` (remove the `fakeOverflowClient` test).

- [ ] **Step 4.1: Remove the overflow check from `pdf-service.js`.** Find the block in the `render` function that reads:

```js
const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
if (scrollHeight > A4_HEIGHT_PX) {
  const offending = await page.evaluate(() => {
    const fields = ['domicilio', 'razon_social', 'nif', 'objeto_proyecto'];
    let worst = null; let worstLen = 0;
    for (const f of fields) {
      const el = document.querySelector(`[data-field="${f}"]`);
      const len = el ? (el.textContent || '').length : 0;
      if (len > worstLen) { worst = f; worstLen = len; }
    }
    return { field: worst, length: worstLen };
  });
  return { ok: false, error: 'overflow', field: offending.field, length: offending.length };
}
```

Delete it entirely. Also delete the now-unused `A4_HEIGHT_PX` constant at the top of the file.

- [ ] **Step 4.2: Remove the overflow-handling branch from `domain/ndas/service.js`.** Find the block in `generateDraft` that reads:

```js
if (!pdfResult.ok) {
  if (pdfResult.error === 'overflow') {
    const a = baseAudit(ctx);
    await writeAudit(db, {
      actorType: 'admin',
      actorId: adminId,
      action: 'nda.draft_overflow',
      // …
    });
    throw new NdaOverflowError({ field: pdfResult.field, length: pdfResult.length });
  }
  throw new NdaPdfServiceError(pdfResult.message ?? pdfResult.error ?? 'unknown pdf-service error');
}
```

Replace with:

```js
if (!pdfResult.ok) {
  // Overflow is no longer a possible outcome (M8.7 dropped the strict
  // single-page guard). Any !ok is a genuine pdf-service crash / IPC
  // failure path.
  throw new NdaPdfServiceError(pdfResult.message ?? pdfResult.error ?? 'unknown pdf-service error');
}
```

- [ ] **Step 4.3: Remove the `NdaOverflowError` class.** Find it in the same file and delete the entire class declaration. Update the docstring at the top of the module to drop any "single-page guard" reference.

- [ ] **Step 4.4: Remove the `fakeOverflowClient` test.** In `tests/integration/ndas/generate.test.js`, find the `it('overflow → no rows, structured error, audit nda.draft_overflow visible_to_customer=false', ...)` block and delete it entirely. Also remove the `fakeOverflowClient` factory function at the top of the file.

- [ ] **Step 4.5: Save, fix perms, restart, run mocked tests.**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/pdf-service.js /opt/dbstudio_portal/domain/ndas/service.js /opt/dbstudio_portal/tests/integration/ndas/generate.test.js
sudo chmod 0640 /opt/dbstudio_portal/pdf-service.js /opt/dbstudio_portal/domain/ndas/service.js /opt/dbstudio_portal/tests/integration/ndas/generate.test.js
sudo systemctl restart portal-pdf.service
sleep 2
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/ndas/
```

Expected: 18 / 18 mocked tests pass + 1 skipped (RUN_PDF_E2E gate) — net DOWN from 19 because the overflow test was removed.

- [ ] **Step 4.6: Run the live e2e test.**

```bash
RUN_PDF_E2E=1 sudo -E bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/ndas/generate.test.js
```

Expected: the realistic-fixture e2e test now produces a valid multi-page PDF (no overflow throw). 19 / 19 tests pass. If still overflows, Task 1's CSS didn't quite fit — back to Task 1 step 1.4 / 1.5 (clause containment) or expand the body type back to 9pt.

- [ ] **Step 4.7: Commit.**

```bash
cd /opt/dbstudio_portal
git add pdf-service.js domain/ndas/service.js tests/integration/ndas/generate.test.js
git commit -m "feat(m8.7): drop strict single-page guard + NdaOverflowError (Task 4)"
```

---

## Task 5: Tighten e2e test assertion + add Yousign-anchor bootstrap test

**Files:**
- Modify: `tests/integration/ndas/generate.test.js` (RUN_PDF_E2E test assertion).
- Modify: `tests/integration/nda/template-bootstrap.test.js` (add `data-yousign-anchor` assertion).

- [ ] **Step 5.1: Update the e2e assertion** to require a valid PDF with at least 2 pages. Find the test block titled "exchanges a real Mustache→IPC→Puppeteer round-trip and returns either a valid PDF or a structured overflow" and replace its body with the original-shape assertion plus a multi-page check:

```js
it('produces a real multi-page PDF that opens, has a non-zero byte count, and matches its sha on disk', async () => {
  // Realistic Spanish company data. The M8.7 multi-page redesign
  // means this test no longer accepts an overflow outcome; the
  // pipeline MUST produce a valid 2+ page PDF.
  const c = await customersService.create(db, {
    razonSocial: `${tag}_e2e Empresa de Construcción y Servicios Integrales S.L.`,
    nif: 'B12345678',
    domicilio: 'Avenida de los Acantilados 47, Edificio Central, planta 3, oficina 12, 38670 Adeje, Santa Cruz de Tenerife, España',
    primaryUser: { name: 'Operador', email: `${tag}_e2e@example.com` },
  }, baseCtx());
  createdCustomerIds.push(c.customerId);
  await customersService.updateCustomer(db, {
    customerId: c.customerId,
    fields: {
      representanteNombre: 'María Fernández de Córdoba y Velasco',
      representanteDni: '12345678X',
      representanteCargo: 'Administradora Única y Representante Legal',
    },
  }, baseCtx());
  const id = uuidv7();
  await projectsRepo.insertProject(db, {
    id, customerId: c.customerId, name: 'e2e',
    objetoProyecto: 'Diseño y desarrollo de un portal cliente con funcionalidades de gestión documental, firma electrónica y cumplimiento normativo',
  });

  const r = await ndasService.generateDraft(db,
    { adminId: e2eAdminId, projectId: id },
    baseCtx(),
  );
  expect(r.sizeBytes).toBeGreaterThan(2048);
  const doc = await findDocumentById(db, r.draftDocumentId);
  const onDisk = await fsp.readFile(doc.storage_path);
  const sha = createHash('sha256').update(onDisk).digest('hex');
  expect(sha).toBe(doc.sha256);
  expect(onDisk.slice(0, 4).toString()).toBe('%PDF');
  // Multi-page assertion: the PDF catalog's /Count entry MUST be >= 2.
  // The trailer's /Pages object lists the page count via /Count.
  const trailer = onDisk.toString('latin1');
  const m = trailer.match(/\/Count\s+(\d+)/);
  expect(m).not.toBeNull();
  expect(Number(m[1])).toBeGreaterThanOrEqual(2);
}, 30_000);
```

- [ ] **Step 5.2: Add the Yousign-anchor bootstrap assertion.** In `tests/integration/nda/template-bootstrap.test.js`, find the test "preserves every Mustache placeholder verbatim" and add a new test below it:

```js
it('preserves the two data-yousign-anchor attributes', () => {
  runBootstrap({ TEMPLATES_DIR: templatesDir, FONTS_DIR: fontsDir });
  const out = fs.readFileSync(dst, 'utf8');
  expect(out).toContain('data-yousign-anchor="provider"');
  expect(out).toContain('data-yousign-anchor="client"');
});
```

- [ ] **Step 5.3: Save, fix perms, run tests.**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/tests/integration/ndas/generate.test.js /opt/dbstudio_portal/tests/integration/nda/template-bootstrap.test.js
sudo chmod 0640 /opt/dbstudio_portal/tests/integration/ndas/generate.test.js /opt/dbstudio_portal/tests/integration/nda/template-bootstrap.test.js
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/nda/ tests/integration/ndas/
```

Expected: bootstrap tests now 8/8 (was 7); `ndas/` tests 19/19 mocked + 1 skipped.

- [ ] **Step 5.4: Run the live e2e and confirm the multi-page assertion passes.**

```bash
RUN_PDF_E2E=1 sudo -E bash /opt/dbstudio_portal/scripts/run-tests.sh tests/integration/ndas/generate.test.js
```

Expected: 20 / 20 tests pass.

- [ ] **Step 5.5: Run full suite + smoke for regressions.**

```bash
sudo bash /opt/dbstudio_portal/scripts/run-tests.sh
```

Expected: ~501 mocked tests green + 2 skipped (live email + RUN_PDF_E2E). Smoke 5/5.

- [ ] **Step 5.6: Commit.**

```bash
cd /opt/dbstudio_portal
git add tests/integration/ndas/generate.test.js tests/integration/nda/template-bootstrap.test.js
git commit -m "test(m8.7): require multi-page PDF + assert yousign anchors (Task 5)"
```

---

## Task 6: Documentation — RUNBOOK + plan progress row

**Files:**
- Modify: `RUNBOOK.md` ("M8.7" section).
- Modify: `docs/superpowers/plans/2026-04-29-portal-implementation.md` (live progress table).

- [ ] **Step 6.1: Convert the RUNBOOK "M8.7 (deferred)" section to "(landed)".** Find the section starting with `### M8.7 — Multi-page NDA print design (deferred)` and replace its title + body with:

```markdown
### M8.7 — Multi-page NDA print design (landed)

The verbatim legal NDA template now renders across multiple A4 pages
with disciplined page breaks (no clause splits across pages),
`Página X de Y` page numbering bottom-center, and two Yousign-anchor
signature rectangles on the final page. See
`docs/superpowers/specs/2026-04-30-m8-7-multi-page-nda-design.md` for
the full design rationale.

Implementation notes:

- `templates/nda.html` carries `@page { margin: 20mm 18mm 20mm 25mm }`
  and `page-break-inside: avoid` on every numbered clause + the
  parties block + the signature block.
- `pdf-service.js` calls `page.pdf()` with `displayHeaderFooter: true`
  + a footer template rendering "Página <pageNumber> de <totalPages>".
- The signature block at the end of the template has two
  `<div class="firma-box" data-yousign-anchor="..."` rectangles sized
  78×40mm. In Yousign's UI, click each rectangle to anchor a signature
  widget there.
- The single-page guard + `NdaOverflowError` class were removed from
  `pdf-service.js` and `domain/ndas/service.js`. Multi-page renderings
  are the expected output.

Re-run the bootstrap script after every edit to `templates/nda.html`:

```bash
PREV_SHA="$(sudo sha256sum /var/lib/portal/templates/nda.html | awk '{print $1}')"
sudo cp /var/lib/portal/templates/nda.html "/var/lib/portal/templates/nda-$PREV_SHA.html"
sudo bash /opt/dbstudio_portal/scripts/bootstrap-templates.sh
sudo systemctl restart portal-pdf.service
```
```

- [ ] **Step 6.2: Add the M8.7 row to the plan's progress table.** In `docs/superpowers/plans/2026-04-29-portal-implementation.md`, find the row after `**M8** Invoices + NDA | ✅ done | 2026-04-30 | …` and add an M8.7 row:

```markdown
| **M8.7** Multi-page NDA print design | ✅ done | 2026-04-30 | CSS-only redesign of `templates/nda.html` to render across 2+ A4 pages: `page-break-inside: avoid` on every numbered clause + parties block + signature block; `@page { margin: 20mm 18mm 20mm 25mm }`; body 9.5pt, headings 10.5pt; two 78×40mm Yousign-anchor signature rectangles on the final page (`data-yousign-anchor="provider"` / `"client"` so Yousign can place widgets via UI click or future API integration); `Página X de Y` footer via Puppeteer's `displayHeaderFooter` + footerTemplate. Removed `NdaOverflowError` + the single-page guard from `pdf-service.js` + `domain/ndas/service.js`; the `nda.draft_overflow` audit path is gone (no longer reachable). 19/19 NDA tests + 8/8 bootstrap tests, ~501 tests green + 2 skipped. RUN_PDF_E2E test now requires a valid multi-page PDF (no longer accepts overflow). Spec at `docs/superpowers/specs/2026-04-30-m8-7-multi-page-nda-design.md`. |
```

- [ ] **Step 6.3: Update the "Latest commit on main" + "Resume here" lines** below the table to point to the M8.7 head commit.

- [ ] **Step 6.4: Save, fix perms, commit.**

```bash
sudo chown root:portal-app /opt/dbstudio_portal/RUNBOOK.md /opt/dbstudio_portal/docs/superpowers/plans/2026-04-29-portal-implementation.md
sudo chmod 0640 /opt/dbstudio_portal/RUNBOOK.md /opt/dbstudio_portal/docs/superpowers/plans/2026-04-29-portal-implementation.md
cd /opt/dbstudio_portal
git add RUNBOOK.md docs/superpowers/plans/2026-04-29-portal-implementation.md
git commit -m "docs(m8.7): mark landed, update RUNBOOK + plan progress (Task 6)"
git push
```

---

## ✅ Acceptance gate

When all six tasks are committed and pushed:

- [ ] `tests/integration/ndas/generate.test.js`'s realistic-fixture e2e (RUN_PDF_E2E=1) **produces a valid PDF** — no overflow throw.
- [ ] Rendered PDF carries `/Count 2` (or higher) in its catalog → multi-page confirmed.
- [ ] Rendered PDF's sha matches the sha computed by portal-pdf and the on-disk file's sha.
- [ ] All 6 mocked NDA service tests + 3 customer-visibility tests + 7 attach-signed tests still pass.
- [ ] Coverage gates in `vitest.config.js` for `domain/ndas/**` + `lib/nda.js` still pass.
- [ ] Smoke 5/5.
- [ ] Verbatim legal text body unchanged from M8.2 (only structural CSS wrappers + the signature block changed). Compare via `git log -p templates/nda.html` — every diff hunk should be inside `<style>` blocks or `.firmas-section`, NEVER inside the legal body paragraphs.

If any acceptance gate fails: stop and ask. Don't push past a failing gate.
