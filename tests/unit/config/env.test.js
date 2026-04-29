import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../../config/env.js';

const baseValid = {
  NODE_ENV: 'production',
  PORT: '3400',
  HOST: '127.0.0.1',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d',
  MASTER_KEY_PATH: '/var/lib/portal/master.key',
  SESSION_SIGNING_SECRET: 'a'.repeat(64),
  FILE_URL_SIGNING_SECRET: 'b'.repeat(64),
  MAILERSEND_API_KEY: 'mlsn.placeholder',
  MAILERSEND_FROM_EMAIL: 'portal@mail.portal.dbstudio.one',
  ADMIN_NOTIFICATION_EMAIL: 'ops@dbstudio.one',
  PORTAL_BASE_URL: 'https://portal.dbstudio.one',
  NDA_TEMPLATE_PATH: '/var/lib/portal/templates/nda.html',
  PDF_SERVICE_SOCKET: '/run/portal-pdf.sock'
};

describe('loadEnv', () => {
  it('parses valid env into typed object', () => {
    const env = loadEnv(baseValid);
    expect(env.PORT).toBe(3400);
    expect(env.PORTAL_BASE_URL).toBe('https://portal.dbstudio.one');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('rejects SESSION_SIGNING_SECRET shorter than 32 bytes', () => {
    expect(() => loadEnv({ ...baseValid, SESSION_SIGNING_SECRET: 'short' })).toThrow();
  });

  it('rejects FILE_URL_SIGNING_SECRET shorter than 32 bytes', () => {
    expect(() => loadEnv({ ...baseValid, FILE_URL_SIGNING_SECRET: 'short' })).toThrow();
  });

  it('rejects PORTAL_BASE_URL that is not https', () => {
    expect(() => loadEnv({ ...baseValid, PORTAL_BASE_URL: 'http://portal.dbstudio.one' })).toThrow();
  });

  it('rejects DATABASE_URL that is not postgres://', () => {
    expect(() => loadEnv({ ...baseValid, DATABASE_URL: 'mysql://u:p@127.0.0.1/d' })).toThrow();
  });

  it('rejects PORT outside 1024-65535', () => {
    expect(() => loadEnv({ ...baseValid, PORT: '80' })).toThrow();
    expect(() => loadEnv({ ...baseValid, PORT: '99999' })).toThrow();
  });

  it('defaults LOG_LEVEL to info if absent', () => {
    const { LOG_LEVEL, ...rest } = baseValid;
    const env = loadEnv(rest);
    expect(env.LOG_LEVEL).toBe('info');
  });
});
