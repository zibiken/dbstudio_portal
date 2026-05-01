import { v7 as uuidv7 } from 'uuid';
import { sql } from 'kysely';
import { writeAudit } from '../../lib/audit.js';
import { unwrapDek, encrypt } from '../../lib/crypto/envelope.js';
import * as repo from './repo.js';
import * as credentialsRepo from '../credentials/repo.js';
import { listActiveCustomerUsers, listActiveAdmins } from '../../lib/digest-fanout.js';
import { recordForDigest } from '../../lib/digest.js';
import { titleFor } from '../../lib/digest-strings.js';

const ALLOWED_FIELD_TYPES = new Set(['text', 'secret', 'url', 'note']);

export class CredentialRequestNotFoundError extends Error {
  constructor(id) {
    super(`credential_request ${id} not found`);
    this.name = 'CredentialRequestNotFoundError';
    this.code = 'CREDENTIAL_REQUEST_NOT_FOUND';
  }
}

export class CredentialRequestNotOpenError extends Error {
  constructor(status) {
    super(`credential_request is in status '${status}', expected 'open'`);
    this.name = 'CredentialRequestNotOpenError';
    this.code = 'CREDENTIAL_REQUEST_NOT_OPEN';
  }
}

export class CrossCustomerError extends Error {
  constructor() {
    super('cross-customer access refused');
    this.name = 'CrossCustomerError';
    this.code = 'CROSS_CUSTOMER';
  }
}

function requireKek(ctx, callerName) {
  const kek = ctx?.kek;
  if (!Buffer.isBuffer(kek) || kek.length !== 32) {
    throw new Error(`${callerName} requires ctx.kek (32-byte Buffer)`);
  }
  return kek;
}

function validateFieldsArray(fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error('fields must be a non-empty array of {name,label,type,required}');
  }
  const seenNames = new Set();
  const cleaned = [];
  for (const f of fields) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      throw new Error('field entries must be objects with {name,label,type,required}');
    }
    if (typeof f.name !== 'string' || f.name.trim() === '') {
      throw new Error('field.name must be a non-empty string');
    }
    if (typeof f.label !== 'string' || f.label.trim() === '') {
      throw new Error('field.label must be a non-empty string');
    }
    if (!ALLOWED_FIELD_TYPES.has(f.type)) {
      throw new Error(`field.type must be one of: ${[...ALLOWED_FIELD_TYPES].join(', ')}`);
    }
    if (typeof f.required !== 'boolean') {
      throw new Error('field.required must be a boolean');
    }
    const nm = f.name.trim();
    if (seenNames.has(nm)) {
      throw new Error(`duplicate field name '${nm}' — every field name must be unique within a request`);
    }
    seenNames.add(nm);
    cleaned.push({
      name: nm,
      label: f.label.trim(),
      type: f.type,
      required: f.required,
    });
  }
  return cleaned;
}

function validatePayloadAgainstFields(payload, fields) {
  if (
    payload === null
    || typeof payload !== 'object'
    || Array.isArray(payload)
  ) {
    throw new Error('payload must be a non-null, non-array object');
  }
  for (const f of fields) {
    if (f.required) {
      const v = payload[f.name];
      if (v === undefined || v === null || v === '') {
        throw new Error(`required field '${f.name}' is missing from payload`);
      }
    }
  }
}

async function loadCustomerActiveRow(db, customerId) {
  const r = await sql`
    SELECT id, status, dek_ciphertext, dek_iv, dek_tag
      FROM customers WHERE id = ${customerId}::uuid
  `.execute(db);
  if (r.rows.length === 0) throw new Error(`customer ${customerId} not found`);
  return r.rows[0];
}

async function assertCustomerUserBelongsTo(db, customerUserId, customerId) {
  const r = await sql`
    SELECT 1 FROM customer_users
     WHERE id = ${customerUserId}::uuid AND customer_id = ${customerId}::uuid
  `.execute(db);
  if (r.rows.length === 0) throw new CrossCustomerError();
}

