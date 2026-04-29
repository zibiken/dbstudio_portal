const MAILERSEND_ENDPOINT = 'https://api.mailersend.com/v1/email';

export function makeMailer({ apiKey, fromEmail, fromName, fetch = globalThis.fetch }) {
  return {
    async send({ to, subject, html, text, idempotencyKey }) {
      const r = await fetch(MAILERSEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey ?? '',
        },
        body: JSON.stringify({
          from: { email: fromEmail, name: fromName },
          to: [{ email: to }],
          subject,
          html,
          text,
        }),
      });

      if (r.status === 202) {
        return { ok: true, providerId: r.headers.get('x-message-id') };
      }
      if (r.status === 429 || r.status >= 500) {
        throw Object.assign(new Error('mailersend retryable'), { retryable: true, status: r.status });
      }
      throw Object.assign(new Error(`mailersend ${r.status}`), { retryable: false, status: r.status });
    },
  };
}
