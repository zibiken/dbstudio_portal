// Unit tests for lib/auth/email-cluster.js. Only `withinOneEdit` is
// covered here (pure function); `clusterKeyForResetEmail` hits the DB
// and is exercised in the integration test for /reset.

import { describe, it, expect } from 'vitest';
import { withinOneEdit } from '../../../lib/auth/email-cluster.js';

describe('withinOneEdit', () => {
  it('treats identical strings as within 1', () => {
    expect(withinOneEdit('a@b.com', 'a@b.com')).toBe(true);
    expect(withinOneEdit('', '')).toBe(true);
  });

  it('case-insensitive', () => {
    expect(withinOneEdit('Info@Brainzr.eu', 'info@brainzr.eu')).toBe(true);
  });

  it('detects single-char substitution', () => {
    expect(withinOneEdit('info@brainzr.eu', 'info@brainzr.iu')).toBe(true);
    expect(withinOneEdit('abcde', 'abXde')).toBe(true);
  });

  it('rejects two-char substitution', () => {
    expect(withinOneEdit('abcde', 'abXYe')).toBe(false);
    expect(withinOneEdit('info@brainzr.eu', 'info@brainzr.io')).toBe(false);
  });

  it('detects single-char insertion', () => {
    expect(withinOneEdit('info@brainzr.eu', 'info@brainzrx.eu')).toBe(true);
    expect(withinOneEdit('abcd', 'abcdX')).toBe(true);
    expect(withinOneEdit('abcd', 'Xabcd')).toBe(true);
    expect(withinOneEdit('abcd', 'abXcd')).toBe(true);
  });

  it('detects single-char deletion (mirror of insertion)', () => {
    expect(withinOneEdit('info@brainzrx.eu', 'info@brainzr.eu')).toBe(true);
    expect(withinOneEdit('abcdX', 'abcd')).toBe(true);
  });

  it('rejects two-char insertion / deletion', () => {
    expect(withinOneEdit('abcd', 'abcdXY')).toBe(false);
    expect(withinOneEdit('abcdef', 'abcd')).toBe(false);
  });

  it('rejects unrelated strings of close length', () => {
    expect(withinOneEdit('hello@example.com', 'world@example.com')).toBe(false);
    expect(withinOneEdit('admin', 'guest')).toBe(false);
  });

  it('handles tld typos that motivated this work', () => {
    // The 2026-05-01 incident: .com vs .eu. Not Levenshtein-1 (2 edits)
    // — those hit the IP bucket today and the cluster bucket only catches
    // tighter typos.
    expect(withinOneEdit('info@brainzr.com', 'info@brainzr.eu')).toBe(false);
    // But .com vs .co IS within one edit (deletion).
    expect(withinOneEdit('info@brainzr.com', 'info@brainzr.co')).toBe(true);
    // And .eu vs .iu (transposition is 2 edits actually; substitution = 1).
    expect(withinOneEdit('info@brainzr.eu', 'info@brainzr.iu')).toBe(true);
  });

  it('handles edge cases', () => {
    expect(withinOneEdit('', 'a')).toBe(true);
    expect(withinOneEdit('a', '')).toBe(true);
    expect(withinOneEdit('', 'ab')).toBe(false);
    expect(withinOneEdit('a', 'b')).toBe(true);
  });
});
