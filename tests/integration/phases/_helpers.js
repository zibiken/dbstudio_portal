import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'kysely';
import * as customersService from '../../../domain/customers/service.js';
import * as adminsService from '../../../domain/admins/service.js';
import { pruneTaggedAuditRows } from '../../helpers/audit.js';

export function makeTag() {
  return `phasestest_${randomBytes(4).toString('hex')}`;
}

// customers.create + admins.create both require ctx.kek (32-byte Buffer)
// and ctx.portalBaseUrl (string). Without these the service throws at
// the top of create() — see domain/customers/service.js requireKek /
// requirePortalBaseUrl.
export function baseCtx(tag) {
  return {
    actorType: 'system',
    audit: { tag, reason: 'test' },
    ip: '127.0.0.1',
    userAgentHash: 'test',
    kek: randomBytes(32),
    portalBaseUrl: 'https://portal.test',
  };
}

export async function makeAdmin(db, tag, suffix = 'a') {
  const created = await adminsService.create(db, {
    email: `${tag}+${suffix}-admin@example.com`,
    name: `Admin ${suffix}`,
  }, baseCtx(tag));
  return created.id;
}

export async function makeCustomerAndProject(db, tag, suffix = 'a') {
  const customer = await customersService.create(db, {
    razonSocial: `${tag} ${suffix} S.L.`,
    primaryUser: { name: `User ${suffix}`, email: `${tag}+${suffix}-user@example.com` },
  }, baseCtx(tag));
  const projectId = uuidv7();
  await sql`
    INSERT INTO projects (id, customer_id, name, objeto_proyecto, status)
    VALUES (
      ${projectId}::uuid,
      ${customer.customerId}::uuid,
      ${'Test Project ' + suffix},
      ${'Phases test project'},
      'active'
    )
  `.execute(db);
  return { customerId: customer.customerId, primaryUserId: customer.primaryUserId, projectId };
}

export async function cleanupByTag(db, tag) {
  // Phase rows cascade via project deletion; clean projects + customers.
  await sql`DELETE FROM project_phases WHERE project_id IN (
    SELECT p.id FROM projects p JOIN customers c ON c.id = p.customer_id WHERE c.razon_social LIKE ${tag + '%'}
  )`.execute(db);
  await sql`DELETE FROM projects WHERE customer_id IN (SELECT id FROM customers WHERE razon_social LIKE ${tag + '%'})`.execute(db);
  await sql`DELETE FROM customer_users WHERE email LIKE ${tag + '%'}`.execute(db);
  await sql`DELETE FROM customers WHERE razon_social LIKE ${tag + '%'}`.execute(db);
  await sql`DELETE FROM admins WHERE email LIKE ${tag + '%'}`.execute(db);
  await sql`DELETE FROM email_outbox WHERE to_address LIKE ${tag + '%'}`.execute(db);
  await sql`DELETE FROM pending_digest_items WHERE metadata->>'tag' = ${tag}`.execute(db);
  await pruneTaggedAuditRows(db, sql`metadata->>'tag' = ${tag}`);
}
