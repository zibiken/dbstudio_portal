import { describe, it, expect } from 'vitest';
import { euDate, euDateTime, toDate } from '../../lib/dates.js';

describe('lib/dates', () => {
  describe('euDate', () => {
    it('formats an ISO date as DD/MM/YYYY', () => {
      expect(euDate('2026-05-06')).toBe('06/05/2026');
    });

    it('formats a Date instance as DD/MM/YYYY', () => {
      expect(euDate(new Date(Date.UTC(2026, 4, 6, 12, 0, 0)))).toBe('06/05/2026');
    });

    it('rolls over the day at the Canary TZ boundary', () => {
      // Summer (WEST = UTC+1): 23:00 UTC on 6 May is 00:00 7 May Canary time.
      expect(euDate('2026-05-06T23:00:00Z')).toBe('07/05/2026');
    });

    it('returns the input as-is for non-parseable strings', () => {
      expect(euDate('not a date')).toBe('not a date');
    });

    it('returns empty string for null / undefined / ""', () => {
      expect(euDate(null)).toBe('');
      expect(euDate(undefined)).toBe('');
      expect(euDate('')).toBe('');
    });

    it('does not throw on malformed Date instances', () => {
      const bad = new Date('garbage');
      expect(euDate(bad)).toBe(String(bad));
    });
  });

  describe('euDateTime', () => {
    it('formats datetimes in DD/MM/YYYY HH:mm 24h, no comma', () => {
      // WEST (UTC+1) in late April 2026: 12:32 UTC → 13:32 Canary.
      expect(euDateTime('2026-04-29T12:32:00Z')).toBe('29/04/2026 13:32');
    });

    it('uses 24-hour clock (not AM/PM)', () => {
      // 22:00 UTC = 23:00 Canary in summer (WEST = UTC+1)
      expect(euDateTime('2026-04-29T22:00:00Z')).toBe('29/04/2026 23:00');
      expect(euDateTime('2026-04-29T23:30:00Z')).toBe('30/04/2026 00:30');
    });

    it('respects Canary winter TZ (WET = UTC+0)', () => {
      // 23:30 UTC on 15 December → 23:30 same day Canary time (UTC offset 0)
      expect(euDateTime('2026-12-15T23:30:00Z')).toBe('15/12/2026 23:30');
      // And the rollover sits at 00:00 UTC
      expect(euDateTime('2026-12-16T00:00:00Z')).toBe('16/12/2026 00:00');
    });

    it('returns the input as-is for non-parseable strings', () => {
      expect(euDateTime('still not a date')).toBe('still not a date');
    });

    it('returns empty string for null / undefined / ""', () => {
      expect(euDateTime(null)).toBe('');
      expect(euDateTime(undefined)).toBe('');
      expect(euDateTime('')).toBe('');
    });
  });

  describe('toDate', () => {
    it('parses ISO strings', () => {
      expect(toDate('2026-05-06')).toBeInstanceOf(Date);
    });

    it('passes Date instances through', () => {
      const d = new Date('2026-05-06');
      expect(toDate(d)).toBe(d);
    });

    it('returns null for empty / null / invalid', () => {
      expect(toDate(null)).toBeNull();
      expect(toDate(undefined)).toBeNull();
      expect(toDate('')).toBeNull();
      expect(toDate('garbage')).toBeNull();
      expect(toDate(new Date('garbage'))).toBeNull();
    });
  });
});
