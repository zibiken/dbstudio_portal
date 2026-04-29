import { describe, it, expect } from 'vitest';
import { generateNonce, buildCspHeader } from '../../lib/csp.js';

describe('csp', () => {
  it('nonce is base64-encoded 16 bytes (~22-24 chars)', () => {
    const n = generateNonce();
    expect(n).toMatch(/^[A-Za-z0-9+/]{20,24}={0,2}$/);
  });

  it('two nonces are not equal', () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });

  it('header embeds the nonce in script-src and style-src exactly once each', () => {
    const h = buildCspHeader('abc123');
    expect(h).toContain("script-src 'self' 'nonce-abc123'");
    expect(h).toContain("style-src 'self' 'nonce-abc123'");
    expect(h.match(/'nonce-abc123'/g)).toHaveLength(2);
  });

  it('header pins frame-ancestors to none', () => {
    expect(buildCspHeader('x')).toContain("frame-ancestors 'none'");
  });

  it('header allows data: in img-src, nothing else', () => {
    const h = buildCspHeader('x');
    expect(h).toContain("img-src 'self' data:");
    expect(h).not.toContain('blob:');
  });
});
