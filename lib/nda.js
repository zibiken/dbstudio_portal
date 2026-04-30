import { createHash } from 'node:crypto';
import Mustache from 'mustache';

// Single source of truth for the NDA template's placeholder shape
// (templates/nda.html). The list is also enforced at render time so a
// typo in either the template or the caller's vars is caught loudly
// rather than rendering a literal "{{TYPO}}" into the legal document.
//
// Adding a placeholder requires: (1) updating the template, (2) appending
// here, (3) wiring the value source in domain/ndas/service.js. The order
// here is the order the placeholder appears in the template.
export const NDA_PLACEHOLDERS = Object.freeze([
  'CLIENTE_RAZON_SOCIAL',
  'CLIENTE_CIF',
  'CLIENTE_DOMICILIO',
  'CLIENTE_REPRESENTANTE_NOMBRE',
  'CLIENTE_REPRESENTANTE_DNI',
  'CLIENTE_REPRESENTANTE_CARGO',
  'OBJETO_PROYECTO',
  'FECHA_FIRMA',
  'LUGAR_FIRMA',
]);

const PLACEHOLDER_SET = new Set(NDA_PLACEHOLDERS);

// Mustache.render auto-escapes by default — `{{X}}` HTML-escapes,
// `{{{X}}}` does not. Every placeholder is `{{...}}` so customer-supplied
// values like razón social or domicilio cannot inject markup.
//
// Disabling Mustache's tag-mismatch check would let a typo in the
// template (e.g. `{{CLIENTE_RAZN_SOCIAL}}`) silently render as the empty
// string. We don't disable it; we additionally validate the var keys
// up-front so the failure surfaces at the call site, not in the rendered
// PDF after legal counsel notices the omission.

export function renderNda({ template, vars }) {
  if (typeof template !== 'string') {
    throw new Error('renderNda: template must be a string');
  }
  if (vars === null || typeof vars !== 'object' || Array.isArray(vars)) {
    throw new Error('renderNda: vars must be a plain object');
  }

  // Reject unknown placeholders — silent typos in the caller's vars are
  // exactly the kind of bug that ships a wrong-named-rep NDA to legal.
  for (const key of Object.keys(vars)) {
    if (!PLACEHOLDER_SET.has(key)) {
      throw new Error(`renderNda: unknown placeholder '${key}'`);
    }
  }

  // Reject missing or non-string values up-front. Mustache renders an
  // undefined key as the empty string, which would silently write a blank
  // representante into the legal text.
  for (const key of NDA_PLACEHOLDERS) {
    const v = vars[key];
    if (typeof v !== 'string') {
      throw new Error(`renderNda: var '${key}' must be a string (got ${typeof v})`);
    }
  }

  const html = Mustache.render(template, vars);
  const sha256 = createHash('sha256').update(html, 'utf8').digest('hex');
  return { html, sha256 };
}
