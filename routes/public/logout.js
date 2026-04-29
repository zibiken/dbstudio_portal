import { sql } from 'kysely';
import { readSession, clearSessionCookie } from '../../lib/auth/middleware.js';
import { writeAudit } from '../../lib/audit.js';

export function registerLogoutRoutes(app) {
  app.get('/logout', async (req, reply) => {
    const session = await readSession(app, req);
    if (session) {
      await sql`UPDATE sessions SET revoked_at = now() WHERE id = ${session.id}`.execute(app.db);
      await writeAudit(app.db, {
        actorType: session.user_type,
        actorId: session.user_id,
        action: 'session.revoked',
        metadata: { reason: 'user_logout' },
        ip: req.ip ?? null,
      });
    }
    clearSessionCookie(reply, app.env);
    reply.redirect('/login', 302);
  });
}
