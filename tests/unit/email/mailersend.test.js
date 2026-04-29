import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeMailer } from '../../../lib/email.js';

const params = {
  apiKey: 'mlsn.test-key',
  fromEmail: 'portal@dbstudio.one',
  fromName: 'DB Studio Portal',
};

function fakeResponse(status, headers = {}, body = '') {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    status,
    headers: { get: (k) => lower[String(k).toLowerCase()] ?? null },
    text: async () => body,
    json: async () => (body ? JSON.parse(body) : null),
  };
}

describe('makeMailer / send', () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('on 202 returns { ok: true, providerId } from x-message-id header', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(202, { 'x-message-id': '69f237c1240785931dfc7c72' }),
    );
    const mailer = makeMailer({ ...params, fetch: fetchMock });
    const r = await mailer.send({
      to: 'bram@roxiplus.es',
      subject: 'subj',
      html: '<p>hi</p>',
      text: 'hi',
      idempotencyKey: 'idem-1',
    });
    expect(r).toEqual({ ok: true, providerId: '69f237c1240785931dfc7c72' });
  });

  it('returns providerId=null when MailerSend omits x-message-id', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(202, {}));
    const mailer = makeMailer({ ...params, fetch: fetchMock });
    const r = await mailer.send({ to: 'a@b.c', subject: 's', html: 'h', text: 't' });
    expect(r).toEqual({ ok: true, providerId: null });
  });

  it('issues POST to MailerSend v1/email with correct headers and JSON body', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(202, { 'x-message-id': 'm1' }));
    const mailer = makeMailer({ ...params, fetch: fetchMock });
    await mailer.send({
      to: 'recipient@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
      idempotencyKey: 'idem-abc',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.mailersend.com/v1/email');
    expect(opts.method).toBe('POST');
    expect(opts.headers).toMatchObject({
      Authorization: 'Bearer mlsn.test-key',
      'Content-Type': 'application/json',
      'X-Idempotency-Key': 'idem-abc',
    });
    expect(JSON.parse(opts.body)).toEqual({
      from: { email: 'portal@dbstudio.one', name: 'DB Studio Portal' },
      to: [{ email: 'recipient@example.com' }],
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
    });
  });

  it('omitting idempotencyKey sends the header with an empty string value', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(202, { 'x-message-id': 'm1' }));
    const mailer = makeMailer({ ...params, fetch: fetchMock });
    await mailer.send({ to: 'a@b.c', subject: 's', html: 'h', text: 't' });
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['X-Idempotency-Key']).toBe('');
  });

  it('throws retryable=true on 429', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(429));
    const mailer = makeMailer({ ...params, fetch: fetchMock });
    await expect(
      mailer.send({ to: 'a@b.c', subject: 's', html: 'h', text: 't' }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it.each([500, 502, 503, 504])('throws retryable=true on %i', async (status) => {
    fetchMock.mockResolvedValueOnce(fakeResponse(status));
    const mailer = makeMailer({ ...params, fetch: fetchMock });
    await expect(
      mailer.send({ to: 'a@b.c', subject: 's', html: 'h', text: 't' }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it.each([400, 401, 403, 404, 422])(
    'throws retryable=false with status on %i',
    async (status) => {
      fetchMock.mockResolvedValueOnce(fakeResponse(status));
      const mailer = makeMailer({ ...params, fetch: fetchMock });
      await expect(
        mailer.send({ to: 'a@b.c', subject: 's', html: 'h', text: 't' }),
      ).rejects.toMatchObject({ retryable: false, status });
    },
  );

  it('does not retry inside send (single attempt per call)', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(503));
    const mailer = makeMailer({ ...params, fetch: fetchMock });
    await expect(
      mailer.send({ to: 'a@b.c', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies a fetch-layer throw (DNS/TCP/TLS error) as retryable', async () => {
    // undici raises `TypeError: fetch failed` with a `cause` for network
    // errors. Such a throw must reach the worker as { retryable: true } so
    // a transient network blip doesn't burn the row to status='failed' on
    // attempt 1.
    fetchMock.mockRejectedValueOnce(
      Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') }),
    );
    const mailer = makeMailer({ ...params, fetch: fetchMock });
    await expect(
      mailer.send({ to: 'a@b.c', subject: 's', html: 'h', text: 't' }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it('classifies an AbortError (request timeout) as retryable', async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    );
    const mailer = makeMailer({ ...params, fetch: fetchMock });
    await expect(
      mailer.send({ to: 'a@b.c', subject: 's', html: 'h', text: 't' }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it('passes an AbortSignal to fetch so a hung request cannot wedge the worker', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(202, { 'x-message-id': 'm1' }));
    const mailer = makeMailer({ ...params, fetch: fetchMock });
    await mailer.send({ to: 'a@b.c', subject: 's', html: 'h', text: 't' });
    const opts = fetchMock.mock.calls[0][1];
    expect(opts.signal).toBeDefined();
    // AbortSignal.timeout returns a real AbortSignal; it has an `aborted`
    // property and is an instance of AbortSignal.
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses globalThis.fetch when no fetch is injected', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      fakeResponse(202, { 'x-message-id': 'g1' }),
    );
    try {
      const mailer = makeMailer({ ...params });
      const r = await mailer.send({ to: 'a@b.c', subject: 's', html: 'h', text: 't' });
      expect(r).toEqual({ ok: true, providerId: 'g1' });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
