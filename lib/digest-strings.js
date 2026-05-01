// Phase B (rewritten in Phase F): localised digest title strings, one
// entry per event type per supported locale (en/nl/es). Phase F adds:
//   - count-aware singular/plural forms for COALESCING_EVENTS
//   - recipient-aware copy for events fanned to both admins and customers
//     (e.g. invoice.paid: "Your invoice X was marked paid" for customer
//     recipient, "Acme fully paid invoice X" for admin recipient)
//   - natural-language verbs (uploaded, reviewed, marked, ...) replacing
//     the developer-flavoured phrasings of the Phase B baseline
//
// NL and ES files mirror EN until the deferred i18n phase lands. Single
// source of truth lives here; the digest worker calls titleFor at fan-out
// time and stores the rendered string verbatim in pending_digest_items.

function truncate(s, max) {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

const T = {
  'document.uploaded': {
    en: ({ filename, recipient, customerName }) => {
      if (recipient === 'admin') return `${customerName ?? 'Customer'} uploaded a new document`;
      if (recipient === 'customer') return 'DB Studio uploaded a new document';
      // Legacy callers (no recipient passed) keep the Phase B form.
      if (filename) return `New document: ${filename}`;
      return 'DB Studio uploaded a new document';
    },
    nl: ({ filename, recipient, customerName }) => {
      if (recipient === 'admin') return `${customerName ?? 'Customer'} uploaded a new document`;
      if (recipient === 'customer') return 'DB Studio uploaded a new document';
      if (filename) return `Nieuw document: ${filename}`;
      return 'DB Studio uploaded a new document';
    },
    es: ({ filename, recipient, customerName }) => {
      if (recipient === 'admin') return `${customerName ?? 'Customer'} uploaded a new document`;
      if (recipient === 'customer') return 'DB Studio uploaded a new document';
      if (filename) return `Nuevo documento: ${filename}`;
      return 'DB Studio uploaded a new document';
    },
  },
  'document.downloaded': {
    en: ({ customerName, filename }) => `DB Studio reviewed ${customerName}'s ${filename}`,
    nl: ({ customerName, filename }) => `DB Studio reviewed ${customerName}'s ${filename}`,
    es: ({ customerName, filename }) => `DB Studio reviewed ${customerName}'s ${filename}`,
  },
  'nda.created': {
    en: ({ ndaTitle }) => `New NDA: ${ndaTitle} — please sign`,
    nl: ({ ndaTitle }) => `Nieuwe NDA: ${ndaTitle} — graag tekenen`,
    es: ({ ndaTitle }) => `Nuevo NDA: ${ndaTitle} — por favor, firma`,
  },
  'nda.signed': {
    en: ({ customerName, ndaTitle }) => customerName
      ? `${customerName}'s signed NDA is on file`
      : `Signed NDA is on file: ${ndaTitle}`,
    nl: ({ customerName, ndaTitle }) => customerName
      ? `${customerName}'s signed NDA is on file`
      : `Signed NDA is on file: ${ndaTitle}`,
    es: ({ customerName, ndaTitle }) => customerName
      ? `${customerName}'s signed NDA is on file`
      : `Signed NDA is on file: ${ndaTitle}`,
  },
  'credential_request.created': {
    en: ({ provider }) => `Credentials requested: ${provider}`,
    nl: ({ provider }) => `Inloggegevens gevraagd: ${provider}`,
    es: ({ provider }) => `Credenciales solicitadas: ${provider}`,
  },
  'credential_request.fulfilled': {
    en: ({ customerName, provider }) => `${customerName} filled in ${provider} credentials`,
    nl: ({ customerName, provider }) => `${customerName} filled in ${provider} credentials`,
    es: ({ customerName, provider }) => `${customerName} filled in ${provider} credentials`,
  },
  'credential_request.not_applicable': {
    en: ({ customerName, provider }) => `${customerName} marked ${provider} as not applicable`,
    nl: ({ customerName, provider }) => `${customerName} marked ${provider} as not applicable`,
    es: ({ customerName, provider }) => `${customerName} marked ${provider} as not applicable`,
  },
  'credential.viewed': {
    en: ({ customerName, count = 1, recipient }) => {
      if (recipient === 'customer') {
        return count === 1
          ? 'DB Studio reviewed your credential'
          : `DB Studio reviewed ${count} of your credentials`;
      }
      // Default: admin recipient
      return count === 1
        ? `DB Studio reviewed a credential of ${customerName}'s`
        : `DB Studio reviewed ${count} of ${customerName}'s credentials`;
    },
    nl: ({ customerName, count = 1, recipient }) => {
      if (recipient === 'customer') {
        return count === 1
          ? 'DB Studio reviewed your credential'
          : `DB Studio reviewed ${count} of your credentials`;
      }
      return count === 1
        ? `DB Studio reviewed a credential of ${customerName}'s`
        : `DB Studio reviewed ${count} of ${customerName}'s credentials`;
    },
    es: ({ customerName, count = 1, recipient }) => {
      if (recipient === 'customer') {
        return count === 1
          ? 'DB Studio reviewed your credential'
          : `DB Studio reviewed ${count} of your credentials`;
      }
      return count === 1
        ? `DB Studio reviewed a credential of ${customerName}'s`
        : `DB Studio reviewed ${count} of ${customerName}'s credentials`;
    },
  },
  'credential.created': {
    en: ({ customerName, count = 1 }) => count === 1
      ? `${customerName} uploaded a new credential to their vault`
      : `${customerName} uploaded ${count} new credentials to their vault`,
    nl: ({ customerName, count = 1 }) => count === 1
      ? `${customerName} uploaded a new credential to their vault`
      : `${customerName} uploaded ${count} new credentials to their vault`,
    es: ({ customerName, count = 1 }) => count === 1
      ? `${customerName} uploaded a new credential to their vault`
      : `${customerName} uploaded ${count} new credentials to their vault`,
  },
  'credential.updated': {
    en: ({ customerName, label }) => `${customerName} updated credential: ${label}`,
    nl: ({ customerName, label }) => `${customerName} updated credential: ${label}`,
    es: ({ customerName, label }) => `${customerName} updated credential: ${label}`,
  },
  'credential.deleted': {
    en: ({ customerName }) => `${customerName} deleted a credential from their vault`,
    nl: ({ customerName }) => `${customerName} deleted a credential from their vault`,
    es: ({ customerName }) => `${customerName} deleted a credential from their vault`,
  },
  'invoice.uploaded': {
    en: ({ recipient, customerName, invoiceNumber, amount }) => {
      if (recipient === 'admin') return `${customerName} received invoice ${invoiceNumber}`;
      if (recipient === 'customer') return `DB Studio sent you invoice ${invoiceNumber}`;
      return `New invoice ${invoiceNumber} (${amount})`;
    },
    nl: ({ recipient, customerName, invoiceNumber, amount }) => {
      if (recipient === 'admin') return `${customerName} received invoice ${invoiceNumber}`;
      if (recipient === 'customer') return `DB Studio sent you invoice ${invoiceNumber}`;
      return `Nieuwe factuur ${invoiceNumber} (${amount})`;
    },
    es: ({ recipient, customerName, invoiceNumber, amount }) => {
      if (recipient === 'admin') return `${customerName} received invoice ${invoiceNumber}`;
      if (recipient === 'customer') return `DB Studio sent you invoice ${invoiceNumber}`;
      return `Nueva factura ${invoiceNumber} (${amount})`;
    },
  },
  'invoice.payment_recorded': {
    en: ({ invoiceNumber, amount, paidOn }) => `Payment recorded on ${invoiceNumber}: ${amount} on ${paidOn}`,
    nl: ({ invoiceNumber, amount, paidOn }) => `Betaling geregistreerd op ${invoiceNumber}: ${amount} op ${paidOn}`,
    es: ({ invoiceNumber, amount, paidOn }) => `Pago registrado en ${invoiceNumber}: ${amount} el ${paidOn}`,
  },
  'invoice.paid': {
    en: ({ recipient, customerName, invoiceNumber }) => {
      if (recipient === 'customer') return `Your invoice ${invoiceNumber} was marked paid`;
      if (recipient === 'admin') return `${customerName} fully paid invoice ${invoiceNumber}`;
      return `Invoice ${invoiceNumber} fully paid`;
    },
    nl: ({ recipient, customerName, invoiceNumber }) => {
      if (recipient === 'customer') return `Your invoice ${invoiceNumber} was marked paid`;
      if (recipient === 'admin') return `${customerName} fully paid invoice ${invoiceNumber}`;
      return `Factuur ${invoiceNumber} volledig betaald`;
    },
    es: ({ recipient, customerName, invoiceNumber }) => {
      if (recipient === 'customer') return `Your invoice ${invoiceNumber} was marked paid`;
      if (recipient === 'admin') return `${customerName} fully paid invoice ${invoiceNumber}`;
      return `Factura ${invoiceNumber} totalmente pagada`;
    },
  },
  'project.created': {
    en: ({ projectName }) => `New project: ${projectName}`,
    nl: ({ projectName }) => `Nieuw project: ${projectName}`,
    es: ({ projectName }) => `Nuevo proyecto: ${projectName}`,
  },
  'project.status_changed': {
    en: ({ projectName, status }) => `Project ${projectName} → ${status}`,
    nl: ({ projectName, status }) => `Project ${projectName} → ${status}`,
    es: ({ projectName, status }) => `Proyecto ${projectName} → ${status}`,
  },
  'customer.suspended': {
    en: () => `Account suspended`,
    nl: () => `Account opgeschort`,
    es: () => `Cuenta suspendida`,
  },
  'customer.reactivated': {
    en: () => `Account reactivated`,
    nl: () => `Account geheractiveerd`,
    es: () => `Cuenta reactivada`,
  },
  'customer.archived': {
    en: () => `Account archived`,
    nl: () => `Account gearchiveerd`,
    es: () => `Cuenta archivada`,
  },
  'question.created': {
    en: ({ questionPreview }) => questionPreview
      ? `DB Studio asked you a question: ${truncate(questionPreview, 60)}`
      : 'DB Studio asked you a question',
    nl: ({ questionPreview }) => questionPreview
      ? `DB Studio asked you a question: ${truncate(questionPreview, 60)}`
      : 'DB Studio asked you a question',
    es: ({ questionPreview }) => questionPreview
      ? `DB Studio asked you a question: ${truncate(questionPreview, 60)}`
      : 'DB Studio asked you a question',
  },
  'question.answered': {
    en: ({ customerName, questionPreview }) =>
      `${customerName ?? 'A customer'} answered '${truncate(questionPreview ?? '', 60)}'`,
    nl: ({ customerName, questionPreview }) =>
      `${customerName ?? 'A customer'} answered '${truncate(questionPreview ?? '', 60)}'`,
    es: ({ customerName, questionPreview }) =>
      `${customerName ?? 'A customer'} answered '${truncate(questionPreview ?? '', 60)}'`,
  },
  'question.skipped': {
    en: ({ customerName, questionPreview }) =>
      `${customerName ?? 'A customer'} skipped '${truncate(questionPreview ?? '', 60)}'`,
    nl: ({ customerName, questionPreview }) =>
      `${customerName ?? 'A customer'} skipped '${truncate(questionPreview ?? '', 60)}'`,
    es: ({ customerName, questionPreview }) =>
      `${customerName ?? 'A customer'} skipped '${truncate(questionPreview ?? '', 60)}'`,
  },
};

export function titleFor(eventType, locale, vars) {
  const entry = T[eventType];
  if (!entry) return `${eventType}`;
  const fn = entry[locale] ?? entry.en;
  return fn(vars ?? {});
}

const DIGEST_SUBJECT = {
  en: ({ actionCount, fyiCount }) => buildEnSubject(actionCount, fyiCount),
  nl: ({ actionCount, fyiCount }) => buildEnSubject(actionCount, fyiCount), // mirror EN for v1
  es: ({ actionCount, fyiCount }) => buildEnSubject(actionCount, fyiCount), // mirror EN for v1
};

function buildEnSubject(action, fyi) {
  const parts = [];
  if (action > 0) parts.push(action === 1 ? '1 to action' : `${action} to action`);
  if (fyi > 0)    parts.push(fyi === 1 ? '1 update' : `${fyi} updates`);
  if (parts.length === 0) return 'Activity update from DB Studio Portal';
  return `${parts.join(', ')} · DB Studio Portal`;
}

export function digestSubject(locale, { actionCount, fyiCount }) {
  const fn = DIGEST_SUBJECT[locale] ?? DIGEST_SUBJECT.en;
  return fn({ actionCount: Number(actionCount) || 0, fyiCount: Number(fyiCount) || 0 });
}
