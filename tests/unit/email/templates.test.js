import { describe, it, expect } from 'vitest';
import { renderTemplate, listTemplates } from '../../../lib/email-templates.js';

const ISO_DATE = '2026-05-06';
const ISO_DATETIME = '2026-04-29T12:32:00Z';
const EU_DATE = '06/05/2026';
const EU_DATETIME = '29/04/2026 13:32';

const EXPECTED_SLUGS = [
  '2fa-reset-by-admin',
  'admin-alert-invite-unused-7d',
  'admin-pw-reset',
  'admin-welcome',
  'credential-request-created',
  'customer-invitation',
  'customer-pw-reset',
  'digest',
  'email-change-notification-old',
  'email-change-verification',
  'email-otp-code',
  'generic-admin-message',
  'invite-expiring-soon',
  'nda-ready',
  'new-device-login',
  'new-document-available',
  'new-invoice',
];

const SAMPLES = {
  'customer-invitation': {
    locals: {
      recipientName: 'Bram',
      inviteUrl: 'https://portal.dbstudio.one/welcome/abc123',
      expiresAt: ISO_DATE,
    },
    subjectMatches: /invit|welcome/i,
    bodyContains: ['Bram', 'https://portal.dbstudio.one/welcome/abc123', EU_DATE],
  },
  'customer-pw-reset': {
    locals: {
      recipientName: 'Bram',
      resetUrl: 'https://portal.dbstudio.one/reset/cust-token',
      expiresAt: ISO_DATE,
    },
    subjectMatches: /reset|password/i,
    bodyContains: ['https://portal.dbstudio.one/reset/cust-token', EU_DATE],
  },
  'admin-pw-reset': {
    locals: {
      recipientName: 'Bram',
      resetUrl: 'https://portal.dbstudio.one/reset/admin-token',
      expiresAt: ISO_DATE,
    },
    subjectMatches: /reset|password/i,
    bodyContains: ['https://portal.dbstudio.one/reset/admin-token', EU_DATE],
  },
  'admin-welcome': {
    locals: {
      recipientName: 'Bram',
      welcomeUrl: 'https://portal.dbstudio.one/welcome/admin-welcome-token',
      expiresAt: ISO_DATE,
    },
    subjectMatches: /welcome|admin/i,
    bodyContains: ['Bram', 'https://portal.dbstudio.one/welcome/admin-welcome-token', EU_DATE],
  },
  'email-otp-code': {
    locals: {
      recipientName: 'Bram',
      code: '482194',
    },
    subjectMatches: /sign-in code|verification code|one-time code/i,
    bodyContains: ['482194'],
  },
  '2fa-reset-by-admin': {
    locals: {
      recipientName: 'Bram',
      adminName: 'Operator',
      resetUrl: 'https://portal.dbstudio.one/reset/2fa-token',
    },
    subjectMatches: /two-factor|2fa/i,
    bodyContains: ['Operator', 'https://portal.dbstudio.one/reset/2fa-token'],
  },
  'email-change-verification': {
    locals: {
      recipientName: 'Bram',
      newEmail: 'new@example.com',
      verifyUrl: 'https://portal.dbstudio.one/verify-email/tok',
      expiresAt: ISO_DATE,
    },
    subjectMatches: /verify|email/i,
    bodyContains: ['new@example.com', 'https://portal.dbstudio.one/verify-email/tok', EU_DATE],
  },
  'email-change-notification-old': {
    locals: {
      recipientName: 'Bram',
      oldEmail: 'old@example.com',
      newEmail: 'new@example.com',
      revertUrl: 'https://portal.dbstudio.one/revert-email/tok',
      changedAt: ISO_DATETIME,
    },
    subjectMatches: /email|address|chang/i,
    bodyContains: ['old@example.com', 'new@example.com', 'https://portal.dbstudio.one/revert-email/tok', EU_DATETIME],
  },
  'new-device-login': {
    locals: {
      recipientName: 'Bram',
      ip: '203.0.113.42',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      when: ISO_DATETIME,
      sessionsUrl: 'https://portal.dbstudio.one/profile/sessions',
    },
    subjectMatches: /sign-in|new device|login/i,
    bodyContains: ['203.0.113.42', 'https://portal.dbstudio.one/profile/sessions', EU_DATETIME],
  },
  'new-document-available': {
    locals: {
      recipientName: 'Bram',
      documentName: 'Q2 2026 Status Report',
      documentUrl: 'https://portal.dbstudio.one/documents/doc-id',
    },
    subjectMatches: /document/i,
    bodyContains: ['Q2 2026 Status Report', 'https://portal.dbstudio.one/documents/doc-id'],
  },
  'new-invoice': {
    locals: {
      recipientName: 'Bram',
      invoiceNumber: 'INV-2026-0042',
      amount: '€ 4,800.00',
      dueDate: '2026-05-15',
      invoiceUrl: 'https://portal.dbstudio.one/invoices/inv-id',
    },
    subjectMatches: /invoice/i,
    bodyContains: ['INV-2026-0042', '€ 4,800.00', '15/05/2026', 'https://portal.dbstudio.one/invoices/inv-id'],
  },
  'credential-request-created': {
    locals: {
      recipientName: 'Operator',
      customerName: 'Acme Industries',
      requestUrl: 'https://portal.dbstudio.one/admin/credential-requests/req-id',
    },
    subjectMatches: /credential/i,
    bodyContains: ['Acme Industries', 'https://portal.dbstudio.one/admin/credential-requests/req-id'],
  },
  'nda-ready': {
    locals: {
      recipientName: 'Bram',
      customerName: 'Acme Industries',
      ndaUrl: 'https://portal.dbstudio.one/ndas/nda-id',
    },
    subjectMatches: /nda|non-disclosure/i,
    bodyContains: ['Acme Industries', 'https://portal.dbstudio.one/ndas/nda-id'],
  },
  'generic-admin-message': {
    locals: {
      recipientName: 'Bram',
      adminName: 'Operator',
      message: 'Quick heads-up: the staging deploy goes live tomorrow.',
      portalUrl: 'https://portal.dbstudio.one',
    },
    subjectMatches: /message|note|update/i,
    bodyContains: ['Operator', 'staging deploy goes live tomorrow'],
  },
  'invite-expiring-soon': {
    locals: {
      recipientName: 'Bram',
      inviteUrl: 'https://portal.dbstudio.one/welcome/exp-token',
      expiresAt: ISO_DATE,
    },
    subjectMatches: /expir|invitation/i,
    bodyContains: ['https://portal.dbstudio.one/welcome/exp-token', EU_DATE],
  },
  'admin-alert-invite-unused-7d': {
    locals: {
      recipientName: 'Operator',
      customerName: 'Acme Industries',
      customerEmail: 'contact@acme.example',
      adminUrl: 'https://portal.dbstudio.one/admin/customers/cust-id',
    },
    subjectMatches: /invit|unused|customer/i,
    bodyContains: ['Acme Industries', 'contact@acme.example', 'https://portal.dbstudio.one/admin/customers/cust-id'],
  },
};

