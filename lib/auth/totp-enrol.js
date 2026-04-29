import { createHmac } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SECRET_BYTES = 20;

function bufferToBase32(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

export function deriveEnrolSecret(inviteToken, signingSecret) {
  const mac = createHmac('sha256', signingSecret)
    .update('totp-enrol:')
    .update(inviteToken)
    .digest();
  return bufferToBase32(mac.subarray(0, SECRET_BYTES));
}

export function otpauthUri(label, issuer, secret) {
  const enc = encodeURIComponent;
  return `otpauth://totp/${enc(issuer)}:${enc(label)}?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