function baseAudit(ctx) {
  return {
    metadata: { ...(ctx?.audit ?? {}) },
    ip: ctx?.ip ?? null,
    userAgentHash: ctx?.userAgentHash ?? null,
  };
}

export async function createByAdmin(db, {
  adminId,
  customerId,
  provider,
  fields,
}, ctx = {}) {
  if (typeof provider !== 'string' || provider.trim() === '') {
    throw new Error('provider is required and must be a non-empty string');
  }
  const cleaned = validateFieldsArray(fields);
  const providerTrimmed = provider.trim();

  return await db.transaction().execute(async (tx) => {
    const customer = await loadCustomerActiveRow(tx, customerId);
    if (customer.status !== 'active') {
      throw new Error(
        `cannot create credential_request for customer in status '${customer.status}' — must be 'active'`,
      );
    }

    const id = uuidv7();
    await repo.insertCredentialRequest(tx, {
      id,
      customerId,
      requestedByAdminId: adminId,
      provider: providerTrimmed,
      fields: cleaned,
    });

    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: adminId,
      action: 'credential_request.created',
      targetType: 'credential_request',
      targetId: id,
      metadata: {
        ...a.metadata,
        customerId,
        provider: providerTrimmed,
        fieldCount: cleaned.length,
      },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    // Phase B: customer-FYI → no, this is action_required (the customer
    // must fulfil the request).
    const recipients = await listActiveCustomerUsers(tx, customerId);
    for (const u of recipients) {
      await recordForDigest(tx, {
        recipientType: 'customer_user',
        recipientId:   u.id,
        customerId,
        bucket:        'action_required',
        eventType:     'credential_request.created',
        title:         titleFor('credential_request.created', u.locale, { provider: providerTrimmed }),
        linkPath:      `/customer/credential-requests/${id}`,
        metadata:      { requestId: id, provider: providerTrimmed },
      });
    }

    return { requestId: id };
  });
}

export async function fulfilByCustomer(db, {
  customerUserId,
  requestId,
  payload,
  label,
}, ctx = {}) {
  const kek = requireKek(ctx, 'credentialRequests.fulfilByCustomer');
  if (typeof label !== 'string' || label.trim() === '') {
    throw new Error('label is required and must be a non-empty string');
  }
  const labelTrimmed = label.trim();

  return await db.transaction().execute(async (tx) => {
    const reqRow = await repo.lockCredentialRequestById(tx, requestId);
    if (!reqRow) throw new CredentialRequestNotFoundError(requestId);
    if (reqRow.status !== 'open') throw new CredentialRequestNotOpenError(reqRow.status);

    await assertCustomerUserBelongsTo(tx, customerUserId, reqRow.customer_id);
    validatePayloadAgainstFields(payload, reqRow.fields);

    const customer = await loadCustomerActiveRow(tx, reqRow.customer_id);
    if (customer.status !== 'active') {
      throw new Error(
        `cannot fulfil credential_request for customer in status '${customer.status}' — must be 'active'`,
      );
    }

    const dek = unwrapDek({
      ciphertext: customer.dek_ciphertext,
      iv: customer.dek_iv,
      tag: customer.dek_tag,
    }, kek);
    const env = encrypt(Buffer.from(JSON.stringify(payload), 'utf8'), dek);

    const credentialId = uuidv7();
    await credentialsRepo.insertCredential(tx, {
      id: credentialId,
      customerId: reqRow.customer_id,
      provider: reqRow.provider,
      label: labelTrimmed,
      payloadCiphertext: env.ciphertext,
      payloadIv: env.iv,
      payloadTag: env.tag,
      createdBy: 'customer',
    });
    await repo.setStatusFulfilled(tx, requestId, credentialId);

    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'customer',
      actorId: customerUserId,
      action: 'credential.created',
      targetType: 'credential',
      targetId: credentialId,
      metadata: {
        ...a.metadata,
        customerId: reqRow.customer_id,
        provider: reqRow.provider,
        label: labelTrimmed,
        createdBy: 'customer',
        requestId,
      },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });
    await writeAudit(tx, {
      actorType: 'customer',
      actorId: customerUserId,
      action: 'credential_request.fulfilled',
      targetType: 'credential_request',
      targetId: requestId,
      metadata: {
        ...a.metadata,
        customerId: reqRow.customer_id,
        provider: reqRow.provider,
        credentialId,
      },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    // Phase B: admin FYI fan-out — admins want to know when a customer
    // satisfied a credential ask.
    const customerName = customer.razon_social ?? '';
    const admins = await listActiveAdmins(tx);
    for (const adm of admins) {
      await recordForDigest(tx, {
        recipientType: 'admin',
        recipientId:   adm.id,
        customerId:    reqRow.customer_id,
        bucket:        'fyi',
        eventType:     'credential_request.fulfilled',
        title:         titleFor('credential_request.fulfilled', adm.locale, { customerName, provider: reqRow.provider }),
        linkPath:      `/admin/customers/${reqRow.customer_id}/credential-requests/${requestId}`,
        metadata:      { requestId, provider: reqRow.provider, customerId: reqRow.customer_id },
      });
    }

    return { requestId, credentialId };
  });
}

