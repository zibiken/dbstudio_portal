// Single source of truth for human-readable date display anywhere in
// this portal. Hardcoded to Europe/Madrid (the operator's timezone)
// and DD/MM/YYYY + DD/MM/YYYY HH:mm 24h, both for emails and for any
// EJS view rendered by lib/render.js. Mirrors the dbstudio.one
// marketing site's contact-form email (src/lib/mail.ts) so the brand
// shows the same date format wherever it appears.

const EU_DATE = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const EU_DATETIME = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function toDate(input) {
  if (input == null || input === '') return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function euDate(input) {
  const d = toDate(input);
  if (d) return EU_DATE.format(d);
  return input == null ? '' : String(input);
}

export function euDateTime(input) {
  const d = toDate(input);
  if (!d) return input == null ? '' : String(input);
  return EU_DATETIME.format(d).replace(',', '');
}
