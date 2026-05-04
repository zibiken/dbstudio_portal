import { describe, it, expect } from 'vitest';
import { euroToCents, centsToEuroString } from '../../lib/money.js';

describe('euroToCents', () => {
  it('parses whole euros', () => {
    expect(euroToCents('12')).toBe(1200);
    expect(euroToCents('0')).toBe(0);
    expect(euroToCents('999999')).toBe(99999900);
  });

  it('parses one and two decimal places', () => {
    expect(euroToCents('12.5')).toBe(1250);
    expect(euroToCents('12.50')).toBe(1250);
    expect(euroToCents('12.05')).toBe(1205);
    expect(euroToCents('0.01')).toBe(1);
    expect(euroToCents('0.10')).toBe(10);
  });

  it('accepts the European comma decimal', () => {
    expect(euroToCents('12,50')).toBe(1250);
    expect(euroToCents('12,5')).toBe(1250);
    expect(euroToCents('0,01')).toBe(1);
  });

  it('trims whitespace', () => {
    expect(euroToCents('  12.50  ')).toBe(1250);
  });

  it('rejects empty / null / undefined', () => {
    expect(() => euroToCents('')).toThrow(/required/);
    expect(() => euroToCents('   ')).toThrow(/required/);
    expect(() => euroToCents(null)).toThrow(/required/);
    expect(() => euroToCents(undefined)).toThrow(/required/);
  });

  it('rejects non-numeric input', () => {
    expect(() => euroToCents('abc')).toThrow(/invalid format/);
    expect(() => euroToCents('12.5e3')).toThrow(/invalid format/);
    expect(() => euroToCents('--12')).toThrow(/invalid format/);
  });

  it('rejects negative amounts', () => {
    expect(() => euroToCents('-1')).toThrow(/invalid format/);
    expect(() => euroToCents('-1.50')).toThrow(/invalid format/);
  });

  it('rejects sub-cent precision', () => {
    expect(() => euroToCents('12.345')).toThrow(/invalid format/);
    expect(() => euroToCents('12.001')).toThrow(/invalid format/);
  });

  it('rejects scientific notation', () => {
    expect(() => euroToCents('1e3')).toThrow(/invalid format/);
  });
});

describe('centsToEuroString', () => {
  it('formats with 2 decimal places', () => {
    expect(centsToEuroString(0)).toBe('0.00');
    expect(centsToEuroString(1)).toBe('0.01');
    expect(centsToEuroString(10)).toBe('0.10');
    expect(centsToEuroString(1200)).toBe('12.00');
    expect(centsToEuroString(1250)).toBe('12.50');
    expect(centsToEuroString(99999900)).toBe('999999.00');
  });

  it('rejects non-integer / negative', () => {
    expect(() => centsToEuroString(-1)).toThrow();
    expect(() => centsToEuroString(1.5)).toThrow();
    expect(() => centsToEuroString('100')).toThrow();
  });

  it('round-trips with euroToCents', () => {
    for (const cents of [0, 1, 99, 100, 12345, 99999900]) {
      const str = centsToEuroString(cents);
      expect(euroToCents(str)).toBe(cents);
    }
  });
});
