import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function runHook(stagedContents) {
  const dir = mkdtempSync(join(tmpdir(), 'pchook-'));
  const file = join(dir, 'staged.txt');
  writeFileSync(file, stagedContents);
  const r = spawnSync('bash', ['scripts/precommit-secrets-check.sh', file], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return r;
}

describe('precommit-secrets-check.sh — rejects', () => {
  const positives = [
    ['MAILERSEND env literal',          'MAILERSEND_API_KEY=mlsn.abc123def456ghijkl0123'],
    ['mailersend prefix anywhere',      'const k = "mlsn.abc123def456ghijkl0123";'],
    ['password double-quote literal',   'password="hunter2real"'],
    ['password single-quote literal',   "password='hunter2real'"],
    ['begin private key',               '-----BEGIN PRIVATE KEY-----'],
    ['begin openssh key',               '-----BEGIN OPENSSH PRIVATE KEY-----'],
    ['secret base64 40+',               'secret_token=' + 'A'.repeat(48)],
    ['session secret hex 40+',          'session_secret=' + '1'.repeat(64)],
    ['arbitrary api key env',           'STRIPE_API_KEY=sk_live_abcdef0123456789'],
  ];
  for (const [name, sample] of positives) {
    it(`rejects: ${name}`, () => {
      const r = runHook(sample + '\n');
      expect(r.status, r.stderr + r.stdout).not.toBe(0);
    });
  }
});

describe('precommit-secrets-check.sh — accepts', () => {
  const negatives = [
    ['CHANGEME placeholder',             'MAILERSEND_API_KEY=CHANGEME'],
    ['fake-marked',                      'MAILERSEND_API_KEY=mlsn.fakekey0000'],
    ['identifier reference no literal',  'const password = config.password;'],
    ['unrelated string',                 'const x = "hunter2real";'],
    ['code reading process.env',         'const secret = process.env.SESSION_SIGNING_SECRET;'],
    ['plain markdown',                   'this is just regular markdown'],
  ];
  for (const [name, sample] of negatives) {
    it(`accepts: ${name}`, () => {
      const r = runHook(sample + '\n');
      expect(r.status, r.stderr + r.stdout).toBe(0);
    });
  }
});
