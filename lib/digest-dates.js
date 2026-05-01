// Phase F: format a digest item's timestamp as a human-readable label
// relative to "now" in the recipient's timezone. Output:
//   - "Today"            (same calendar day)
//   - "Yesterday"        (previous calendar day)
//   - "<weekday>"        (2-6 days ago)
//   - "dd MMM"           (older, current year)
//   - "dd MMM yyyy"      (older, past year boundary)
//
// All comparisons happen in the supplied tz so a 23:30 UTC item from
// "yesterday" in UTC reads as "Today" in the recipient's local view if
// that is what their wall clock shows.

const FMT_CACHE = new Map();
function fmt(locale, options) {
  const key = locale + JSON.stringify(options);
  if (!FMT_CACHE.has(key)) {
    FMT_CACHE.set(key, new Intl.DateTimeFormat(locale, options));
  }
  return FMT_CACHE.get(key);
}

function ymdInTz(date, tz) {
  const parts = Object.fromEntries(
    fmt('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function diffInDays(ymdA, ymdB) {
  // Both are yyyy-mm-dd strings; treat as midnight UTC for diff math.
  const [ya, ma, da] = ymdA.split('-').map(Number);
  const [yb, mb, db] = ymdB.split('-').map(Number);
  const a = Date.UTC(ya, ma - 1, da);
  const b = Date.UTC(yb, mb - 1, db);
  return Math.round((a - b) / 86_400_000);
}

const TODAY = { en: 'Today', nl: 'Vandaag', es: 'Hoy' };
const YESTERDAY = { en: 'Yesterday', nl: 'Gisteren', es: 'Ayer' };

export function humanDate(ts, locale, tz, now = new Date()) {
  const tsYmd  = ymdInTz(ts, tz);
  const nowYmd = ymdInTz(now, tz);
  const days = diffInDays(nowYmd, tsYmd);

  if (days === 0) return TODAY[locale] ?? TODAY.en;
  if (days === 1) return YESTERDAY[locale] ?? YESTERDAY.en;
  if (days >= 2 && days <= 6) {
    return fmt(locale, { timeZone: tz, weekday: 'long' }).format(ts);
  }

  // For "dd MMM" / "dd MMM yyyy" we use the EU day-first ordering for EN
  // by mapping to en-GB; nl/es default to their own day-first ordering.
  const dateLocale = locale === 'en' ? 'en-GB' : locale;
  const tsYear  = Number(tsYmd.split('-')[0]);
  const nowYear = Number(nowYmd.split('-')[0]);
  if (tsYear === nowYear) {
    return fmt(dateLocale, { timeZone: tz, day: 'numeric', month: 'short' }).format(ts);
  }
  return fmt(dateLocale, { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' }).format(ts);
}
