const MAILERSEND_ENDPOINT = 'https://api.mailersend.com/v1/email';
const DEFAULT_TIMEOUT_MS = 20_000;

export function makeMailer({
  apiKey,
  fromEmail,
  fromName,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  devHold = false,
  log = null,
}) {
  return {
    async send({ to, subject, html, text, idempotencyKey }) {
      if (devHold) {
        log?.info?.({ to, subject, idempotencyKey }, 'mailer.dev_hold');
        return { ok: true, held: true, providerId: null };
      }
      let r;
      try {
        r = await fetch(MAILERSEND_ENDPOINT, {
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
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        // Anything thrown by fetch itself is a transport-layer failure
        // (DNS / TCP / TLS / abort-due-to-timeout). Not the same shape as
        // a MailerSend HTTP error — but always retryable from our POV.
        throw Object.assign(new Error(`mailersend transport: ${cause?.message ?? 'unknown'}`), {
          retryable: true,
          cause,
        });
      }

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