export async function markNotApplicableByCustomer(db, {
  customerUserId,
  requestId,
  reason,
}, ctx = {}) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error('reason is required when marking a request not_applicable');
  }
  const reasonTrimmed = reason.trim();

  return await db.transaction().execute(async (tx) => {
    const reqRow = await repo.lockCredentialRequestById(tx, requestId);
    if (!reqRow) throw new CredentialRequestNotFoundError(requestId);
    if (reqRow.status !== 'open') throw new CredentialRequestNotOpenError(reqRow.status);

    await assertCustomerUserBelongsTo(tx, customerUserId, reqRow.customer_id);
    await repo.setStatusNotApplicable(tx, requestId, reasonTrimmed);

    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'customer',
      actorId: customerUserId,
      action: 'credential_request.marked_not_applicable',
      targetType: 'credential_request',
      targetId: requestId,
      metadata: {
        ...a.metadata,
        customerId: reqRow.customer_id,
        provider: reqRow.provider,
        reason: reasonTrimmed,
      },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    // Phase B: admin FYI — request resolved as not-applicable.
    const customerNameRow = await sql`
      SELECT razon_social FROM customers WHERE id = ${reqRow.customer_id}::uuid
    `.execute(tx);
    const customerName = customerNameRow.rows[0]?.razon_social ?? '';
    const admins = await listActiveAdmins(tx);
    for (const adm of admins) {
      await recordForDigest(tx, {
        recipientType: 'admin',
        recipientId:   adm.id,
        customerId:    reqRow.customer_id,
        bucket:        'fyi',
        eventType:     'credential_request.not_applicable',
        title:         titleFor('credential_request.not_applicable', adm.locale, { customerName, provider: reqRow.provider }),
        linkPath:      `/admin/customers/${reqRow.customer_id}/credential-requests/${requestId}`,
        metadata:      { requestId, provider: reqRow.provider, customerId: reqRow.customer_id },
      });
    }

    return { requestId };
  });
}

export async function cancelByAdmin(db, { adminId, requestId }, ctx = {}) {
  return await db.transaction().execute(async (tx) => {
    const reqRow = await repo.lockCredentialRequestById(tx, requestId);
    if (!reqRow) throw new CredentialRequestNotFoundError(requestId);
    if (reqRow.status !== 'open') throw new CredentialRequestNotOpenError(reqRow.status);

    await repo.setStatusCancelled(tx, requestId);

    const a = baseAudit(ctx);
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: adminId,
      action: 'credential_request.cancelled',
      targetType: 'credential_request',
      targetId: requestId,
      metadata: {
        ...a.metadata,
        customerId: reqRow.customer_id,
        provider: reqRow.provider,
      },
      visibleToCustomer: true,
      ip: a.ip,
      userAgentHash: a.userAgentHash,
    });

    return { requestId };
  });
}
