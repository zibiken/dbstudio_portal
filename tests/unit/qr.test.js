import { describe, it, expect } from 'vitest';
import { renderTotpQrSvg } from '../../lib/qr.js';

const SAMPLE_URI = 'otpauth://totp/DB%20Studio:bram@roxiplus.es?secret=JBSWY3DPEHPK3PXP&issuer=DB%20Studio&algorithm=SHA1&digits=6&period=30';

describe('renderTotpQrSvg', () => {
  it('returns an SVG string with role="img" and the provided aria-label', async () => {
    const svg = await renderTotpQrSvg(SAMPLE_URI, { label: 'TOTP enrolment for bram@roxiplus.es' });
    expect(svg).toMatch(/^<svg[\s>]/);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="TOTP enrolment for bram@roxiplus.es"');
    expect(svg).toContain('focusable="false"');
    expect(svg).toContain('viewBox');
  });

  it('is deterministic — same URI produces identical bytes', async () => {
    const a = await renderTotpQrSvg(SAMPLE_URI, { label: 'a' });
    const b = await renderTotpQrSvg(SAMPLE_URI, { label: 'a' });
    expect(a).toEqual(b);
  });

  it('throws on empty URI', async () => {
    await expect(renderTotpQrSvg('', { label: 'x' })).rejects.toThrow(/required|empty/i);
    await expect(renderTotpQrSvg(null, { label: 'x' })).rejects.toThrow();
    await expect(renderTotpQrSvg(undefined, { label: 'x' })).rejects.toThrow();
  });

  it('HTML-escapes the label so attribute injection is impossible', async () => {
    const svg = await renderTotpQrSvg(SAMPLE_URI, { label: 'evil" onload="x' });
    expect(svg).not.toContain('onload="x"');
    expect(svg).toContain('aria-label="evil&quot; onload=&quot;x"');
  });

  it('refuses to use the otpauth URI as a label (defensive)', async () => {
    await expect(renderTotpQrSvg(SAMPLE_URI, { label: SAMPLE_URI })).rejects.toThrow(/otpauth/i);
  });

  it('does not include any inline <style>', async () => {
    const svg = await renderTotpQrSvg(SAMPLE_URI, { label: 'x' });
    expect(svg).not.toMatch(/<style/i);
  });

  it('uses obsidian #0F0F0E on ivory #F6F3EE (matches portal palette)', async () => {
    const svg = await renderTotpQrSvg(SAMPLE_URI, { label: 'x' });
    expect(svg.toLowerCase()).toContain('#0f0f0e');
    expect(svg.toLowerCase()).toContain('#f6f3ee');
  });
});
