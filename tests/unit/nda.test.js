import { describe, it, expect } from 'vitest';
import { renderNda, NDA_PLACEHOLDERS } from '../../lib/nda.js';

const MINIMAL_TEMPLATE = `
<!DOCTYPE html>
<html lang="es"><body>
  <h1>Acuerdo</h1>
  <p>Cliente: {{CLIENTE_RAZON_SOCIAL}} ({{CLIENTE_CIF}})</p>
  <p>Domicilio: {{CLIENTE_DOMICILIO}}</p>
  <p>Representante: {{CLIENTE_REPRESENTANTE_NOMBRE}}, DNI {{CLIENTE_REPRESENTANTE_DNI}}, cargo: {{CLIENTE_REPRESENTANTE_CARGO}}</p>
  <p>Objeto: {{OBJETO_PROYECTO}}</p>
  <p>Fecha: {{FECHA_FIRMA}}, Lugar: {{LUGAR_FIRMA}}</p>
</body></html>
`;

const FULL_VARS = {
  CLIENTE_RAZON_SOCIAL: 'Acme Innovaciones S.L.',
  CLIENTE_CIF: 'B12345678',
  CLIENTE_DOMICILIO: 'Calle Mayor 1, 38670 Adeje, Tenerife',
  CLIENTE_REPRESENTANTE_NOMBRE: 'María Pérez Gómez',
  CLIENTE_REPRESENTANTE_DNI: '12345678X',
  CLIENTE_REPRESENTANTE_CARGO: 'Administradora Única',
  OBJETO_PROYECTO: 'Diseño y desarrollo de un portal cliente',
  FECHA_FIRMA: '30/04/2026',
  LUGAR_FIRMA: 'Adeje',
};

describe('lib/nda renderNda', () => {
  it('substitutes every placeholder and returns html + sha256', () => {
    const r = renderNda({ template: MINIMAL_TEMPLATE, vars: FULL_VARS });
    expect(typeof r.html).toBe('string');
    expect(typeof r.sha256).toBe('string');
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);

    expect(r.html).toContain('Acme Innovaciones S.L.');
    expect(r.html).toContain('B12345678');
    expect(r.html).toContain('Calle Mayor 1, 38670 Adeje, Tenerife');
    // Mustache preserves UTF-8 verbatim and only HTML-escapes special
    // chars (< > & " ' /) — so accented letters round-trip as bytes.
    expect(r.html).toContain('María Pérez Gómez');
    // Mustache escapes '/' to '&#x2F;', which still renders as '/' to a
    // human reader. Either form is acceptable; assert the digits round-trip.
    expect(r.html).toMatch(/30.{0,7}04.{0,7}2026/);
    expect(r.html).toContain('Adeje');
  });

  it('renders identical output → identical sha for identical inputs (template_version_sha contract)', () => {
    const a = renderNda({ template: MINIMAL_TEMPLATE, vars: FULL_VARS });
    const b = renderNda({ template: MINIMAL_TEMPLATE, vars: FULL_VARS });
    expect(a.sha256).toBe(b.sha256);
    expect(a.html).toBe(b.html);
  });

  it('a single-character edit to the template flips the sha (auditability)', () => {
    const a = renderNda({ template: MINIMAL_TEMPLATE, vars: FULL_VARS });
    const tweaked = MINIMAL_TEMPLATE.replace('Acuerdo', 'Acuerdo.');
    const b = renderNda({ template: tweaked, vars: FULL_VARS });
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('different vars on the same template flip the sha', () => {
    const a = renderNda({ template: MINIMAL_TEMPLATE, vars: FULL_VARS });
    const b = renderNda({
      template: MINIMAL_TEMPLATE,
      vars: { ...FULL_VARS, CLIENTE_RAZON_SOCIAL: 'Otra S.L.' },
    });
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('escapes HTML in customer-supplied fields (Mustache auto-escape)', () => {
    const r = renderNda({
      template: MINIMAL_TEMPLATE,
      vars: {
        ...FULL_VARS,
        CLIENTE_DOMICILIO: 'Calle <script>alert(1)</script> 1',
      },
    });
    expect(r.html).not.toContain('<script>alert(1)</script>');
    expect(r.html).toContain('&lt;script&gt;');
  });

  it('refuses an unknown placeholder (typo guard)', () => {
    expect(() => renderNda({
      template: MINIMAL_TEMPLATE,
      vars: { ...FULL_VARS, EXTRA_FIELD: 'oops' },
    })).toThrow(/EXTRA_FIELD/);
  });

  it('refuses a missing required placeholder', () => {
    const incomplete = { ...FULL_VARS };
    delete incomplete.OBJETO_PROYECTO;
    expect(() => renderNda({ template: MINIMAL_TEMPLATE, vars: incomplete }))
      .toThrow(/OBJETO_PROYECTO/);
  });

  it('refuses a non-string var value (e.g., undefined null Date)', () => {
    expect(() => renderNda({
      template: MINIMAL_TEMPLATE,
      vars: { ...FULL_VARS, FECHA_FIRMA: new Date() },
    })).toThrow(/FECHA_FIRMA/);
  });

  it('exports the canonical placeholder list (single source of truth)', () => {
    expect(NDA_PLACEHOLDERS).toEqual([
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
  });
});
