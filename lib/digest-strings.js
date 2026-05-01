// Phase B: localised digest title strings, one entry per event type per
// supported locale (en/nl/es). These are the human-readable lines that
// land in the digest email; they are pre-rendered at fan-out time and
// stored verbatim in pending_digest_items.title (so the digest worker
// does not need to look up customer/document/invoice rows at fire time).

const T = {
  'document.uploaded': {
    en: ({ filename }) => `New document: ${filename}`,
    nl: ({ filename }) => `Nieuw document: ${filename}`,
    es: ({ filename }) => `Nuevo documento: ${filename}`,
  },
  'document.downloaded': {
    en: ({ customerName, filename }) => `${customerName} downloaded ${filename}`,
    nl: ({ customerName, filename }) => `${customerName} heeft ${filename} gedownload`,
    es: ({ customerName, filename }) => `${customerName} descargó ${filename}`,
  },
  'nda.created': {
    en: ({ ndaTitle }) => `New NDA: ${ndaTitle} — please sign`,
    nl: ({ ndaTitle }) => `Nieuwe NDA: ${ndaTitle} — graag tekenen`,
    es: ({ ndaTitle }) => `Nuevo NDA: ${ndaTitle} — por favor, firma`,
  },
  'nda.signed': {
    en: ({ customerName, ndaTitle }) => `${customerName} signed NDA: ${ndaTitle}`,
    nl: ({ customerName, ndaTitle }) => `${customerName} ondertekende NDA: ${ndaTitle}`,
    es: ({ customerName, ndaTitle }) => `${customerName} firmó NDA: ${ndaTitle}`,
  },
  'credential_request.created': {
    en: ({ provider }) => `Credentials requested: ${provider}`,
    nl: ({ provider }) => `Inloggegevens gevraagd: ${provider}`,
    es: ({ provider }) => `Credenciales solicitadas: ${provider}`,
  },
  'credential_request.fulfilled': {
    en: ({ customerName, provider }) => `${customerName} provided ${provider} credentials`,
    nl: ({ customerName, provider }) => `${customerName} heeft ${provider}-inloggegevens gegeven`,
    es: ({ customerName, provider }) => `${customerName} proporcionó credenciales de ${provider}`,
  },
  'credential_request.not_applicable': {
    en: ({ customerName, provider }) => `${customerName} marked ${provider} as not applicable`,
    nl: ({ customerName, provider }) => `${customerName} markeerde ${provider} als niet van toepassing`,
    es: ({ customerName, provider }) => `${customerName} marcó ${provider} como no aplicable`,
  },
  'credential.viewed': {
    en: () => `DB Studio viewed 1 credential`,
    nl: () => `DB Studio bekeek 1 inloggegeven`,
    es: () => `DB Studio vio 1 credencial`,
  },
  'credential.created': {
    en: ({ customerName }) => `${customerName} added 1 credential`,
    nl: ({ customerName }) => `${customerName} voegde 1 inloggegeven toe`,
    es: ({ customerName }) => `${customerName} agregó 1 credencial`,
  },
  'credential.updated': {
    en: ({ customerName, label }) => `${customerName} updated credential: ${label}`,
    nl: ({ customerName, label }) => `${customerName} werkte inloggegeven bij: ${label}`,
    es: ({ customerName, label }) => `${customerName} actualizó la credencial: ${label}`,
  },
  'credential.deleted': {
    en: ({ customerName, label }) => `${customerName} deleted credential: ${label}`,
    nl: ({ customerName, label }) => `${customerName} verwijderde inloggegeven: ${label}`,
    es: ({ customerName, label }) => `${customerName} eliminó la credencial: ${label}`,
  },
  'invoice.uploaded': {
    en: ({ invoiceNumber, amount }) => `New invoice ${invoiceNumber} (${amount})`,
    nl: ({ invoiceNumber, amount }) => `Nieuwe factuur ${invoiceNumber} (${amount})`,
    es: ({ invoiceNumber, amount }) => `Nueva factura ${invoiceNumber} (${amount})`,
  },
  'invoice.payment_recorded': {
    en: ({ invoiceNumber, amount, paidOn }) => `Payment recorded on ${invoiceNumber}: ${amount} on ${paidOn}`,
    nl: ({ invoiceNumber, amount, paidOn }) => `Betaling geregistreerd op ${invoiceNumber}: ${amount} op ${paidOn}`,
    es: ({ invoiceNumber, amount, paidOn }) => `Pago registrado en ${invoiceNumber}: ${amount} el ${paidOn}`,
  },
  'invoice.paid': {
    en: ({ invoiceNumber }) => `Invoice ${invoiceNumber} fully paid`,
    nl: ({ invoiceNumber }) => `Factuur ${invoiceNumber} volledig betaald`,
    es: ({ invoiceNumber }) => `Factura ${invoiceNumber} totalmente pagada`,
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
};

export function titleFor(eventType, locale, vars) {
  const entry = T[eventType];
  if (!entry) return `${eventType}`;
  const fn = entry[locale] ?? entry.en;
  return fn(vars ?? {});
}
