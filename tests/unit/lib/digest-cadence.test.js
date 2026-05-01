import { describe, it, expect } from 'vitest';
import { nextDigestFire, DIGEST_FIRE_HOURS_LOCAL, DIGEST_FIRE_TZ } from '../../../lib/digest-cadence.js';

// Atlantic/Canary is WET (UTC+0) in winter, WEST (UTC+1) in summer.
// 2026-01-15 is in WET. 2026-05-01 is in WEST.

describe('nextDigestFire', () => {
  it('exposes the configured fire hours and timezone', () => {
    expect(DIGEST_FIRE_HOURS_LOCAL).toEqual([8, 17]);
    expect(DIGEST_FIRE_TZ).toBe('Atlantic/Canary');
  });

  it('07:59 Canary (winter) -> next is 08:00 today', () => {
    const now = new Date('2026-01-15T07:59:00Z'); // 07:59 WET
    const due = nextDigestFire(now);
    expect(due.toISOString()).toBe('2026-01-15T08:00:00.000Z');
  });

  it('08:00 Canary (winter) boundary -> next is 17:00 today (strict greater)', () => {
    const now = new Date('2026-01-15T08:00:00Z');
    const due = nextDigestFire(now);
    expect(due.toISOString()).toBe('2026-01-15T17:00:00.000Z');
  });

  it('08:01 Canary (winter) -> next is 17:00 today', () => {
    const now = new Date('2026-01-15T08:01:00Z');
    const due = nextDigestFire(now);
    expect(due.toISOString()).toBe('2026-01-15T17:00:00.000Z');
  });

  it('17:01 Canary (winter) -> next is 08:00 tomorrow', () => {
    const now = new Date('2026-01-15T17:01:00Z');
    const due = nextDigestFire(now);
    expect(due.toISOString()).toBe('2026-01-16T08:00:00.000Z');
  });

  it('07:59 Canary (summer WEST UTC+1) -> next is 08:00 today (07:00 UTC)', () => {
    // 06:59 UTC == 07:59 WEST
    const now = new Date('2026-05-01T06:59:00Z');
    const due = nextDigestFire(now);
    expect(due.toISOString()).toBe('2026-05-01T07:00:00.000Z');
  });

  it('17:01 Canary (summer WEST) -> next is 08:00 tomorrow (07:00 UTC)', () => {
    // 16:01 UTC == 17:01 WEST
    const now = new Date('2026-05-01T16:01:00Z');
    const due = nextDigestFire(now);
    expect(due.toISOString()).toBe('2026-05-02T07:00:00.000Z');
  });

  it('crosses month boundary correctly', () => {
    const now = new Date('2026-01-31T17:01:00Z');
    const due = nextDigestFire(now);
    expect(due.toISOString()).toBe('2026-02-01T08:00:00.000Z');
  });

  it('crosses year boundary correctly', () => {
    const now = new Date('2026-12-31T17:01:00Z');
    const due = nextDigestFire(now);
    expect(due.toISOString()).toBe('2027-01-01T08:00:00.000Z');
  });

  it('DST spring-forward boundary (UTC offset shifts mid-day) handled', () => {
    // 2026-03-29 06:59 UTC: by this time on this day, Canary has shifted
    // to WEST (UTC+1). 06:59 UTC == 07:59 WEST -> next fire is 08:00 WEST = 07:00 UTC.
    const now = new Date('2026-03-29T06:59:00Z');
    const due = nextDigestFire(now);
    expect(due.toISOString()).toBe('2026-03-29T07:00:00.000Z');
  });

  it('returns a Date instance (not a string)', () => {
    const due = nextDigestFire(new Date('2026-05-01T10:00:00Z'));
    expect(due).toBeInstanceOf(Date);
  });
});
