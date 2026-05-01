import { sql } from 'kysely';
import { writeAudit } from '../../lib/audit.js';
import { recordForDigest } from '../../lib/digest.js';
import { titleFor } from '../../lib/digest-strings.js';
import { listActiveCustomerUsers, listActiveAdmins } from '../../lib/digest-fanout.js';
import * as repo from './repo.js';

function baseAudit(ctx) {
  return {
    metadata: { ...(ctx?.audit ?? {}) },
    ip: ctx?.ip ?? null,
    userAgentHash: ctx?.userAgentHash ?? null,
  };
}

// Phase D — Type C short-answer questionnaire. The repo enforces append-
// only via `WHERE status='open'` on the answer/skip UPDATEs; this service
// layer adds audits + digest fan-out on each transition.
//
// All three transitions emit visible_to_customer=true audits so customers
// see the question lifecycle in their own activity feed.

export async function createQuestion(db, { customerId, createdByAdminId, question }, ctx = {}) {
  return await db.transaction().execute(async (tx) => {
    const row = await repo.insert(tx, { customerId, createdByAdminId, question });
    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: createdByAdminId,
      action: 'question.created',
      targetType: 'customer_question',
      targetId: row.id,
      metadata: { ...a.metadata, customerId },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    // Customer-side Action-required digest fan-out.
    const recipients = await listActiveCustomerUsers(tx, customerId);
    const preview = String(question).slice(0, 80);
    for (const u of recipients) {
      const vars = { recipient: 'customer', questionPreview: preview };
      await recordForDigest(tx, {
        recipientType: 'customer_user',
        recipientId:   u.id,
        customerId,
        bucket:        'action_required',
        eventType:     'question.created',
        title:         titleFor('question.created', u.locale, vars),
        linkPath:      `/customer/questions/${row.id}`,
        metadata:      { questionId: row.id },
        vars,
        locale:        u.locale,
      });
    }
    return row;
  });
}

export async function answerQuestion(db, { id, answeredByCustomerUserId, answerText }, ctx = {}) {
  return await db.transaction().execute(async (tx) => {
    const row = await repo.answer(tx, { id, answeredByCustomerUserId, answerText });
    if (!row) return null;

    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'customer',
      actorId: answeredByCustomerUserId,
      action: 'question.answered',
      targetType: 'customer_question',
      targetId: id,
      metadata: { ...a.metadata, customerId: row.customer_id },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    const meta = await fetchQuestionMeta(tx, row.customer_id);
    await fanoutAdminFyi(tx, {
      eventType: 'question.answered',
      questionId: id,
      customerId: row.customer_id,
      customerName: meta.customerName,
      questionPreview: row.question,
    });
    return row;
  });
}

export async function skipQuestion(db, { id, answeredByCustomerUserId }, ctx = {}) {
  return await db.transaction().execute(async (tx) => {
    const row = await repo.skip(tx, { id, answeredByCustomerUserId });
    if (!row) return null;

    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'customer',
      actorId: answeredByCustomerUserId,
      action: 'question.skipped',
      targetType: 'customer_question',
      targetId: id,
      metadata: { ...a.metadata, customerId: row.customer_id },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    const meta = await fetchQuestionMeta(tx, row.customer_id);
    await fanoutAdminFyi(tx, {
      eventType: 'question.skipped',
      questionId: id,
      customerId: row.customer_id,
      customerName: meta.customerName,
      questionPreview: row.question,
    });
    return row;
  });
}

async function fetchQuestionMeta(tx, customerId) {
  const r = await sql`SELECT razon_social FROM customers WHERE id = ${customerId}::uuid`.execute(tx);
  return { customerName: r.rows[0]?.razon_social ?? '' };
}

async function fanoutAdminFyi(tx, { eventType, questionId, customerId, customerName, questionPreview }) {
  const admins = await listActiveAdmins(tx);
  for (const ad of admins) {
    const vars = { recipient: 'admin', customerName: customerName ?? '', questionPreview: questionPreview ?? '' };
    await recordForDigest(tx, {
      recipientType: 'admin',
      recipientId:   ad.id,
      customerId,
      bucket:        'fyi',
      eventType,
      title:         titleFor(eventType, ad.locale, vars),
      linkPath:      `/admin/customers/${customerId}/questions/${questionId}`,
      metadata:      { questionId },
      vars,
      locale:        ad.locale,
    });
  }
}
