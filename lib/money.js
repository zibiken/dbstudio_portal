// Currency input parsing for the admin invoice + payment forms.
//
// We store amounts as integer cents in PostgreSQL (`invoices.amount_cents`,
// `invoice_payments.amount_cents`) — that is the canonical
// representation and stays unchanged. The forms accept human-friendly
// euro decimals ("12.50", "12,50", "12") and this helper converts on
// the boundary. Centralising the parse here keeps the rounding rule
// one-line auditable and keeps "12.5" / "12.50" / "12,50" behaving
// the same.

// Accepted forms (after trim):
//   "12"      → 1200
//   "12.5"    → 1250
//   "12.50"   → 1250
//   "12,50"   → 1250 (continental European decimal separator)
//   "0.01"    → 1
//   ""        → throws (caller handles required-field error)
//   "abc"     → throws
//   "-1"      → throws
//   "12.345"  → throws (sub-cent precision rejected — would silently
//               round and confuse the user)
//
// Returns: integer cents. Throws Error on invalid input.
export function euroToCents(input) {
  if (input === null || input === undefined) {
    throw new Error('amount: required');
  }
  const raw = String(input).trim();
  if (raw === '') throw new Error('amount: required');

  // Normalise the European comma decimal to a dot.
  const normalised = raw.replace(',', '.');

  // Strict numeric format: optional digits, optional fractional part of
  // exactly 0, 1, or 2 digits. Leading +/- and exponent are rejected so
  // we can distinguish "negative" / "scientific" from "user typo".
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalised);
  if (!m) throw new Error(`amount: invalid format ${JSON.stringify(raw)} (expected euros, e.g. 12.50)`);

  const whole = m[1];
  const frac = m[2] ?? '';
  const fracPadded = (frac + '00').slice(0, 2);
  const cents = Number(whole) * 100 + Number(fracPadded);
  if (!Number.isFinite(cents) || cents < 0 || !Number.isSafeInteger(cents)) {
    throw new Error(`amount: out of range ${JSON.stringify(raw)}`);
  }
  return cents;
}

// Inverse: format an integer-cents amount as a 2-decimal euro string,
// for re-population of the form's value attribute on validation errors
// and for parse-pdf endpoint responses.
export function centsToEuroString(cents) {
  if (typeof cents !== 'number' || !Number.isInteger(cents) || cents < 0) {
    throw new Error('centsToEuroString: expected non-negative integer');
  }
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  return `${whole}.${String(frac).padStart(2, '0')}`;
}
