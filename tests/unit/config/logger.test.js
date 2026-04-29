import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger } from '../../../config/logger.js';

function captureLog(fn) {
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) { lines.push(chunk.toString()); cb(); }
  });
  const log = createLogger({ level: 'info', destination: stream });
  fn(log);
  return lines.map((l) => JSON.parse(l));
}

describe('logger redaction', () => {
  it('redacts request cookie + authorization headers', () => {
    const out = captureLog((log) =>
      log.info({ req: { headers: { cookie: 'sid=abc', authorization: 'Bearer x' } } }, 'event')
    );
    const flat = JSON.stringify(out[0]);
    expect(flat).not.toContain('sid=abc');
    expect(flat).not.toContain('Bearer x');
    expect(flat).toContain('[REDACTED]');
  });

  it('redacts master key + signing secret + mailersend api key fields', () => {
    const out = captureLog((log) =>
      log.info({
        master_key: 'plaintext-kek',
        session_signing_secret: 'shhh',
        file_url_signing_secret: 'also-shhh',
        mailersend_api_key: 'mlsn.real',
        payload: 'public'
      }, 'event')
    );
    const flat = JSON.stringify(out[0]);
    expect(flat).not.toContain('plaintext-kek');
    expect(flat).not.toContain('shhh');
    expect(flat).not.toContain('mlsn.real');
    expect(flat).toContain('public');
  });

  it('redacts password + totp_secret + dek', () => {
    const out = captureLog((log) =>
      log.info({ password: 'hunter2real', totp_secret: 'JBSWY3DPEHPK3PXP', dek_ciphertext: 'aaaa' }, 'event')
    );
    const flat = JSON.stringify(out[0]);
    expect(flat).not.toContain('hunter2real');
    expect(flat).not.toContain('JBSWY3DPEHPK3PXP');
    expect(flat).not.toContain('aaaa');
  });
});
