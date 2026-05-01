import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import { parseInvoicePdf, normaliseAmount, pickLang } from '../../../lib/invoice-parser.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(__dirname, '../../fixtures');

describe('parseInvoicePdf', () => {
  it('extracts all five fields from the NL sample invoice', async () => {
    const buf = await fs.readFile(path.join(fixturesRoot, 'invoice-nl.pdf'));
    const r = await parseInvoicePdf(buf);
    expect(r.ok).toBe(true);
    expect(r.lang).toBe('nl');
    expect(r.fields.invoice_number).toBe('2026/002772');
    expect(r.fields.amount_cents).toBe(19800);
    expect(r.fields.currency).toBe('EUR');
    expect(r.fields.issued_on).toBe('2026-04-27');
    expect(r.fields.due_on).toBe('2026-05-04');
    expect(r.fields_found).toBe(4);
  });

  it('returns ok:false with reason no_text/parse_error on an empty PDF', async () => {
    const empty = Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8');
    const r = await parseInvoicePdf(empty);
    expect(r.ok).toBe(false);
    expect(['no_text', 'parse_error']).toContain(r.reason);
  });
});

describe('normaliseAmount', () => {
  const cases = [
    ['198,00', 19800],
    ['1.234,56', 123456],
    ['1,234.56', 123456],
    ['1234.56', 123456],
    ['1234', 123400],
  ];
  it.each(cases)('normalises %s to %i cents', (raw, expected) => {
    expect(normaliseAmount(raw)).toBe(expected);
  });
});

describe('pickLang', () => {
  it('detects EN when an English-shaped invoice is provided', () => {
    const text = 'INVOICE 2026/000001\nDate 27/04/2026\nDue 04/05/2026\nTOTAL 100,00€\n';
    expect(pickLang(text)).toBe('en');
  });

  it('falls back to provided locale when no labels match', () => {
    expect(pickLang('random gibberish without labels', 'es')).toBe('es');
  });
});
