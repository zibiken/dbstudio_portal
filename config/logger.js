import pino from 'pino';

const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'master_key', 'master_key_path',
  'session_signing_secret',
  'file_url_signing_secret',
  'mailersend_api_key',
  'password', '*.password',
  'payload_ciphertext', 'payload_iv', 'payload_tag',
  // Envelope keys: KEK is the master, DEK is per-customer. Both must
  // never appear in object-form log lines. Path-based redact can't
  // strip them from URL strings — that's enforced separately by the
  // req serializer in lib/secure-headers.js (URLs containing tokens
  // never become object-keyed fields here).
  'kek',
  'dek_ciphertext', 'dek_iv', 'dek_tag', 'dek',
  'totp_secret', 'totp_secret_enc',
  'backup_codes',
  // Bearer tokens: the plaintext invite token is a credential equivalent
  // (whoever holds it can claim the account). Hashed forms are fine to
  // log — they're not credentials — so invite_token_hash stays as is.
  'invite_token', 'inviteToken',
  'invite_url', 'inviteUrl',
  'welcome_url', 'welcomeUrl',
  'reset_url', 'resetUrl',
  'verify_url', 'verifyUrl',
  'revert_url', 'revertUrl',
  'invite_token_hash',
  'webauthn_creds'
];

export function createLogger({ level = 'info', destination } = {}) {
  return pino(
    { level, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
    destination
  );
}
