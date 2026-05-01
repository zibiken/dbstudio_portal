import { renderAdmin } from '../../lib/render.js';
import { requireAdminSession } from '../../lib/auth/middleware.js';
import { findCustomerById } from '../../domain/customers/repo.js';
import * as svc from '../../domain/customer-questions/service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUESTION_LEN = 4000;

function notFound(req, reply) {
  reply.code(404);
  return renderAdmin(req, reply, 'admin/customers/not-found', {
    title: 'Not found',
    activeNav: 'customers',
    mainWidth: 'content',
    sectionLabel: 'ADMIN · CUSTOMERS',
  });
}

export function registerAdminCustomerQuestionRoutes(app) {
  app.get('/admin/customers/:cid/questions/new', async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;

    const cid = req.params?.cid;
    if (typeof cid !== 'string' || !UUID_RE.test(cid)) return notFound(req, reply);
    const customer = await findCustomerById(app.db, cid);
    if (!customer) return notFound(req, reply);

    return renderAdmin(req, reply, 'admin/customer-questions/new', {
      title: 'Ask a question · ' + customer.razon_social,
      customer,
      csrfToken: await reply.generateCsrf(),
      activeNav: 'customers',
      mainWidth: 'content',
      sectionLabel: 'ADMIN · CUSTOMERS · ' + customer.razon_social.toUpperCase(),
      activeTab: 'detail',
    });
  });

  app.post('/admin/customers/:cid/questions', { preHandler: app.csrfProtection }, async (req, reply) => {
    const session = await requireAdminSession(app, req, reply);
    if (!session) return;

    const cid = req.params?.cid;
    if (typeof cid !== 'string' || !UUID_RE.test(cid)) return notFound(req, reply);
    const customer = await findCustomerById(app.db, cid);
    if (!customer) return notFound(req, reply);

    const question = String(req.body?.question ?? '').trim();
    if (!question || question.length > MAX_QUESTION_LEN) {
      reply.code(422);
      return renderAdmin(req, reply, 'admin/customer-questions/new', {
        title: 'Ask a question · ' + customer.razon_social,
        customer,
        csrfToken: await reply.generateCsrf(),
        error: !question
          ? 'Question text is required.'
          : `Question is too long (max ${MAX_QUESTION_LEN} characters).`,
        prefill: question,
        activeNav: 'customers',
        mainWidth: 'content',
        sectionLabel: 'ADMIN · CUSTOMERS · ' + customer.razon_social.toUpperCase(),
        activeTab: 'detail',
      });
    }

    await svc.createQuestion(app.db, {
      customerId: cid,
      createdByAdminId: session.user_id,
      question,
    }, { ip: req.ip, userAgentHash: null });

    return reply.redirect(`/admin/customers/${cid}`, 302);
  });
}
