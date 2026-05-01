import { sql } from 'kysely';
import { renderCustomer } from '../../lib/render.js';
import { requireCustomerSession, requireNdaSigned } from '../../lib/auth/middleware.js';
import * as repo from '../../domain/customer-questions/repo.js';
import * as svc from '../../domain/customer-questions/service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ANSWER_LEN = 8000;

async function loadOwnedQuestion(app, req, reply, session) {
  const id = req.params?.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    reply.code(404).send();
    return null;
  }
  const userR = await sql`
    SELECT customer_id FROM customer_users WHERE id = ${session.user_id}::uuid
  `.execute(app.db);
  const customerId = userR.rows[0]?.customer_id;
  if (!customerId) {
    reply.redirect('/', 302);
    return null;
  }
  const q = await repo.findById(app.db, id);
  if (!q || q.customer_id !== customerId) {
    reply.code(404).send();
    return null;
  }
  return q;
}

export function registerCustomerQuestionsRoutes(app) {
  app.get('/customer/questions', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;

    const userR = await sql`
      SELECT customer_id FROM customer_users WHERE id = ${session.user_id}::uuid
    `.execute(app.db);
    const customerId = userR.rows[0]?.customer_id;
    if (!customerId) {
      reply.redirect('/', 302);
      return;
    }
    const rows = await repo.listAllForCustomer(app.db, customerId, { limit: 200 });

    return renderCustomer(req, reply, 'customer/questions/list', {
      title: 'Questions',
      rows,
      activeNav: 'questions',
      mainWidth: 'wide',
    });
  });

  app.get('/customer/questions/:id', async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;

    const q = await loadOwnedQuestion(app, req, reply, session);
    if (!q) return;

    return renderCustomer(req, reply, 'customer/questions/show', {
      title: 'A question for you',
      question: q,
      csrfToken: await reply.generateCsrf(),
      activeNav: 'dashboard',
      mainWidth: 'wide',
    });
  });

  app.post('/customer/questions/:id/answer', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;

    const q = await loadOwnedQuestion(app, req, reply, session);
    if (!q) return;

    const answerText = String(req.body?.answer ?? '').trim();
    if (!answerText || answerText.length > MAX_ANSWER_LEN) {
      reply.code(422);
      return renderCustomer(req, reply, 'customer/questions/show', {
        title: 'A question for you',
        question: q,
        csrfToken: await reply.generateCsrf(),
        error: !answerText
          ? 'An answer is required (or click Skip if you don\'t know).'
          : `Answer is too long (max ${MAX_ANSWER_LEN} characters).`,
        prefill: answerText,
        activeNav: 'dashboard',
        mainWidth: 'wide',
      });
    }

    const result = await svc.answerQuestion(app.db, {
      id: q.id,
      answeredByCustomerUserId: session.user_id,
      answerText,
    }, { ip: req.ip, userAgentHash: null });

    if (!result) {
      const fresh = await repo.findById(app.db, q.id);
      return renderCustomer(req, reply, 'customer/questions/show', {
        title: 'A question for you',
        question: fresh,
        csrfToken: await reply.generateCsrf(),
        noLongerOpen: true,
        activeNav: 'dashboard',
        mainWidth: 'wide',
      });
    }
    return reply.redirect('/customer/dashboard', 302);
  });

  app.post('/customer/questions/:id/skip', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireCustomerSession(app, req, reply);
    if (!session) return;
    if (!requireNdaSigned(req, reply, session)) return;

    const q = await loadOwnedQuestion(app, req, reply, session);
    if (!q) return;

    const result = await svc.skipQuestion(app.db, {
      id: q.id,
      answeredByCustomerUserId: session.user_id,
    }, { ip: req.ip, userAgentHash: null });

    if (!result) {
      const fresh = await repo.findById(app.db, q.id);
      return renderCustomer(req, reply, 'customer/questions/show', {
        title: 'A question for you',
        question: fresh,
        csrfToken: await reply.generateCsrf(),
        noLongerOpen: true,
        activeNav: 'dashboard',
        mainWidth: 'wide',
      });
    }
    return reply.redirect('/customer/dashboard', 302);
  });
}
