import {
  generateSecret as _generateSecret,
  generateSync,
  verifySync,
  generateURI,
} from 'otplib';

const TOLERANCE_SECONDS = 30;

export function generateSecret() {
  return _generateSecret();
}

export function generateToken(secret, { epoch } = {}) {
  return epoch === undefined
    ? generateSync({ secret })
    : generateSync({ secret, epoch });
}

export function verify(secret, token, { epoch } = {}) {
  try {
    const opts = { secret, token, epochTolerance: TOLERANCE_SECONDS };
    if (epoch !== undefined) opts.epoch = epoch;
    const r = verifySync(opts);
    return r.valid === true;
  } catch {
    return false;
  }
}

export function keyuri(label, issuer, secret) {
  return generateURI({ secret, label, issuer });
}
