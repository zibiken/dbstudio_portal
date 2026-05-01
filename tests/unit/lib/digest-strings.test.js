import { describe, it, expect } from 'vitest';
import { titleFor } from '../../../lib/digest-strings.js';

describe('digest title strings', () => {
  it('formats document.uploaded for customer in EN', () => {
    expect(titleFor('document.uploaded', 'en', { filename: 'report.pdf' })).toBe('New document: report.pdf');
  });

  it('formats document.uploaded for customer in NL', () => {
    expect(titleFor('document.uploaded', 'nl', { filename: 'verslag.pdf' })).toBe('Nieuw document: verslag.pdf');
  });

  it('formats document.uploaded for customer in ES', () => {
    expect(titleFor('document.uploaded', 'es', { filename: 'informe.pdf' })).toBe('Nuevo documento: informe.pdf');
  });

  it('falls back to EN on unknown locale', () => {
    expect(titleFor('document.uploaded', 'fr', { filename: 'x.pdf' })).toBe('New document: x.pdf');
  });

  it('returns the raw event type when there is no entry for it', () => {
    expect(titleFor('unknown.event', 'en')).toBe('unknown.event');
  });

  it('handles customer.suspended (no vars)', () => {
    expect(titleFor('customer.suspended', 'es')).toBe('Cuenta suspendida');
  });
});
