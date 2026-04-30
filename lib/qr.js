// Server-side SVG QR rendering for TOTP enrolment surfaces.
//
// Single export. Returns a Promise<string> of SVG markup with role="img"
// + aria-label injected and any inline <style> stripped (CSP cleanliness).
// The function never logs or echoes the otpauth URI.
//
// Used by views/components/_qr.ejs from:
//   GET /welcome/:token            (admin invite consume)
//   GET /customer/welcome/:token
//   GET /admin/profile/2fa/regen
//   GET /customer/profile/2fa/regen

import qrcode from 'qrcode';

const PALETTE = {
  // Obsidian on ivory: matches portal --c-obsidian / --c-ivory tokens.
  // Slightly off-pure so the QR sits inside an ivory card without a
  // contrast break, while still scanning reliably (~17:1 luminance).
  dark:  '#0F0F0E',
  light: '#F6F3EE'
};

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * @param {string} otpauthUri  The otpauth:// URI to encode. Never logged.
 * @param {{ label: string }} opts
 * @returns {Promise<string>} SVG markup ready to inline.
 */
export async function renderTotpQrSvg(otpauthUri, opts) {
  if (!otpauthUri || typeof otpauthUri !== 'string') {
    throw new Error('renderTotpQrSvg: otpauthUri is required and must be a non-empty string');
  }
  const label = opts && typeof opts.label === 'string' ? opts.label : '';
  if (!label) {
    throw new Error('renderTotpQrSvg: opts.label is required');
  }
  if (label.includes('otpauth://')) {
    // Defensive: callers must not pass the URI itself as the label.
    throw new Error('renderTotpQrSvg: aria-label must not contain the otpauth URI');
  }

  // qrcode.toString returns a deterministic SVG given fixed mask + EC.
  // errorCorrectionLevel 'M' is the standard for TOTP enrolment (~15%
  // damage tolerance). margin 1 keeps the QR tight inside the ivory card.
  const raw = await qrcode.toString(otpauthUri, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    color: { dark: PALETTE.dark, light: PALETTE.light }
  });

  // Strip any inline <style> the library might emit (CSP cleanliness:
  // portal does not allow style-src 'unsafe-inline').
  let svg = raw.replace(/<style[\s\S]*?<\/style>/gi, '');

  // Inject role="img", aria-label, focusable="false". Ensure viewBox is
  // present (qrcode emits it, but be defensive).
  svg = svg.replace(/<svg([^>]*)>/i, (_, attrs) => {
    let a = attrs;
    if (!/viewBox=/.test(a))   a += ' viewBox="0 0 100 100"';
    if (!/role=/.test(a))      a += ' role="img"';
    if (!/focusable=/.test(a)) a += ' focusable="false"';
    a += ` aria-label="${escapeAttr(label)}"`;
    return `<svg${a}>`;
  });

  return svg;
}
