import { describe, it, expect } from 'vitest';
import { humanDate } from '../../../lib/digest-dates.js';

const TZ = 'Atlantic/Canary';

describe('humanDate', () => {
  it('returns "Today" for same calendar day in tz', () => {
    const now = new Date('2026-05-01T12:00:00Z');
    const ts  = new Date('2026-05-01T08:00:00Z');
    expect(humanDate(ts, 'en', TZ, now)).toBe('Today');
  });

  it('returns "Yesterday" for previous calendar day in tz', () => {
    const now = new Date('2026-05-01T12:00:00Z');
    const ts  = new Date('2026-04-30T20:00:00Z');
    expect(humanDate(ts, 'en', TZ, now)).toBe('Yesterday');
  });

  it('returns weekday name for 2-6 days ago in EN', () => {
    const now = new Date('2026-05-08T12:00:00Z'); // Friday
    const ts  = new Date('2026-05-04T12:00:00Z'); // Monday
    expect(humanDate(ts, 'en', TZ, now)).toBe('Monday');
  });

  it('returns "dd MMM" format for older dates within current year (EN)', () => {
    const now = new Date('2026-05-15T12:00:00Z');
    const ts  = new Date('2026-01-12T12:00:00Z');
    expect(humanDate(ts, 'en', TZ, now)).toMatch(/^12 Jan\.?$/);
  });

  it('returns "dd MMM yyyy" past year boundary', () => {
    const now = new Date('2026-05-15T12:00:00Z');
    const ts  = new Date('2025-11-12T12:00:00Z');
    expect(humanDate(ts, 'en', TZ, now)).toMatch(/^12 Nov\.? 2025$/);
  });

  it('renders Spanish weekday for 2-6 days ago', () => {
    const now = new Date('2026-05-08T12:00:00Z'); // viernes
    const ts  = new Date('2026-05-05T12:00:00Z'); // martes
    expect(humanDate(ts, 'es', TZ, now)).toMatch(/martes/i);
  });

  it('respects tz boundary — 23:30 UTC reads as Today in WEST against next-day reference', () => {
    // 2026-05-01 23:30 UTC == 2026-05-02 00:30 WEST.
    // Reference at 2026-05-02 08:00 UTC == 09:00 WEST same day.
    const now = new Date('2026-05-02T08:00:00Z');
    const ts  = new Date('2026-05-01T23:30:00Z');
    expect(humanDate(ts, 'en', TZ, now)).toBe('Today');
  });

  it('returns localised "Vandaag" / "Hoy" for Today', () => {
    const now = new Date('2026-05-01T12:00:00Z');
    const ts  = new Date('2026-05-01T08:00:00Z');
    expect(humanDate(ts, 'nl', TZ, now)).toBe('Vandaag');
    expect(humanDate(ts, 'es', TZ, now)).toBe('Hoy');
  });
});
