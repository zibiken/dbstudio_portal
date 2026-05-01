import { describe, it, expect } from 'vitest';
import { titleFor, digestSubject } from '../../../lib/digest-strings.js';

describe('digest title strings — preserved entries', () => {
  it('falls back to EN on unknown locale', () => {
    // Legacy behavior preserved: filename without recipient still renders the Phase B form.
    expect(titleFor('document.uploaded', 'fr', { filename: 'x.pdf' }))
      .toBe('New document: x.pdf');
  });

  it('returns the raw event type when there is no entry for it', () => {
    expect(titleFor('unknown.event', 'en')).toBe('unknown.event');
  });

  it('handles customer.suspended (no vars)', () => {
    expect(titleFor('customer.suspended', 'es')).toBe('Cuenta suspendida');
  });
});

describe('digest title strings — Phase F rewrites', () => {
  it('credential.created singular EN reads "uploaded a new credential"', () => {
    expect(titleFor('credential.created', 'en', { customerName: 'Acme', count: 1 }))
      .toBe('Acme uploaded a new credential to their vault');
  });

  it('credential.created plural EN reads "uploaded N new credentials"', () => {
    expect(titleFor('credential.created', 'en', { customerName: 'Acme', count: 3 }))
      .toBe('Acme uploaded 3 new credentials to their vault');
  });

  it('credential.viewed admin-recipient singular reads "DB Studio reviewed a credential of <co>\'s"', () => {
    expect(titleFor('credential.viewed', 'en', { recipient: 'admin', customerName: 'Acme', count: 1 }))
      .toBe("DB Studio reviewed a credential of Acme's");
  });

  it('credential.viewed admin-recipient plural reads "DB Studio reviewed N of <co>\'s credentials"', () => {
    expect(titleFor('credential.viewed', 'en', { recipient: 'admin', customerName: 'Acme', count: 4 }))
      .toBe("DB Studio reviewed 4 of Acme's credentials");
  });

  it('credential.viewed customer-recipient singular reads "DB Studio reviewed your credential"', () => {
    expect(titleFor('credential.viewed', 'en', { recipient: 'customer', count: 1 }))
      .toBe('DB Studio reviewed your credential');
  });

  it('credential.viewed customer-recipient plural reads "DB Studio reviewed N of your credentials"', () => {
    expect(titleFor('credential.viewed', 'en', { recipient: 'customer', count: 5 }))
      .toBe('DB Studio reviewed 5 of your credentials');
  });

  it('credential.deleted EN reads "<co> deleted a credential from their vault"', () => {
    expect(titleFor('credential.deleted', 'en', { customerName: 'Acme' }))
      .toBe('Acme deleted a credential from their vault');
  });

  it('document.uploaded customer-recipient EN reads "DB Studio uploaded a new document"', () => {
    expect(titleFor('document.uploaded', 'en', { recipient: 'customer' }))
      .toBe('DB Studio uploaded a new document');
  });

  it('document.uploaded admin-recipient EN reads "<co> uploaded a new document"', () => {
    expect(titleFor('document.uploaded', 'en', { recipient: 'admin', customerName: 'Acme' }))
      .toBe('Acme uploaded a new document');
  });

  it('invoice.paid customer-recipient EN reads "Your invoice X was marked paid"', () => {
    expect(titleFor('invoice.paid', 'en', { recipient: 'customer', invoiceNumber: 'INV-001' }))
      .toBe('Your invoice INV-001 was marked paid');
  });

  it('invoice.paid admin-recipient EN reads "<co> fully paid invoice X"', () => {
    expect(titleFor('invoice.paid', 'en', { recipient: 'admin', customerName: 'Acme', invoiceNumber: 'INV-001' }))
      .toBe('Acme fully paid invoice INV-001');
  });

  it('invoice.uploaded customer-recipient EN reads "DB Studio sent you invoice X"', () => {
    expect(titleFor('invoice.uploaded', 'en', { recipient: 'customer', invoiceNumber: 'INV-002' }))
      .toBe('DB Studio sent you invoice INV-002');
  });

  it('invoice.uploaded admin-recipient EN reads "<co> received invoice X"', () => {
    expect(titleFor('invoice.uploaded', 'en', { recipient: 'admin', customerName: 'Acme', invoiceNumber: 'INV-002' }))
      .toBe('Acme received invoice INV-002');
  });

  it('question.created customer EN reads "DB Studio asked you a question"', () => {
    expect(titleFor('question.created', 'en', { recipient: 'customer' }))
      .toBe('DB Studio asked you a question');
  });

  it('question.created customer with preview includes truncated preview', () => {
    expect(titleFor('question.created', 'en', { recipient: 'customer', questionPreview: 'What is the hosting?' }))
      .toBe('DB Studio asked you a question: What is the hosting?');
  });

  it('question.answered admin EN truncates the prompt to 60 chars', () => {
    const long = 'A'.repeat(200);
    const out = titleFor('question.answered', 'en', { recipient: 'admin', customerName: 'Acme', questionPreview: long });
    expect(out).toMatch(/^Acme answered '/);
    expect(out.length).toBeLessThanOrEqual('Acme answered '.length + 60 + 2);
  });

  it('question.skipped admin EN truncates the prompt', () => {
    expect(titleFor('question.skipped', 'en', { recipient: 'admin', customerName: 'Acme', questionPreview: 'q?' }))
      .toBe("Acme skipped 'q?'");
  });
});

describe('digestSubject', () => {
  it('returns both segments when both buckets present', () => {
    expect(digestSubject('en', { actionCount: 3, fyiCount: 8 }))
      .toBe('3 to action, 8 updates · DB Studio Portal');
  });
  it('uses singular form for count of 1', () => {
    expect(digestSubject('en', { actionCount: 1, fyiCount: 0 }))
      .toBe('1 to action · DB Studio Portal');
  });
  it('omits zero-count segments', () => {
    expect(digestSubject('en', { actionCount: 0, fyiCount: 8 }))
      .toBe('8 updates · DB Studio Portal');
  });
  it('falls back to generic copy when both counts are zero', () => {
    expect(digestSubject('en', { actionCount: 0, fyiCount: 0 }))
      .toBe('Activity update from DB Studio Portal');
  });
});
