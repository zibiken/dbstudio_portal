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

  it('redacts kek + bearer-token URL/string fields (defence in depth)', () => {
    // No path in the M5 code today logs these in object form, but a
    // future contributor catching `log.error({ ctx, err })` where ctx
    // happens to carry kek or inviteToken would leak. The redact list
    // covers both camel- and snake-case variants.
    const sentinel = '01234567abcdef';
    const out = captureLog((log) =>
      log.info({
        kek: 'KEK-bytes-' + sentinel,
        invite_token: 'invitetok-' + sentinel,
        inviteToken: 'invitetokC-' + sentinel,
        invite_url: 'https://portal.example/customer/welcome/' + sentinel,
        inviteUrl: 'https://portal.example/customer/welcome/CC' + sentinel,
        welcomeUrl: 'https://portal.example/welcome/' + sentinel,
        resetUrl: 'https://portal.example/reset/' + sentinel,
        verifyUrl: 'https://portal.example/email-change/verify/' + sentinel,
        revertUrl: 'https://portal.example/email-change/revert/' + sentinel,
      }, 'event')
    );
    const flat = JSON.stringify(out[0]);
    expect(flat).not.toContain(sentinel);
    expect(flat).toContain('[REDACTED]');
  });
});