describe('email templates', () => {
  it('lists exactly the 17 expected slugs', () => {
    expect(listTemplates()).toEqual(EXPECTED_SLUGS);
  });

  for (const [slug, sample] of Object.entries(SAMPLES)) {
    it(`renders ${slug}: subject + brand-faithful HTML body`, () => {
      const { subject, body } = renderTemplate(slug, 'en', sample.locals);

      expect(subject, 'subject').toMatch(sample.subjectMatches);
      expect(subject.length, 'subject length').toBeGreaterThan(0);
      expect(subject.length, 'subject length').toBeLessThan(120);

      expect(body, 'body starts with doctype').toMatch(/^<!doctype html/i);
      expect(body, 'body has html tag').toMatch(/<html\s/i);
      expect(body, 'body has closing html').toMatch(/<\/html>/i);

      // brand markers
      expect(body, 'obsidian outer bg').toContain('#0A0A0A');
      expect(body, 'carbon card bg').toContain('#111111');
      expect(body, 'logo from dbstudio.one').toMatch(/dbstudio\.one\/logo-white\.png/);
      expect(body, 'legal footer').toContain('Solbizz Canarias S.L.');

      for (const token of sample.bodyContains) {
        expect(body, `body contains "${token}"`).toContain(token);
      }
    });
  }

  it('falls back to en for unknown locale', () => {
    const { subject, body } = renderTemplate(
      'customer-invitation',
      'es',
      SAMPLES['customer-invitation'].locals,
    );
    expect(subject).toBeTruthy();
    expect(body).toMatch(/^<!doctype html/i);
  });

  it('throws on unknown slug', () => {
    expect(() => renderTemplate('not-a-real-slug', 'en', {})).toThrow(/Unknown email template/);
  });

  it('formats dates in DD/MM/YYYY (Atlantic/Canary), regardless of system TZ', () => {
    // WEST (UTC+1): 23:30 UTC on 6 May → 00:30 7 May Canary time
    const { body } = renderTemplate('customer-invitation', 'en', {
      recipientName: 'Bram',
      inviteUrl: 'https://portal.dbstudio.one/welcome/abc',
      expiresAt: '2026-05-06T23:30:00Z',
    });
    expect(body).toContain('07/05/2026');
  });

  it('formats datetimes in DD/MM/YYYY HH:mm 24h (Atlantic/Canary)', () => {
    // WEST (UTC+1): 23:32 UTC on 29 April → 00:32 30 April Canary time
    const { body } = renderTemplate('new-device-login', 'en', {
      recipientName: 'Bram',
      ip: '1.2.3.4',
      userAgent: 'UA',
      when: '2026-04-29T23:32:00Z',
      sessionsUrl: 'https://portal.dbstudio.one/profile/sessions',
    });
    expect(body).toContain('30/04/2026 00:32');
  });

  it('escapes HTML in user-supplied locals', () => {
    const { body } = renderTemplate('customer-invitation', 'en', {
      ...SAMPLES['customer-invitation'].locals,
      recipientName: '<script>alert(1)</script>',
    });
    expect(body, 'no raw script tag from locals').not.toContain('<script>alert(1)</script>');
    expect(body, 'escaped form present').toMatch(/&lt;script&gt;/);
  });
});
