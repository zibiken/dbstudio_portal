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
  'dek_ciphertext', 'dek_iv', 'dek_tag', 'dek',
  'totp_secret', 'totp_secret_enc',
  'backup_codes',
  'invite_token_hash',
  'webauthn_creds'
];

export function createLogger({ level = 'info', destination } = {}) {
  return pino(
    { level, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
    destination
  );
}
