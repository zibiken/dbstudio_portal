// Server-side invoice OCR (Phase C). Parses operator-emitted PDFs with
// known label conventions in NL/EN/ES, extracts five header fields,
// returns canonical values. No persistence; pure function over bytes.
//
// pdf-parse ships as a CommonJS module that probes for a debug-mode
// fixture on import — the named subpath import side-steps that.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const LABELS = {
  invoice: { nl: 'FACTUUR', en: 'INVOICE', es: 'FACTURA' },
  date:    { nl: 'Datum',   en: 'Date',    es: 'Fecha' },
  due:     { nl: 'Te verwachten', en: 'Due', es: 'Vencimiento' },
};

// pdf-parse strips column whitespace so the operator's invoice has the
// total written as 'TOTAAL198,00€' (no separator between word and number).
// Use \s* not \s+. The column-header occurrence ('…TOTAAL' with no digits
// after) is filtered out by requiring a digit. SUBTOTAAL185,05€ also
// matches because TOTAAL is a substring of SUBTOTAAL — that's fine, we
// take the last match (the grand total) per matchAll order.
const TOTAL_RE = /(TOTAAL|TOTAL)\s*([\d][\d.,]*)\s*€/g;

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function pickLang(text, fallback = 'en') {
  const score = { nl: 0, en: 0, es: 0 };
  for (const lang of ['nl', 'en', 'es']) {
    if (new RegExp(`^\\s*${escape(LABELS.invoice[lang])}\\s+`, 'm').test(text)) score[lang]++;
    if (new RegExp(`(?<!\\w)${escape(LABELS.date[lang])}\\s+\\d{2}\\/\\d{2}\\/\\d{4}`).test(text)) score[lang]++;
    if (new RegExp(`(?<!\\w)${escape(LABELS.due[lang])}\\s+\\d{2}\\/\\d{2}\\/\\d{4}`).test(text)) score[lang]++;
  }
  // 'TOTAAL' is NL-specific; 'TOTAL' is ambiguous EN/ES.
  if (/TOTAAL/.test(text)) score.nl++;

  let best = null, bestScore = -1;
  for (const lang of ['nl', 'en', 'es']) {
    if (score[lang] > bestScore) { best = lang; bestScore = score[lang]; }
  }
  if (bestScore < 2) return fallback;
  return best;
}

export function normaliseAmount(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let normalised;
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastComma > lastDot) {
      normalised = s.replace(/\./g, '').replace(',', '.');
    } else {
      normalised = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    normalised = s.replace(',', '.');
  } else if (hasDot) {
    const m = s.match(/\.(\d+)$/);
    if (m && m[1].length === 2) normalised = s;
    else normalised = s.replace(/\./g, '');
  } else {
    normalised = s;
  }
  const n = Number.parseFloat(normalised);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function ddmmyyyyToISO(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  const dd = Number(m[1]), mm = Number(m[2]), yyyy = Number(m[3]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function findInvoiceNumber(text, lang) {
  const word = LABELS.invoice[lang];
  const re = new RegExp(`^\\s*${escape(word)}\\s+([A-Z0-9/-]*\\d[A-Z0-9/-]*)\\s*$`, 'mi');
  const m = re.exec(text);
  return m ? m[1] : null;
}

function findDate(text, lang, kind) {
  const word = LABELS[kind][lang];
  const re = new RegExp(`(?<!\\w)${escape(word)}\\s+(\\d{2}\\/\\d{2}\\/\\d{4})`);
  const m = re.exec(text);
  if (!m) return null;
  return ddmmyyyyToISO(m[1]);
}

function findTotal(text) {
  let last = null;
  for (const m of text.matchAll(TOTAL_RE)) {
    last = m[2];
  }
  return last ? normaliseAmount(last) : null;
}

export async function parseInvoicePdf(buffer, opts = {}) {
  let parsed;
  try {
    parsed = await pdfParse(buffer);
  } catch (err) {
    return { ok: false, reason: 'parse_error', message: err?.message ?? 'unknown' };
  }
  const text = (parsed?.text ?? '').trim();
  if (!text) return { ok: false, reason: 'no_text' };

  const lang = pickLang(text, opts.fallbackLocale ?? 'en');
  const fields = {};
  const inv = findInvoiceNumber(text, lang);
  if (inv) fields.invoice_number = inv;
  const issued = findDate(text, lang, 'date');
  if (issued) fields.issued_on = issued;
  const due = findDate(text, lang, 'due');
  if (due) fields.due_on = due;
  const amt = findTotal(text);
  if (amt) fields.amount_cents = amt;
  fields.currency = 'EUR';

  const fields_found = ['invoice_number', 'amount_cents', 'issued_on', 'due_on']
    .filter((k) => fields[k] !== undefined).length;

  return { ok: true, lang, fields, fields_found, warnings: [] };
}
